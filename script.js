// This file is a module (see <script type="module"> in index.html), which is
// what lets it import Firebase straight from Google's CDN without a build step
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword,
  EmailAuthProvider, reauthenticateWithCredential, updatePassword,
  onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  getFirestore, collection, doc, addDoc, setDoc, getDoc, getDocs, updateDoc, deleteDoc,
  query, where, orderBy, onSnapshot, serverTimestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// The signed-in user. userId is the account's Firebase ID, which is the same
// on every device you sign in on with the same name, so your drafts follow you around.
let userName = "";
let userId = "";
// Largest file we'll try to open at all
const MAX_IMAGE_FILE_BYTES = 25 * 1024 * 1024;
// Saved image must fit under the 700000 character limit in firestore.rules
const MAX_IMAGE_DATA_URL_LENGTH = 650000;
// Longest side of an image after it's shrunk
const MAX_IMAGE_DIMENSION = 1600;

// Functions that stop the live database listeners, so we can turn them all
// off when someone signs out
let unsubscribers = [];

function switchPage(pageId) {
  // 1. Find the page that is currently visible and hide it
  const currentPage = document.querySelector(".page.active");
  if (currentPage) {
    currentPage.classList.remove("active");
  }

  // 2. Find the target page by ID and make it visible
  const targetPage = document.getElementById(pageId);
  if (targetPage) {
    targetPage.classList.add("active");
  }
}

// Functions in a module aren't global, so onclick="switchPage(...)" can't see
// switchPage. Instead each nav button names its page in a data-page attribute.
document.querySelectorAll("nav button[data-page]").forEach((button) => {
  button.addEventListener("click", () => {
    // Leaving a book's page: take "#book/..." off the address so it doesn't reopen
    if (bookIdFromHash()) {
      history.pushState(null, "", location.pathname + location.search);
    }
    closeBookPage();
    switchPage(button.dataset.page);
  });
});

// Runs a database action and tells the user if it fails
// (for example no internet, or the security rules said no)
async function tryTo(description, action) {
  try {
    await action();
  } catch (error) {
    console.error(error);
    alert(`Couldn't ${description}: ${error.message}`);
  }
}

// ---------- Sign in ----------
// You sign in with your name and your own password. Behind the scenes each
// name gets its own Firebase account (the name is turned into a made-up email
// address), so the database rules can tell who's who: only you can read your
// drafts or delete your posts.

const signInOverlay = document.getElementById("sign-in-overlay");
const nameInput = document.getElementById("name-input");
const passwordInput = document.getElementById("password-input");
const signInButton = document.getElementById("sign-in");
const signOutButton = document.getElementById("sign-out");
const greeting = document.getElementById("greeting");
const changePasswordToggle = document.getElementById("change-password-toggle");
const passwordPanel = document.getElementById("password-panel");
const currentPasswordInput = document.getElementById("current-password");
const newPasswordInput = document.getElementById("new-password");
const confirmPasswordInput = document.getElementById("confirm-password");
const savePasswordButton = document.getElementById("save-password");
const cancelPasswordButton = document.getElementById("cancel-password");
const passwordError = document.getElementById("password-error");

// True while the sign-in button is working, so onAuthStateChanged (below)
// doesn't check membership before we've had a chance to save it
let signingIn = false;

// Turns a name into the made-up email for its account. Lowercase so "Lukas"
// and "lukas" are the same person, and keep it readable so admins can
// pre-create accounts like "lukas@sharemythoughts.example".
// No emails are ever sent to it.
function nameToEmail(name) {
  const normalized = name
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");

  const localPart = normalized
    .replace(/[^a-z0-9._-]+/g, ".")
    .replace(/\.+/g, ".")
    .replace(/^\.|\.$/g, "");

  if (localPart === "") {
    throw new Error("Please use a name with letters or numbers.");
  }

  return `${localPart}@sharemythoughts.example`;
}

// Signs in to a pre-created account for this name.
// Account creation is intentionally disabled in the client.
async function signInWithName(name, password) {
  const email = nameToEmail(name);
  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (error) {
    if (error.code === "auth/user-not-found") {
      throw new Error("This name is not approved yet. Ask the admin to add your account.");
    }
    if (error.code === "auth/wrong-password" || error.code === "auth/invalid-credential") {
      throw new Error("Wrong password.");
    }
    throw error;
  }

  // Save your display name so posts and comments can show it.
  try {
    await setDoc(doc(db, "members", auth.currentUser.uid), {
      name: name
    });
  } catch (error) {
    await signOut(auth);
    throw new Error("Could not finish sign-in permissions setup.");
  }
}

function signIn() {
  if (!nameInput || !passwordInput || !signInButton) {
    return;
  }

  const name = nameInput.value.trim();
  const password = passwordInput.value;
  if (name === "" || password === "") {
    alert("Please enter your name and password.");
    return;
  }
  if (name.length > 30) {
    alert("Please use a name of 30 characters or less.");
    return;
  }

  signingIn = true;
  signInButton.disabled = true;
  tryTo("sign in", async () => {
    await signInWithName(name, password);
    passwordInput.value = "";
    showSignedIn(auth.currentUser, name);
  }).finally(() => {
    signingIn = false;
    signInButton.disabled = false;
  });
}

if (signInButton) {
  signInButton.addEventListener("click", signIn);
}

if (passwordInput) {
  passwordInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      signIn();
    }
  });
}

if (signOutButton) {
  signOutButton.addEventListener("click", () => {
    tryTo("sign out", () => signOut(auth));
  });
}

function setPasswordError(message) {
  if (!passwordError) {
    return;
  }
  passwordError.textContent = message;
  passwordError.hidden = message === "";
}

