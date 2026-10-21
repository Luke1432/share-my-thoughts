// This file is a module (see <script type="module"> in index.html), which is
// what lets it import Firebase straight from Google's CDN without a build step
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword,
  onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  getFirestore, collection, doc, addDoc, setDoc, getDoc, deleteDoc,
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
  button.addEventListener("click", () => switchPage(button.dataset.page));
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

function newPost(title, text) {
  return {
    userId: userId,
    name: userName,
    title: title,
    text: text,
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

function createCommentItem(commentDoc) {
  const data = readData(commentDoc);
  const commentItem = document.createElement("div");
  commentItem.className = "comment-item";

  const text = document.createElement("p");
  text.textContent = data.text;

  commentItem.appendChild(createMeta(data.name, data.createdAt));
  commentItem.appendChild(text);
  return commentItem;
}

function createCommentSection(postRef) {
  const commentsRef = collection(postRef, "comments");

  const section = document.createElement("div");
  section.className = "comments";

  const commentsList = document.createElement("div");
  commentsList.className = "comments-list";

  const commentInput = document.createElement("input");
  commentInput.type = "text";
  commentInput.placeholder = "Write a comment";

  const commentButton = document.createElement("button");
  commentButton.textContent = "Comment";

  commentButton.addEventListener("click", () => {
    const comment = commentInput.value.trim();
    if (comment === "") {
      alert("Please enter a comment before submitting.");
    } else {
      tryTo("post your comment", async () => {
        await addDoc(commentsRef, newComment(comment));
        commentInput.value = "";
      });
    }
  });

  const stopComments = onSnapshot(query(commentsRef, orderBy("createdAt")), (snapshot) => {
    commentsList.replaceChildren(...snapshot.docs.map(createCommentItem));
  });

  section.appendChild(commentsList);
  section.appendChild(commentInput);
  section.appendChild(commentButton);
  return { element: section, stopComments: stopComments };
}

function createPostItem(postDoc) {
  const data = readData(postDoc);
  const postItem = document.createElement("div");
  postItem.className = "thought-item";

  const title = document.createElement("h3");
  const meta = createMeta(data.name, data.createdAt);
  const text = document.createElement("p");

  function showContent(postData) {
    title.textContent = postData.title || "";
    title.hidden = !postData.title;
    text.textContent = postData.text;
  }
  showContent(data);

  postItem.appendChild(title);
  postItem.appendChild(meta);
  postItem.appendChild(text);

  if (data.userId === userId) {
    const deleteButton = document.createElement("button");
    deleteButton.textContent = "Delete";
    deleteButton.addEventListener("click", () => {
      if (confirm("Delete this post?")) {
        tryTo("delete the post", () => deleteDoc(postDoc.ref));
      }
    });
    postItem.appendChild(deleteButton);
  }

  const comments = createCommentSection(postDoc.ref);
  postItem.appendChild(comments.element);

  return {
    element: postItem,
    stopComments: comments.stopComments,
    update: (newDoc) => {
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
        items.set(id, createPostItem(change.doc));
      } else {
        const existing = items.get(id);
        if (existing) {
          existing.update(change.doc);
        }
      }

      const nextItem = section.list.children[change.newIndex] || null;
      section.list.insertBefore(items.get(id).element, nextItem);
    });
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

async function publishDraft(section, draftRef, title, text) {
  const batch = writeBatch(db);
  batch.set(doc(collection(db, section.collection)), newPost(title, text));
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
        publishDraft(section, draftDoc.ref, data.title || "", data.text));
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
    heading.textContent = `Your drafts (${section.drafts.length}, only you can see these)`;
    section.draftsList.prepend(heading);
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

// ---------- Writing box ----------

function openDraft(section, draftDoc) {
  if (!section.input || !section.titleInput) {
    return;
  }

  const hasUnsavedText =
    section.input.value.trim() !== "" || section.titleInput.value.trim() !== "";
  if (hasUnsavedText && !confirm("Replace what's in the box with this draft? Unsaved text will be lost.")) {
    return;
  }

  const data = draftDoc.data();
  section.titleInput.value = data.title || "";
  section.input.value = data.text;
  section.editingRef = draftDoc.ref;
  if (section.editingNote) {
    section.editingNote.hidden = false;
  }
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
  if (section.editingNote) {
    section.editingNote.hidden = true;
  }
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
  section.editingNote = document.getElementById(`${prefix}-editing`);
  section.draftsList = document.getElementById(`${prefix}-drafts`);
  section.list = document.getElementById(`${section.collection}-list`);
  const submitButton = document.getElementById(`${prefix}-submit`);
  const saveDraftButton = document.getElementById(`${prefix}-save-draft`);
  const stopEditingButton = document.getElementById(`${prefix}-stop-editing`);
  section.drafts = [];
  section.editingRef = null;

  if (!section.titleInput || !section.input || !submitButton || !section.list) {
    console.warn(`Skipping setup for section \"${section.collection}\" because required elements are missing.`);
    section.disabled = true;
    return;
  }

  section.disabled = false;

  function readInput() {
    const text = section.input.value.trim();
    if (text === "") {
      alert(section.emptyMessage);
      return null;
    }
    return { title: section.titleInput.value.trim(), text: text };
  }

  submitButton.addEventListener("click", () => {
    const input = readInput();
    if (input !== null && confirm("Post this? Everyone will be able to see it.")) {
      tryTo("post", async () => {
        if (section.editingRef) {
          await publishDraft(section, section.editingRef, input.title, input.text);
        } else {
          await addDoc(collection(db, section.collection), newPost(input.title, input.text));
        }
        clearComposer(section);
      });
    }
  });

  if (saveDraftButton) {
    saveDraftButton.addEventListener("click", () => {
      const input = readInput();
      if (input !== null) {
        tryTo("save the draft", async () => {
          const draft = {
            section: section.collection,
            title: input.title,
            text: input.text,
            updatedAt: serverTimestamp()
          };
          if (section.editingRef) {
            await setDoc(section.editingRef, draft);
          } else {
            await addDoc(draftsCollection(), draft);
          }
          clearComposer(section);
        });
      }
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

function startListening() {
  sections.forEach((section) => {
    if (section.disabled) {
      return;
    }
    unsubscribers.push(listenToPosts(section));
    unsubscribers.push(listenToDrafts(section));
  });
}

function stopListening() {
  unsubscribers.forEach((unsubscribe) => unsubscribe());
  unsubscribers = [];
  sections.forEach((section) => {
    if (section.list) {
      section.list.replaceChildren();
    }
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
  startListening();
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