function closePasswordPanel() {
  if (passwordPanel) {
    passwordPanel.hidden = true;
  }
  if (currentPasswordInput) {
    currentPasswordInput.value = "";
  }
  if (newPasswordInput) {
    newPasswordInput.value = "";
  }
  if (confirmPasswordInput) {
    confirmPasswordInput.value = "";
  }
  setPasswordError("");
}

if (changePasswordToggle && passwordPanel) {
  changePasswordToggle.addEventListener("click", () => {
    passwordPanel.hidden = !passwordPanel.hidden;
    setPasswordError("");
    if (!passwordPanel.hidden && currentPasswordInput) {
      currentPasswordInput.focus();
    }
  });
}

if (cancelPasswordButton) {
  cancelPasswordButton.addEventListener("click", closePasswordPanel);
}

if (savePasswordButton) {
  savePasswordButton.addEventListener("click", () => {
    tryTo("change password", async () => {
      if (!auth.currentUser || !auth.currentUser.email) {
        throw new Error("You need to be signed in to change your password.");
      }
      if (!currentPasswordInput || !newPasswordInput || !confirmPasswordInput) {
        throw new Error("Password form is not available.");
      }

      setPasswordError("");
      const currentPassword = currentPasswordInput.value;
      const newPassword = newPasswordInput.value;
      const confirmPassword = confirmPasswordInput.value;

      if (newPassword === "") {
        setPasswordError("Please enter a new password.");
        return;
      }
      if (newPassword !== confirmPassword) {
        setPasswordError("The new passwords do not match.");
        return;
      }

      try {
        const credential = EmailAuthProvider.credential(auth.currentUser.email, currentPassword);
        await reauthenticateWithCredential(auth.currentUser, credential);
        await updatePassword(auth.currentUser, newPassword);
      } catch (error) {
        if (error.code === "auth/wrong-password" || error.code === "auth/invalid-credential") {
          setPasswordError("Your current password is wrong.");
          return;
        }
        if (error.code === "auth/weak-password") {
          setPasswordError("New password must be at least 6 characters.");
          return;
        }
        throw error;
      }

      closePasswordPanel();
      alert("Password updated.");
    });
  });
}

// ---------- Posts and comments ----------

// Shows a Firestore timestamp as e.g. "Oct 19, 2026, 3:45 PM"
function formatTime(timestamp) {
  const date = timestamp ? timestamp.toDate() : new Date();
  return date.toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short"
  });
}

// Builds the "Name · date, time" line shown above a post or comment.
function createMeta(name, createdAt) {
  const meta = document.createElement("div");
  meta.className = "meta";
  updateMeta(meta, name, createdAt);
  return meta;
}

function updateMeta(meta, name, createdAt) {
  meta.textContent = `${name} · ${formatTime(createdAt)}`;
}

function newPost(title, text, imageDataUrl = "") {
  return {
    userId: userId,
    name: userName,
    title: title,
    text: text,
    imageDataUrl: imageDataUrl,
    createdAt: serverTimestamp()
  };
}

function newComment(text) {
  return {
    userId: userId,
    name: userName,
    text: text,
    createdAt: serverTimestamp()
  };
}

// Right after create, serverTimestamp may not be written yet.
function readData(snapshot) {
  return snapshot.data({ serverTimestamps: "estimate" });
}

// multiline: edit in a big text box (for book notes) instead of a one-line input
function createCommentItem(commentDoc, multiline = false) {
  const data = readData(commentDoc);
  let latestText = data.text;
  const commentItem = document.createElement("div");
  commentItem.className = "comment-item";

  // The comment as everyone sees it. Hidden while you're editing it.
  const view = document.createElement("div");
  const meta = createMeta(data.name, data.createdAt);
  const text = document.createElement("p");
  text.textContent = data.text;
  view.appendChild(meta);
  view.appendChild(text);
  commentItem.appendChild(view);

  if (data.userId === userId) {
    const editor = document.createElement("div");
    editor.hidden = true;

    const editInput = document.createElement(multiline ? "textarea" : "input");
    if (multiline) {
      editInput.rows = 4;
      editInput.maxLength = 2000;
      editor.className = "composer";
    } else {
      editInput.type = "text";
    }
    const saveButton = document.createElement("button");
    saveButton.textContent = "Save";
    const cancelButton = document.createElement("button");
    cancelButton.textContent = "Cancel";

    editor.appendChild(editInput);
    const editButtons = document.createElement("div");
    editButtons.appendChild(saveButton);
    editButtons.appendChild(cancelButton);
    editor.appendChild(editButtons);
    commentItem.appendChild(editor);

    function closeEditor() {
      editor.hidden = true;
      view.hidden = false;
    }

    function save() {
      const newText = editInput.value.trim();
      if (newText === "") {
        alert("Please write something before saving.");
        return;
      }
      saveButton.disabled = true;
      tryTo("save the comment", async () => {
        await updateDoc(commentDoc.ref, { text: newText });
        closeEditor();
      }).finally(() => {
        saveButton.disabled = false;
      });
    }

    saveButton.addEventListener("click", save);
    cancelButton.addEventListener("click", closeEditor);
    editInput.addEventListener("keydown", (event) => {
      // In a big text box Enter makes a new line, so only one-line edits save on Enter
      if (event.key === "Enter" && !multiline) {
        save();
      } else if (event.key === "Escape") {
        closeEditor();
      }
    });

    const editButton = document.createElement("button");
    editButton.textContent = "Edit";
    editButton.addEventListener("click", () => {
      editInput.value = latestText;
      view.hidden = true;
      editor.hidden = false;
      editInput.focus();
    });
    view.appendChild(editButton);

    const deleteButton = document.createElement("button");
    deleteButton.textContent = "Delete";
    deleteButton.addEventListener("click", () => {
      const kind = multiline ? "note" : "comment";
      if (confirm(`Delete this ${kind}?`)) {
        tryTo(`delete the ${kind}`, () => deleteDoc(commentDoc.ref));
      }
    });
    view.appendChild(deleteButton);
  }

  return {
    element: commentItem,
    update: (newDoc) => {
      const newData = readData(newDoc);
      latestText = newData.text;
      updateMeta(meta, newData.name, newData.createdAt);
      text.textContent = newData.text;
    }
  };
}

// Comments under a post. Book pages reuse this for their notes by passing
// options (see showBookPage).
function createCommentSection(postRef, options = {}) {
  const {
    collectionName = "comments",
    className = "comments",
    placeholder = "Write a comment",
    buttonText = "Comment",
    emptyMessage = "Please enter a comment before submitting.",
    failureDescription = "post your comment",
    multiline = false
  } = options;
  const commentsRef = collection(postRef, collectionName);

  const section = document.createElement("div");
  section.className = className;

  const commentsList = document.createElement("div");
  commentsList.className = "comments-list";

  const commentInput = document.createElement(multiline ? "textarea" : "input");
  if (multiline) {
    commentInput.rows = 4;
    commentInput.maxLength = 2000;
  } else {
    commentInput.type = "text";
  }
  commentInput.placeholder = placeholder;

  const commentButton = document.createElement("button");
  commentButton.textContent = buttonText;

  commentButton.addEventListener("click", () => {
    const comment = commentInput.value.trim();
    if (comment === "") {
      alert(emptyMessage);
    } else {
      tryTo(failureDescription, async () => {
        await addDoc(commentsRef, newComment(comment));
        commentInput.value = "";
      });
    }
  });

  // Update comments one by one (instead of rebuilding the list) so a comment
  // you're editing isn't wiped out when someone else adds one
  const items = new Map();
  const stopComments = onSnapshot(query(commentsRef, orderBy("createdAt")), (snapshot) => {
    snapshot.docChanges().forEach((change) => {
      const id = change.doc.id;
      const existing = items.get(id);

      if (change.type === "removed") {
        if (existing) {
          existing.element.remove();
        }
        items.delete(id);
        return;
      }

      if (change.type === "added") {
        items.set(id, createCommentItem(change.doc, multiline));
      } else if (existing) {
        existing.element.remove();
        existing.update(change.doc);
      }

      const nextItem = commentsList.children[change.newIndex] || null;
      commentsList.insertBefore(items.get(id).element, nextItem);
    });
  });

  section.appendChild(commentsList);
  if (multiline) {
    // Text box with the button underneath it, like the other writing boxes
    const composer = document.createElement("div");
    composer.className = "composer";
    const buttons = document.createElement("div");
    buttons.appendChild(commentButton);
    composer.appendChild(commentInput);
    composer.appendChild(buttons);
    section.appendChild(composer);
  } else {
    section.appendChild(commentInput);
    section.appendChild(commentButton);
  }
  return { element: section, stopComments: stopComments };
}

// Box that lets you edit your post right where it is, instead of in the
// writing box at the top. onClose runs after you save or cancel.
function createPostEditor(section, postRef, onClose) {
  const editor = document.createElement("div");
  editor.className = "composer";
  editor.hidden = true;

  const titleInput = document.createElement("input");
  titleInput.type = "text";
  titleInput.placeholder = "Title (optional)";
  titleInput.maxLength = 150;

  const textInput = document.createElement("textarea");
  textInput.rows = 5;
  textInput.maxLength = 2000;

  editor.appendChild(titleInput);
  editor.appendChild(textInput);

  // Only sections that take images (memories) get an image picker
  let imageInput = null;
  if (section.imageInput) {
    imageInput = document.createElement("input");
    imageInput.type = "file";
    imageInput.accept = "image/*";
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "Choose an image to replace the current one, or leave this empty to keep it.";
    editor.appendChild(imageInput);
    editor.appendChild(hint);
  }

  const saveButton = document.createElement("button");
  saveButton.textContent = "Save changes";
  const cancelButton = document.createElement("button");
  cancelButton.textContent = "Cancel";
  const buttons = document.createElement("div");
  buttons.appendChild(saveButton);
  buttons.appendChild(cancelButton);
  editor.appendChild(buttons);

  let currentImageDataUrl = "";

  function close() {
    editor.hidden = true;
    onClose();
  }

  cancelButton.addEventListener("click", close);

  saveButton.addEventListener("click", () => {
    const text = textInput.value.trim();
    if (text === "") {
      alert(section.emptyMessage);
      return;
    }
    if (!confirm("Save changes to this post? Everyone will see the new version.")) {
      return;
    }
    saveButton.disabled = true;
    tryTo("save the changes", async () => {
      const imageDataUrl = await readOptionalImageDataUrl(imageInput, currentImageDataUrl);
      await updateDoc(postRef, {
        title: titleInput.value.trim(),
        text: text,
        imageDataUrl: imageDataUrl
      });
      close();
    }).finally(() => {
      saveButton.disabled = false;
    });
  });

  return {
    element: editor,
    open: (postData) => {
      titleInput.value = postData.title || "";
      textInput.value = postData.text;
      currentImageDataUrl = postData.imageDataUrl || "";
      if (imageInput) {
        imageInput.value = "";
      }
      editor.hidden = false;
      textInput.focus();
    }
  };
}

function createPostItem(section, postDoc) {
  const data = readData(postDoc);
  // Latest version of the post, so Edit always opens what's currently saved
  let latestDoc = postDoc;
  const postItem = document.createElement("div");
  postItem.className = "thought-item";

  // The post as everyone sees it. Hidden while you're editing it.
  const view = document.createElement("div");

  const title = document.createElement("h3");
  const meta = createMeta(data.name, data.createdAt);
  const image = document.createElement("img");
  image.className = "post-image";
  image.alt = "Memory image";
  const text = document.createElement("p");

  function showContent(postData) {
    title.textContent = postData.title || "";
    title.hidden = !postData.title;
    if (postData.imageDataUrl) {
      image.src = postData.imageDataUrl;
    } else {
      image.removeAttribute("src");
    }
    // style.css gives .post-image display: block, which would override the hidden attribute
    image.style.display = postData.imageDataUrl ? "" : "none";
    text.textContent = postData.text;
  }
  showContent(data);

  view.appendChild(title);
  view.appendChild(meta);
  view.appendChild(image);
  view.appendChild(text);
  postItem.appendChild(view);

  if (data.userId === userId) {
    const editor = createPostEditor(section, postDoc.ref, () => {
      view.hidden = false;
    });
    postItem.appendChild(editor.element);

    const editButton = document.createElement("button");
    editButton.textContent = "Edit";
    editButton.addEventListener("click", () => {
      view.hidden = true;
      editor.open(readData(latestDoc));
    });
    view.appendChild(editButton);

    const deleteButton = document.createElement("button");
    deleteButton.textContent = "Delete";
    deleteButton.addEventListener("click", () => {
      if (confirm("Delete this post?")) {
        tryTo("delete the post", () => deleteDoc(postDoc.ref));
      }
    });
    view.appendChild(deleteButton);
  }

  const comments = createCommentSection(postDoc.ref);
  postItem.appendChild(comments.element);

  return {
    element: postItem,
    stopComments: comments.stopComments,
    update: (newDoc) => {
      latestDoc = newDoc;
      const newData = readData(newDoc);
      updateMeta(meta, newData.name, newData.createdAt);
      showContent(newData);
    }
  };
}

function listenToPosts(section) {
  const items = new Map();
  const postsQuery = query(collection(db, section.collection), orderBy("createdAt"));

  const stopPosts = onSnapshot(postsQuery, (snapshot) => {
    snapshot.docChanges().forEach((change) => {
      const id = change.doc.id;

      if (change.type === "removed" || change.type === "modified") {
        const existing = items.get(id);
        if (existing) {
          existing.element.remove();
        }
      }
      if (change.type === "removed") {
        const existing = items.get(id);
        if (existing) {
          existing.stopComments();
        }
        items.delete(id);
        return;
      }

      if (change.type === "added") {
        items.set(id, createPostItem(section, change.doc));
      } else {
        const existing = items.get(id);
        if (existing) {
          existing.update(change.doc);
        }
      }

      const nextItem = section.list.children[change.newIndex] || null;
      section.list.insertBefore(items.get(id).element, nextItem);
    });
    updatePostsHeading(section);
  });

  return () => {
    stopPosts();
    items.forEach((item) => item.stopComments());
  };
}

// ---------- Drafts ----------

function draftsCollection() {
  return collection(db, "users", userId, "drafts");
}

async function publishDraft(section, draftRef, title, text, imageDataUrl = "") {
  const batch = writeBatch(db);
  batch.set(doc(collection(db, section.collection)), newPost(title, text, imageDataUrl));
  batch.delete(draftRef);
  await batch.commit();
}

function createDraftItem(section, draftDoc) {
  const data = readData(draftDoc);
  const draftItem = document.createElement("div");
  draftItem.className = "draft-item";

  if (data.title) {
    const title = document.createElement("h4");
    title.textContent = data.title;
    draftItem.appendChild(title);
  }

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = `Last saved ${formatTime(data.updatedAt)}`;

  const text = document.createElement("p");
  text.textContent = data.text;

  draftItem.appendChild(meta);
  if (data.imageDataUrl) {
    const image = document.createElement("img");
    image.className = "draft-image";
    image.src = data.imageDataUrl;
    image.alt = "Draft memory image";
    draftItem.appendChild(image);
  }
  draftItem.appendChild(text);

  if (section.editingRef && section.editingRef.id === draftDoc.id) {
    draftItem.classList.add("editing");
    const note = document.createElement("p");
    note.className = "hint";
    note.textContent = "Open in the box above.";
    draftItem.appendChild(note);
    return draftItem;
  }

  const publishButton = document.createElement("button");
  publishButton.textContent = "Post";
  publishButton.addEventListener("click", () => {
    if (confirm("Post this draft? Everyone will be able to see it.")) {
      tryTo("post the draft", () =>
        publishDraft(section, draftDoc.ref, data.title || "", data.text, data.imageDataUrl || ""));
    }
  });

  const editButton = document.createElement("button");
  editButton.textContent = "Edit";
  editButton.addEventListener("click", () => {
    openDraft(section, draftDoc);
  });

  const deleteButton = document.createElement("button");
  deleteButton.textContent = "Delete";
  deleteButton.addEventListener("click", () => {
    if (confirm("Delete this draft?")) {
      tryTo("delete the draft", () => deleteDoc(draftDoc.ref));
    }
  });

  draftItem.appendChild(publishButton);
  draftItem.appendChild(editButton);
  draftItem.appendChild(deleteButton);
  return draftItem;
}

function renderDrafts(section) {
  if (!section.draftsList) {
    return;
  }

  section.draftsList.replaceChildren(
    ...section.drafts.map((draftDoc) => createDraftItem(section, draftDoc))
  );

  if (section.drafts.length > 0) {
    const heading = document.createElement("h3");
    heading.textContent = `Your drafts (only you can see these, currently ${section.drafts.length})`;
    section.draftsList.prepend(heading);
  }
}

// Only show the "Posts" heading when there's at least one post
function updatePostsHeading(section) {
  if (section.postsHeading) {
    section.postsHeading.hidden = !section.list || section.list.children.length === 0;
  }
}

function listenToDrafts(section) {
  const draftsQuery = query(draftsCollection(), where("section", "==", section.collection));

  return onSnapshot(draftsQuery, (snapshot) => {
    section.drafts = snapshot.docs.sort((a, b) =>
      readData(b).updatedAt.toMillis() - readData(a).updatedAt.toMillis()
    );
    renderDrafts(section);
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not read the selected image."));
    reader.readAsDataURL(file);
  });
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read the selected image."));
    };
    image.src = url;
  });
}

// Scales the image down and saves it as a JPEG, lowering the quality and then
// the size until it's small enough to store
async function shrinkImageToDataUrl(file) {
  const image = await loadImage(file);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  let scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(image.width, image.height));

  while (scale * Math.max(image.width, image.height) >= 200) {
    canvas.width = Math.round(image.width * scale);
    canvas.height = Math.round(image.height * scale);
    // White background so transparent parts don't turn black in the JPEG
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    for (const quality of [0.85, 0.7, 0.55]) {
      const dataUrl = canvas.toDataURL("image/jpeg", quality);
      if (dataUrl.length <= MAX_IMAGE_DATA_URL_LENGTH) {
        return dataUrl;
      }
    }
    scale *= 0.75;
  }

  throw new Error("Could not make this image small enough. Please try a different one.");
}

// Reads the image chosen in imageInput, or keeps currentDataUrl if none was chosen
async function readOptionalImageDataUrl(imageInput, currentDataUrl = "") {
  if (!imageInput) {
    return "";
  }

  const file = imageInput.files && imageInput.files[0];
  if (!file) {
    return currentDataUrl;
  }

  if (!file.type.startsWith("image/")) {
    throw new Error("Please choose an image file.");
  }
  if (file.size > MAX_IMAGE_FILE_BYTES) {
    throw new Error("Image is too large. Please use an image up to 25 MB.");
  }

  // Keep small images as they are (so GIFs stay animated), shrink the rest
  const original = await readFileAsDataUrl(file);
  if (original.length <= MAX_IMAGE_DATA_URL_LENGTH) {
    return original;
  }
  return await shrinkImageToDataUrl(file);
}

// ---------- Writing box ----------

// Shows the "Editing a saved draft" note when mode is "draft", hides it when "new"
function setComposerMode(section, mode) {
  if (section.editingNote) {
    section.editingNote.hidden = mode === "new";
  }
}

// Puts a draft into the box, after checking it won't throw away unsaved text
function loadIntoComposer(section, data, kind) {
  if (!section.input || !section.titleInput) {
    return false;
  }

  const hasUnsavedText =
    section.input.value.trim() !== "" || section.titleInput.value.trim() !== "";
  if (hasUnsavedText && !confirm(`Replace what's in the box with this ${kind}? Unsaved text will be lost.`)) {
    return false;
  }

  section.titleInput.value = data.title || "";
  section.input.value = data.text;
  section.editingImageDataUrl = data.imageDataUrl || "";
  if (section.imageInput) {
    section.imageInput.value = "";
  }
  return true;
}

function openDraft(section, draftDoc) {
  if (!loadIntoComposer(section, draftDoc.data(), "draft")) {
    return;
  }
  section.editingRef = draftDoc.ref;
  setComposerMode(section, "draft");
  renderDrafts(section);
  section.input.focus();
}

function clearComposer(section) {
  if (section.titleInput) {
    section.titleInput.value = "";
  }
  if (section.input) {
    section.input.value = "";
  }
  section.editingRef = null;
  section.editingImageDataUrl = "";
  if (section.imageInput) {
    section.imageInput.value = "";
  }
  setComposerMode(section, "new");
  renderDrafts(section);
}

// ---------- Sections ----------

const sections = [
  {
    collection: "thoughts",
    prefix: "thought",
    emptyMessage: "Please write a thought first."
  },
  {
    collection: "accomplishments",
    prefix: "accomplishment",
    emptyMessage: "Please write an accomplishment first."
  },
  {
    collection: "goals",
    prefix: "goal",
    emptyMessage: "Please write a goal first."
  },
  {
    collection: "memories",
    prefix: "memory",
    emptyMessage: "Please share a memory first."
  },
  {
    collection: "group-activities",
    prefix: "activity",
    emptyMessage: "Please share an activity idea first."
  }
];

function setupPostSection(section) {
  const prefix = section.prefix;
  section.titleInput = document.getElementById(`${prefix}-title`);
  section.input = document.getElementById(`${prefix}-input`);
  section.imageInput = document.getElementById(`${prefix}-image`);
  section.editingNote = document.getElementById(`${prefix}-editing`);
  section.draftsList = document.getElementById(`${prefix}-drafts`);
  section.list = document.getElementById(`${section.collection}-list`);
  section.postsHeading = document.getElementById(`${section.collection}-heading`);
  const submitButton = document.getElementById(`${prefix}-submit`);
  const saveDraftButton = document.getElementById(`${prefix}-save-draft`);
  const stopEditingButton = document.getElementById(`${prefix}-stop-editing`);
  section.drafts = [];
  section.editingRef = null;
  section.editingImageDataUrl = "";

  if (!section.titleInput || !section.input || !submitButton || !section.list) {
    console.warn(`Skipping setup for section \"${section.collection}\" because required elements are missing.`);
    section.disabled = true;
    return;
  }

  section.disabled = false;

  async function readInput() {
    const text = section.input.value.trim();
    if (text === "") {
      alert(section.emptyMessage);
      return null;
    }
    const imageDataUrl = await readOptionalImageDataUrl(section.imageInput, section.editingImageDataUrl);
    return { title: section.titleInput.value.trim(), text: text, imageDataUrl: imageDataUrl };
  }

  submitButton.addEventListener("click", () => {
    tryTo("post", async () => {
      const input = await readInput();
      if (input === null || !confirm("Post this? Everyone will be able to see it.")) {
        return;
      }
        if (section.editingRef) {
          await publishDraft(section, section.editingRef, input.title, input.text, input.imageDataUrl);
        } else {
          await addDoc(
            collection(db, section.collection),
            newPost(input.title, input.text, input.imageDataUrl)
          );
        }
        clearComposer(section);
      });
  });

  if (saveDraftButton) {
    saveDraftButton.addEventListener("click", () => {
      tryTo("save the draft", async () => {
        const input = await readInput();
        if (input === null) {
          return;
        }
          const draft = {
            section: section.collection,
            title: input.title,
            text: input.text,
            imageDataUrl: input.imageDataUrl,
            updatedAt: serverTimestamp()
          };
          if (section.editingRef) {
            await setDoc(section.editingRef, draft);
          } else {
            await addDoc(draftsCollection(), draft);
          }
          clearComposer(section);
        });
    });
  }

  if (stopEditingButton) {
    stopEditingButton.addEventListener("click", () => {
      if (confirm("Stop editing? Changes since you last saved will be lost.")) {
        clearComposer(section);
      }
    });
  }
}

sections.forEach(setupPostSection);

// ---------- Books ----------
// Books are shared with everyone. Typing a title looks up covers on Open Library
// (free, no key needed). Each book has its own page at "#book/<id>" where people
// can write notes about what they've read.

const bookTitleInput = document.getElementById("book-title");
const bookAuthorInput = document.getElementById("book-author");
const bookSubmitButton = document.getElementById("book-submit");
const coverPreview = document.getElementById("book-cover-preview");
const coverPreviewImage = document.getElementById("book-cover-preview-image");
const coverMatchText = document.getElementById("book-cover-match");
const coverNextButton = document.getElementById("book-cover-next");
const coverNoneButton = document.getElementById("book-cover-none");
const coverStatus = document.getElementById("book-cover-status");
const booksList = document.getElementById("books-list");
const booksHeading = document.getElementById("books-heading");

const bookPageContent = document.getElementById("book-page-content");
const bookPageMissing = document.getElementById("book-page-missing");
const bookPageCover = document.getElementById("book-page-cover");
const bookPageTitle = document.getElementById("book-page-title");
const bookPageAuthor = document.getElementById("book-page-author");
const bookPageMeta = document.getElementById("book-page-meta");
const bookDeleteButton = document.getElementById("book-delete");
const bookBackButton = document.getElementById("book-back");
const bookNotes = document.getElementById("book-notes");

// How long to wait after the last key press before looking up a cover
const COVER_SEARCH_DELAY_MS = 500;

// Covers found for what's typed in the box, and which one is picked (-1 = no cover)
let coverResults = [];
let coverIndex = -1;
let coverSearchTimer = null;
let coverSearch = null;
let coverSearchCount = 0;
let coverSearchController = null;

// The book whose page is open, and the function that stops its live listeners
let openBookId = null;
let stopBookPage = null;

// The cover picture, or a plain box with the title if there's no cover
// (or the picture fails to load)
function createBookCover(coverUrl, title) {
  function placeholder() {
    const box = document.createElement("div");
    box.className = "book-cover placeholder";
    box.textContent = title || "No cover";
    return box;
  }
  if (!coverUrl) {
    return placeholder();
  }
  const image = document.createElement("img");
  image.className = "book-cover";
  image.src = coverUrl;
  image.alt = `Cover of ${title}`;
  image.loading = "lazy";
  image.addEventListener("error", () => image.replaceWith(placeholder()), { once: true });
  return image;
}

async function searchOpenLibrary(params, signal) {
  params.set("limit", "15");
  params.set("fields", "title,author_name,cover_i,first_publish_year");
  const response = await fetch(`https://openlibrary.org/search.json?${params}`, { signal });
  if (!response.ok) {
    throw new Error(`Open Library answered with error ${response.status}`);
  }
  const data = await response.json();

  // Keep only results that have a cover, and each cover only once
  const seenCovers = new Set();
  const results = [];
  for (const book of data.docs || []) {
    if (!book.cover_i || seenCovers.has(book.cover_i)) {
      continue;
    }
    seenCovers.add(book.cover_i);
    results.push({
      title: book.title || "",
      author: (book.author_name || []).slice(0, 2).join(", "),
      year: book.first_publish_year || "",
      coverUrl: `https://covers.openlibrary.org/b/id/${book.cover_i}-L.jpg`
    });
  }
  return results;
}

// Looks the book up by title (and author, if given). If that finds nothing,
// tries a looser search in case the title was typed a bit differently.
async function findCovers(title, author, signal) {
  const exact = new URLSearchParams({ title: title });
  if (author) {
    exact.set("author", author);
  }
  const results = await searchOpenLibrary(exact, signal);
  if (results.length > 0) {
    return results;
  }
  return await searchOpenLibrary(new URLSearchParams({ q: `${title} ${author}`.trim() }), signal);
}

function setCoverStatus(message) {
  if (coverStatus) {
    coverStatus.textContent = message;
    coverStatus.hidden = message === "";
  }
}

// Shows the picked cover (or the "no cover" box) under the title box
function showCoverChoice() {
  if (!coverPreview) {
    return;
  }
  coverPreview.hidden = coverResults.length === 0;
  if (coverResults.length === 0) {
    return;
  }

  const title = bookTitleInput.value.trim();
  if (coverIndex === -1) {
    coverPreviewImage.replaceChildren(createBookCover("", title));
    coverMatchText.textContent = "No cover. The book will show its title instead.";
  } else {
    const match = coverResults[coverIndex];
    coverPreviewImage.replaceChildren(createBookCover(match.coverUrl, match.title));
    const by = match.author ? ` by ${match.author}` : "";
    const year = match.year ? ` (${match.year})` : "";
    coverMatchText.textContent = `Cover from "${match.title}"${by}${year}`;
  }

  if (coverIndex === -1) {
    coverNextButton.textContent = "Use a cover";
    coverNextButton.hidden = false;
  } else {
    coverNextButton.textContent = `Try another cover (showing ${coverIndex + 1} of ${coverResults.length})`;
    coverNextButton.hidden = coverResults.length < 2;
  }
  coverNoneButton.hidden = coverIndex === -1;
}

function resetCoverChoice() {
  clearTimeout(coverSearchTimer);
  coverSearchTimer = null;
  if (coverSearchController) {
    coverSearchController.abort();
  }
  coverSearchCount++;
  coverSearch = null;
  coverResults = [];
  coverIndex = -1;
  setCoverStatus("");
  showCoverChoice();
}

// Looks up covers for what's typed in the boxes right now
function runCoverSearch() {
  clearTimeout(coverSearchTimer);
  coverSearchTimer = null;
  if (coverSearchController) {
    coverSearchController.abort();
  }

  const title = bookTitleInput.value.trim();
  const author = bookAuthorInput ? bookAuthorInput.value.trim() : "";
  // Number this search, so an older, slower search can't overwrite a newer one
  const searchNumber = ++coverSearchCount;
  const controller = new AbortController();
  coverSearchController = controller;
  setCoverStatus("Looking for a cover…");

  coverSearch = findCovers(title, author, controller.signal)
    .then((results) => {
      if (searchNumber !== coverSearchCount) {
        return;
      }
      coverResults = results;
      coverIndex = results.length > 0 ? 0 : -1;
      setCoverStatus(results.length > 0
        ? ""
        : "Couldn't find a cover for this book. It will show its title instead.");
      showCoverChoice();
    })
    .catch((error) => {
      if (searchNumber !== coverSearchCount || error.name === "AbortError") {
        return;
      }
      console.error(error);
      coverResults = [];
      coverIndex = -1;
      setCoverStatus("Couldn't look up a cover right now. You can still add the book without one.");
      showCoverChoice();
    })
    .finally(() => {
      if (searchNumber === coverSearchCount) {
        coverSearch = null;
      }
    });
  return coverSearch;
}

function scheduleCoverSearch() {
  clearTimeout(coverSearchTimer);
  if (bookTitleInput.value.trim().length < 2) {
    resetCoverChoice();
    return;
  }
  setCoverStatus("Looking for a cover…");
  coverSearchTimer = setTimeout(runCoverSearch, COVER_SEARCH_DELAY_MS);
}

async function addBook() {
  const title = bookTitleInput.value.trim();
  if (title === "") {
    alert("Please enter the name of the book.");
    return;
  }

  // If the cover lookup hasn't finished yet, wait for it so the book gets its cover
  if (coverSearchTimer) {
    await runCoverSearch();
  } else if (coverSearch) {
    await coverSearch;
  }

  const match = coverIndex === -1 ? null : coverResults[coverIndex];
  const typedAuthor = bookAuthorInput ? bookAuthorInput.value.trim() : "";
  const bookRef = await addDoc(collection(db, "books"), {
    userId: userId,
    name: userName,
    title: title,
    author: (typedAuthor || (match ? match.author : "")).slice(0, 150),
    coverUrl: match ? match.coverUrl : "",
    createdAt: serverTimestamp()
  });

  bookTitleInput.value = "";
  if (bookAuthorInput) {
    bookAuthorInput.value = "";
  }
  resetCoverChoice();
  // Go straight to the new book's page so notes can be added
  location.hash = `book/${bookRef.id}`;
}

function setupBooks() {
  if (!bookTitleInput || !bookSubmitButton || !booksList) {
    console.warn("Skipping setup for books because required elements are missing.");
    return;
  }

  bookTitleInput.addEventListener("input", scheduleCoverSearch);
  if (bookAuthorInput) {
    bookAuthorInput.addEventListener("input", scheduleCoverSearch);
  }

  if (coverNextButton) {
    coverNextButton.addEventListener("click", () => {
      coverIndex = (coverIndex + 1) % coverResults.length;
      showCoverChoice();
    });
  }
  if (coverNoneButton) {
    coverNoneButton.addEventListener("click", () => {
      coverIndex = -1;
      showCoverChoice();
    });
  }

  bookSubmitButton.addEventListener("click", () => {
    bookSubmitButton.disabled = true;
    tryTo("add the book", addBook).finally(() => {
      bookSubmitButton.disabled = false;
    });
  });

  if (bookBackButton) {
    bookBackButton.addEventListener("click", () => {
      history.pushState(null, "", location.pathname + location.search);
      route();
    });
  }

  if (bookDeleteButton) {
    bookDeleteButton.addEventListener("click", () => {
      if (!openBookId || !confirm("Delete this book and all of its notes?")) {
        return;
      }
      const bookRef = doc(db, "books", openBookId);
      tryTo("delete the book", async () => {
        // Firestore doesn't delete a book's notes along with it, so delete them too
        const notes = await getDocs(collection(bookRef, "notes"));
        const batch = writeBatch(db);
        notes.forEach((note) => batch.delete(note.ref));
        batch.delete(bookRef);
        await batch.commit();
        history.pushState(null, "", location.pathname + location.search);
        route();
      });
    });
  }
}

setupBooks();

function createBookCard(bookDoc) {
  const data = readData(bookDoc);
  const card = document.createElement("button");
  card.type = "button";
  card.className = "book-card";

  const title = document.createElement("span");
  title.className = "book-card-title";
  title.textContent = data.title;

  const details = document.createElement("span");
  details.className = "meta";
  details.textContent = data.author ? `${data.author} · added by ${data.name}` : `Added by ${data.name}`;

  card.appendChild(createBookCover(data.coverUrl, data.title));
  card.appendChild(title);
  card.appendChild(details);
  card.addEventListener("click", () => {
    location.hash = `book/${bookDoc.id}`;
  });
  return card;
}

function listenToBooks() {
  if (!booksList) {
    return () => {};
  }
  const booksQuery = query(collection(db, "books"), orderBy("createdAt", "desc"));
  return onSnapshot(booksQuery, (snapshot) => {
    booksList.replaceChildren(...snapshot.docs.map(createBookCard));
    if (booksHeading) {
      booksHeading.hidden = snapshot.empty;
    }
  }, (error) => {
    console.error("Couldn't load books:", error);
  });
}

function bookIdFromHash() {
  const match = location.hash.match(/^#book\/([A-Za-z0-9]+)$/);
  return match ? match[1] : null;
}

function closeBookPage() {
  if (stopBookPage) {
    stopBookPage();
    stopBookPage = null;
  }
  openBookId = null;
  if (bookNotes) {
    bookNotes.replaceChildren();
  }
}

function showBookPage(bookId) {
  if (!bookPageContent || !bookNotes) {
    return;
  }
  closeBookPage();
  openBookId = bookId;
  switchPage("book-page");
  window.scrollTo(0, 0);

  bookPageContent.hidden = true;
  bookPageMissing.hidden = true;

  const bookRef = doc(db, "books", bookId);
  const notes = createCommentSection(bookRef, {
    collectionName: "notes",
    className: "notes",
    placeholder: "Write a note about what you read (a chapter, a quote, what you thought...)",
    buttonText: "Add note",
    emptyMessage: "Please write a note first.",
    failureDescription: "add your note",
    multiline: true
  });
  bookNotes.replaceChildren(notes.element);

  const stopBook = onSnapshot(bookRef, (snapshot) => {
    if (!snapshot.exists()) {
      bookPageContent.hidden = true;
      bookPageMissing.hidden = false;
      return;
    }
    const data = readData(snapshot);
    bookPageCover.replaceChildren(createBookCover(data.coverUrl, data.title));
    bookPageTitle.textContent = data.title;
    bookPageAuthor.textContent = data.author ? `by ${data.author}` : "";
    bookPageAuthor.hidden = !data.author;
    updateMeta(bookPageMeta, `Added by ${data.name}`, data.createdAt);
    bookDeleteButton.hidden = data.userId !== userId;
    bookPageContent.hidden = false;
    bookPageMissing.hidden = true;
  }, (error) => {
    console.error(error);
    bookPageContent.hidden = true;
    bookPageMissing.hidden = false;
  });

  stopBookPage = () => {
    stopBook();
    notes.stopComments();
  };
}

// Opens the book named in the address ("#book/<id>"), or goes back to the
// list of books when the address no longer names one (e.g. after pressing Back)
function route() {
  if (!userId) {
    return;
  }
  const bookId = bookIdFromHash();
  if (bookId) {
    if (bookId !== openBookId) {
      showBookPage(bookId);
    }
  } else if (openBookId || document.getElementById("book-page")?.classList.contains("active")) {
    closeBookPage();
    switchPage("books");
  }
}

window.addEventListener("hashchange", route);

function startListening() {
  sections.forEach((section) => {
    if (section.disabled) {
      return;
    }
    unsubscribers.push(listenToPosts(section));
    unsubscribers.push(listenToDrafts(section));
  });
  unsubscribers.push(listenToBooks());
}

function stopListening() {
  unsubscribers.forEach((unsubscribe) => unsubscribe());
  unsubscribers = [];
  closeBookPage();
  if (booksList) {
    booksList.replaceChildren();
  }
  if (booksHeading) {
    booksHeading.hidden = true;
  }
  sections.forEach((section) => {
    if (section.list) {
      section.list.replaceChildren();
    }
    updatePostsHeading(section);
    section.drafts = [];
    if (section.draftsList) {
      section.draftsList.replaceChildren();
    }
  });
}

function showSignedIn(user, name) {
  stopListening();
  sections.forEach(clearComposer);
  userId = user.uid;
  userName = name;
  if (greeting) {
    greeting.textContent = `Hi, ${userName}!`;
  }
  if (signInOverlay) {
    signInOverlay.style.display = "none";
  }
  if (signOutButton) {
    signOutButton.hidden = false;
  }
  if (changePasswordToggle) {
    changePasswordToggle.hidden = false;
  }
  startListening();
  // Open the book page if the address names one (e.g. a shared link)
  route();
}

function showSignedOut() {
  stopListening();
  sections.forEach(clearComposer);
  userId = "";
  userName = "";
  if (greeting) {
    greeting.textContent = "";
  }
  if (signInOverlay) {
    signInOverlay.style.display = "flex";
  }
  if (signOutButton) {
    signOutButton.hidden = true;
  }
  if (changePasswordToggle) {
    changePasswordToggle.hidden = true;
  }
  closePasswordPanel();
  if (nameInput) {
    nameInput.focus();
  }
}

onAuthStateChanged(auth, async (user) => {
  if (signingIn) {
    return;
  }
  if (!user) {
    showSignedOut();
    return;
  }

  try {
    const member = await getDoc(doc(db, "members", user.uid));
    if (member.exists()) {
      showSignedIn(user, member.data().name);
      return;
    }
  } catch (error) {
    console.error(error);
  }
  await signOut(auth);
});
