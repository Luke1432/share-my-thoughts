import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js';
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

// Who is logged in right now (null when nobody is)
let currentUser = null;

// The name shown on posts and comments, looked up by login email. Anyone not
// listed here shows up as the start of their email (alex@example.com -> alex).
const names = {
  // 'alex@example.com': 'Alex',
};

function currentName() {
  const email = currentUser.email;
  return names[email] || currentUser.displayName || email.split('@')[0];
}

// Everyone's login email is their name followed by this
const emailDomain = '@sharemythoughts.example';

const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const logoutButton = document.getElementById('logout-button');

loginForm.addEventListener('submit', async (event) => {
  // Stops the form from reloading the page
  event.preventDefault();
  loginError.hidden = true;

  // People only type their name; the rest of the email is added here.
  // A full email (with an @) still works as typed.
  const name = document.getElementById('login-name').value.trim().toLowerCase();
  const email = name.includes('@') ? name : name + emailDomain;
  const password = document.getElementById('login-password').value;
  try {
    await signInWithEmailAndPassword(auth, email, password);
    loginForm.reset();
  } catch (error) {
    console.error(error);
    loginError.textContent = error.code === 'auth/invalid-credential'
      ? 'Wrong name or password.'
      : `Couldn't log in: ${error.message}`;
    loginError.hidden = false;
  }
});

logoutButton.addEventListener('click', () => {
  signOut(auth);
});

// ---------- Changing your password ----------
// The login emails aren't real inboxes, so "forgot password" emails can't
// work. Instead, logged-in people can change it here.

const changePasswordButton = document.getElementById('change-password-button');
const passwordForm = document.getElementById('password-form');
const passwordError = document.getElementById('password-error');

function closePasswordForm() {
  passwordForm.reset();
  passwordForm.hidden = true;
  passwordError.hidden = true;
}

changePasswordButton.addEventListener('click', () => {
  passwordForm.hidden = false;
});

document.getElementById('password-cancel').addEventListener('click', closePasswordForm);

passwordForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  passwordError.hidden = true;

  const currentPassword = document.getElementById('current-password').value;
  const newPassword = document.getElementById('new-password').value;
  if (newPassword !== document.getElementById('confirm-password').value) {
    passwordError.textContent = 'The new passwords don\'t match.';
    passwordError.hidden = false;
    return;
  }

  try {
    // Firebase only lets you change your password if you've just proved you
    // know the current one
    const credential = EmailAuthProvider.credential(currentUser.email, currentPassword);
    await reauthenticateWithCredential(currentUser, credential);
    await updatePassword(currentUser, newPassword);
    closePasswordForm();
    alert('Your password has been changed.');
  } catch (error) {
    console.error(error);
    if (error.code === 'auth/invalid-credential' || error.code === 'auth/wrong-password') {
      passwordError.textContent = 'Your current password is wrong.';
    } else if (error.code === 'auth/weak-password') {
      passwordError.textContent = 'The new password needs at least 6 characters.';
    } else {
      passwordError.textContent = `Couldn't change your password: ${error.message}`;
    }
    passwordError.hidden = false;
  }
});

// Runs on page load (Firebase remembers who was logged in) and whenever
// someone logs in or out. user is null when nobody is logged in.
onAuthStateChanged(auth, (user) => {
  currentUser = user;
  const loggedIn = user !== null;
  loginForm.hidden = loggedIn;
  logoutButton.hidden = !loggedIn;
  changePasswordButton.hidden = !loggedIn;
  closePasswordForm();
  document.querySelector('nav').hidden = !loggedIn;
  document.querySelector('main').hidden = !loggedIn;

  // Swap in this person's own drafts, and empty the writing boxes so nothing
  // the last person typed is left behind
  sections.forEach((section) => {
    section.drafts = loggedIn ? load(draftsKey(section)) : [];
    clearComposer(section);
    // Redraw posts so Delete buttons show up only on this person's posts
    renderPosts(section);
  });
});

// For now everything is saved in this browser's localStorage, so posts,
// comments and drafts only show up on the device they were written on.

function switchPage(pageId) {
  // 1. Find the page that is currently visible and hide it
  const currentPage = document.querySelector('.page.active');
  if (currentPage) {
    currentPage.classList.remove('active');
  }

  // 2. Find the target page by ID and make it visible
  const targetPage = document.getElementById(pageId);
  if (targetPage) {
    targetPage.classList.add('active');
  }
}

// Each nav button names its page in a data-page attribute
document.querySelectorAll('nav button[data-page]').forEach((button) => {
  button.addEventListener('click', () => switchPage(button.dataset.page));
});

// ---------- Saving ----------
// localStorage only stores text, so lists are turned into JSON and back.

function load(key) {
  try {
    return JSON.parse(localStorage.getItem(key)) || [];
  } catch (error) {
    console.error(error);
    return [];
  }
}

// ---------- Sign in ----------
// You sign in with your name and your own password. Behind the scenes each
// name gets its own Firebase account (the name is turned into a made-up email
// address), so the database rules can
// tell who's who: only you can read your drafts or delete your posts.

const signInOverlay = document.getElementById('sign-in-overlay');
const nameInput = document.getElementById('name-input');
const passwordInput = document.getElementById('password-input');
const signInButton = document.getElementById('sign-in');
const signOutButton = document.getElementById('sign-out');
const greeting = document.getElementById('greeting');

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
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');

  const localPart = normalized
    .replace(/[^a-z0-9._-]+/g, '.')
    .replace(/\.+/g, '.')
    .replace(/^\.|\.$/g, '');

  if (localPart === '') {
    throw new Error('Please use a name with letters or numbers.');
  }

  return `${localPart}@sharemythoughts.example`;
}

// Signs in to a pre-created account for this name.
// Account creation is intentionally disabled in the client.
async function signInWithName(name, password) {
  const email = nameToEmail(name);
  try {
    localStorage.setItem(key, JSON.stringify(items));
  } catch (error) {
    if (error.code === 'auth/user-not-found') {
      throw new Error('This name is not approved yet. Ask the admin to add your account.');
    }
    if (error.code === 'auth/wrong-password' || error.code === 'auth/invalid-credential') {
      throw new Error('Wrong password.');
    }
    throw error;
  }

  // Save your display name so posts and comments can show it.
  try {
    await setDoc(doc(db, 'members', auth.currentUser.uid), {
      name: name
    });
  } catch (error) {
    await signOut(auth);
    throw new Error('Could not finish sign-in permissions setup.');
  }
}

function signIn() {
  if (!nameInput || !passwordInput || !signInButton) {
    return;
  }

  const name = nameInput.value.trim();
  const password = passwordInput.value;
  if (name === '' || password === '') {
    alert('Please enter your name and password.');
    return;
  }
  if (name.length > 30) {
    alert('Please use a name of 30 characters or less.');
    return;
  }

  signingIn = true;
  signInButton.disabled = true;
  tryTo('sign in', async () => {
    await signInWithName(name, password);
    passwordInput.value = '';
    showSignedIn(auth.currentUser, name);
  }).finally(() => {
    signingIn = false;
    signInButton.disabled = false;
  });
}

if (signInButton) {
  signInButton.addEventListener('click', signIn);
}

if (passwordInput) {
  passwordInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      signIn();
    }
  });
}

if (signOutButton) {
  signOutButton.addEventListener('click', () => {
    tryTo('sign out', () => signOut(auth));
  });
}

// ---------- Posts and comments ----------

// Shows a time (in milliseconds) as e.g. "Oct 19, 2026, 3:45 PM"
function formatTime(time) {
  return new Date(time).toLocaleString([], {
    dateStyle: 'medium',
    timeStyle: 'short'
  });
}

// Shows who wrote a post or comment and when, e.g. "Alex · Oct 19, 2026, 3:45 PM".
// Things written before names were added just show the time.
function createMeta(item) {
  const meta = document.createElement('div');
  meta.className = 'meta';
  let time = formatTime(item.createdAt);
  if (item.editedAt) {
    time += ' (edited)';
  }
  meta.textContent = item.name ? `${item.name} · ${time}` : time;
  return meta;
}

// Newest first, without changing the order they're saved in
function newestFirst(items) {
  return [...items].sort((a, b) => b.createdAt - a.createdAt);
}

// Builds one comment. renderComments redraws the post's comments after a delete.
function createCommentItem(section, post, comment, renderComments) {
  const commentItem = document.createElement('div');
  commentItem.className = 'comment-item';

  const text = document.createElement('p');
  text.textContent = comment.text;

  commentItem.appendChild(createMeta(comment));
  commentItem.appendChild(text);

  // Only the person who wrote a comment can edit or delete it
  if (isAuthor(comment)) {
    const editButton = document.createElement('button');
    editButton.textContent = 'Edit';
    editButton.addEventListener('click', () => {
      commentItem.replaceWith(createCommentEditor(section, post, comment, renderComments));
    });

    const deleteButton = document.createElement('button');
    deleteButton.textContent = 'Delete';
    deleteButton.addEventListener('click', () => {
      if (confirm('Delete this comment?')) {
        post.comments = post.comments.filter((c) => c.id !== comment.id);
        // A deleted post is only kept for its comments, so it goes once they're gone
        if (post.deleted && post.comments.length === 0) {
          section.posts = section.posts.filter((p) => p.id !== post.id);
          save(section.postsKey, section.posts);
          renderPosts(section);
          return;
        }
        save(section.postsKey, section.posts);
        renderComments();
      }
    });

    commentItem.appendChild(editButton);
    commentItem.appendChild(deleteButton);
  }
  return commentItem;
}

// Swaps a comment for a text box to change it. Save or Cancel puts it back.
function createCommentEditor(section, post, comment, renderComments) {
  const editor = document.createElement('div');
  editor.className = 'comment-item';

  const textInput = document.createElement('input');
  textInput.type = 'text';
  textInput.value = comment.text;

  const saveButton = document.createElement('button');
  saveButton.textContent = 'Save';
  saveButton.addEventListener('click', () => {
    const text = textInput.value.trim();
    if (text === '') {
      alert('Please enter a comment before saving.');
      return;
    }
    comment.text = text;
    comment.editedAt = Date.now();
    save(section.postsKey, section.posts);
    editor.replaceWith(createCommentItem(section, post, comment, renderComments));
  });

  const cancelButton = document.createElement('button');
  cancelButton.textContent = 'Cancel';
  cancelButton.addEventListener('click', () => {
    editor.replaceWith(createCommentItem(section, post, comment, renderComments));
  });

  editor.appendChild(textInput);
  editor.appendChild(saveButton);
  editor.appendChild(cancelButton);
  return editor;
}

// Builds the comment section (list + comment input) for one post
function createCommentSection(section, post) {
  const commentSection = document.createElement('div');
  commentSection.className = 'comments';

  const commentsList = document.createElement('div');
  commentsList.className = 'comments-list';

  function renderComments() {
    commentsList.replaceChildren(...newestFirst(post.comments).map(
      (comment) => createCommentItem(section, post, comment, renderComments)));
  }
  renderComments();

  const commentInput = document.createElement('input');
  commentInput.type = 'text';
  commentInput.placeholder = 'Write a comment';

  const commentButton = document.createElement('button');
  commentButton.textContent = 'Comment';

  commentButton.addEventListener('click', () => {
    const comment = commentInput.value.trim();
    if (comment === '') {
      alert('Please enter a comment before submitting.');
      return;
    }
    post.comments.push({
      id: newId(),
      userId: currentUser.uid,
      name: currentName(),
      text: comment,
      createdAt: Date.now()
    });
    save(section.postsKey, section.posts);
    commentInput.value = '';
    // Only redraw this post's comments, so half-typed comments on other posts aren't wiped
    renderComments();
  });

  commentSection.appendChild(commentsList);
  commentSection.appendChild(commentInput);
  commentSection.appendChild(commentButton);
  return commentSection;
}

// True if the logged-in person wrote this post or comment
function isAuthor(item) {
  if (currentUser === null) {
    return false;
  }
  if (item.userId) {
    return item.userId === currentUser.uid;
  }
  // Posts from before user IDs were saved only have a name, so match on that
  return item.name !== undefined && item.name === currentName();
}

// Swaps a post for a title + text box to change it. Save or Cancel puts the
// post back, so the rest of the page (and half-typed comments) is left alone.
function createPostEditor(section, post) {
  const editor = document.createElement('div');
  editor.className = 'thought-item composer';

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.placeholder = 'Title (optional)';
  titleInput.maxLength = 150;
  titleInput.value = post.title || '';

  const textInput = document.createElement('textarea');
  textInput.rows = 5;
  textInput.maxLength = 2000;
  textInput.value = post.text;

  const saveButton = document.createElement('button');
  saveButton.textContent = 'Save';
  saveButton.addEventListener('click', () => {
    const text = textInput.value.trim();
    if (text === '') {
      alert(section.emptyMessage);
      return;
    }
    post.title = titleInput.value.trim();
    post.text = text;
    post.editedAt = Date.now();
    save(section.postsKey, section.posts);
    editor.replaceWith(createPostItem(section, post));
  });

  const cancelButton = document.createElement('button');
  cancelButton.textContent = 'Cancel';
  cancelButton.addEventListener('click', () => {
    editor.replaceWith(createPostItem(section, post));
  });

  const buttons = document.createElement('div');
  buttons.appendChild(saveButton);
  buttons.appendChild(cancelButton);

  editor.appendChild(titleInput);
  editor.appendChild(textInput);
  editor.appendChild(buttons);
  return editor;
}

// Builds one post on the page
function createPostItem(section, post) {
  const postItem = document.createElement('div');
  postItem.className = 'thought-item';

  // A deleted post that had comments: say so, but keep showing the comments
  if (post.deleted) {
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = 'This post was deleted.';
    postItem.appendChild(note);
    postItem.appendChild(createCommentSection(section, post));
    return postItem;
  }

  // Titles are optional, so there's only a heading when there is one
  if (post.title) {
    const title = document.createElement('h3');
    title.textContent = post.title;
    postItem.appendChild(title);
  }

  const text = document.createElement('p');
  text.textContent = post.text;

  postItem.appendChild(createMeta(post));
  postItem.appendChild(text);

  // Only the person who wrote a post can edit or delete it
  if (isAuthor(post)) {
    const editButton = document.createElement('button');
    editButton.textContent = 'Edit';
    editButton.addEventListener('click', () => {
      postItem.replaceWith(createPostEditor(section, post));
    });
    postItem.appendChild(editButton);

    const deleteButton = document.createElement('button');
    deleteButton.textContent = 'Delete';
    deleteButton.addEventListener('click', () => {
      if (confirm('Delete this post?')) {
        if (post.comments.length > 0) {
          // Keep the post's place so its comments stay, but drop what it said
          post.deleted = true;
          post.title = '';
          post.text = '';
        } else {
          section.posts = section.posts.filter((p) => p.id !== post.id);
        }
        save(section.postsKey, section.posts);
        renderPosts(section);
      }
    });
    postItem.appendChild(deleteButton);
  }

  postItem.appendChild(createCommentSection(section, post));
  return postItem;
}

function renderPosts(section) {
  section.list.replaceChildren(
    ...newestFirst(section.posts).map((post) => createPostItem(section, post)));
}

function addPost(section, title, text) {
  section.posts.push({
    id: newId(),
    userId: currentUser.uid,
    name: currentName(),
    title: title,
    text: text,
    createdAt: Date.now(),
    comments: []
  });
  save(section.postsKey, section.posts);
  renderPosts(section);
}

// ---------- Drafts ----------

// Drafts are saved per account (by its Firebase user ID), so people sharing
// a browser don't see each other's drafts
function draftsKey(section) {
  return `${section.name}-drafts-${currentUser.uid}`;
}

function deleteDraft(section, draftId) {
  section.drafts = section.drafts.filter((d) => d.id !== draftId);
  save(draftsKey(section), section.drafts);
}

// Moves a draft into the posts
function publishDraft(section, draftId, title, text) {
  deleteDraft(section, draftId);
  addPost(section, title, text);
}

function createDraftItem(section, draft) {
  const draftItem = document.createElement('div');
  draftItem.className = 'draft-item';

  if (draft.title) {
    const title = document.createElement('h4');
    title.textContent = draft.title;
    draftItem.appendChild(title);
  }

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = `Last saved ${formatTime(draft.updatedAt)}`;

  const text = document.createElement('p');
  text.textContent = draft.text;

  draftItem.appendChild(meta);
  draftItem.appendChild(text);

  // The draft that's open in the text box can't be published or deleted from
  // here, so changes typed into the box aren't lost by accident
  if (section.editingId === draft.id) {
    draftItem.classList.add('editing');
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = 'Open in the box above.';
    draftItem.appendChild(note);
    return draftItem;
  }

  const publishButton = document.createElement('button');
  publishButton.textContent = 'Post';
  publishButton.addEventListener('click', () => {
    if (confirm('Post this draft?')) {
      publishDraft(section, draft.id, draft.title || '', draft.text);
      renderDrafts(section);
    }
  });

  // Opens the draft in the text box to keep working on it. The draft stays
  // saved until you press "Save draft" (updates it) or "Post" (shares it).
  const editButton = document.createElement('button');
  editButton.textContent = 'Edit';
  editButton.addEventListener('click', () => {
    openDraft(section, draft);
  });

  const deleteButton = document.createElement('button');
  deleteButton.textContent = 'Delete';
  deleteButton.addEventListener('click', () => {
    if (confirm('Delete this draft?')) {
      deleteDraft(section, draft.id);
      renderDrafts(section);
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
    ...drafts.map((draft) => createDraftItem(section, draft)));

  if (drafts.length > 0) {
    const heading = document.createElement('h3');
    heading.textContent = `Your drafts (${drafts.length})`;
    section.draftsList.prepend(heading);
  }
}

// ---------- Writing box ----------
// Each section has one box (title + text). It's either writing something new,
// or editing a saved draft (section.editingId is that draft's ID).

function openDraft(section, draftDoc) {
  if (!section.input || !section.titleInput) {
    return;
  }

  const hasUnsavedText = section.input.value.trim() !== '' || section.titleInput.value.trim() !== '';
  if (hasUnsavedText && !confirm('Replace what\'s in the box with this draft? Unsaved text will be lost.')) {
    return;
  }

  const data = draftDoc.data();
  section.titleInput.value = data.title || '';
  section.input.value = data.text;
  section.editingRef = draftDoc.ref;
  if (section.editingNote) {
    section.editingNote.hidden = false;
  }
  renderDrafts(section);
  section.input.focus();
}

// Empties the box and goes back to writing something new
function clearComposer(section) {
  if (section.titleInput) {
    section.titleInput.value = '';
  }
  if (section.input) {
    section.input.value = '';
  }
  section.editingRef = null;
  if (section.editingNote) {
    section.editingNote.hidden = true;
  }
  renderDrafts(section);
}

// ---------- Sections ----------
// Each page with posts. 'name' is used for its localStorage keys and the
// ID of its list, and 'prefix' is the start of the IDs of its other
// elements in index.html.
const sections = [
  {
    name: 'thoughts',
    prefix: 'thought',
    emptyMessage: 'Please write a thought first.'
  },
  {
    name: 'goals',
    prefix: 'goal',
    emptyMessage: 'Please write a goal first.'
  },
  {
    name: 'accomplishments',
    prefix: 'accomplishment',
    emptyMessage: 'Please write an accomplishment first.'
  }, 
  {
    collection: 'goals',
    prefix: 'goal',
    emptyMessage: 'Please write a goal first.'
  },
  {
    collection: 'memories',
    prefix: 'memory',
    emptyMessage: 'Please share a memory first.'
  },
  {
    collection: 'group-activities',
    prefix: 'activity',
    emptyMessage: 'Please share an activity idea first.'
  }
];

// Hooks up a section's writing box and its Post / Save draft / Stop editing buttons
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
  section.editingId = null;

  if (!section.titleInput || !section.input || !submitButton || !section.list) {
    console.warn(`Skipping setup for section "${section.collection}" because required elements are missing.`);
    section.disabled = true;
    return;
  }

  section.disabled = false;

  // Returns the trimmed title and text, or null (with a message) if there's no text
  function readInput() {
    const text = section.input.value.trim();
    if (text === '') {
      alert(section.emptyMessage);
      return null;
    }
    return { title: section.titleInput.value.trim(), text: text };
  }

  submitButton.addEventListener('click', () => {
    const input = readInput();
    if (input !== null && confirm('Post this?')) {
      if (section.editingId) {
        // Posting a draft you were editing also removes it from your drafts
        publishDraft(section, section.editingId, input.title, input.text);
      } else {
        addPost(section, input.title, input.text);
      }
      clearComposer(section);
    }
  });

  if (saveDraftButton) {
    saveDraftButton.addEventListener('click', () => {
      const input = readInput();
      if (input !== null) {
        tryTo('save the draft', async () => {
          const draft = {
            section: section.collection,
            title: input.title,
            text: input.text,
            updatedAt: serverTimestamp()
          };
          // Editing a draft saves over it; otherwise it's a brand new draft
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
    stopEditingButton.addEventListener('click', () => {
      if (confirm('Stop editing? Changes since you last saved will be lost.')) {
        clearComposer(section);
      }
    });
  }
}

sections.forEach(setupPostSection);

// Starts the live listeners for the signed-in user
function startListening() {
  sections.forEach((section) => {
    if (section.disabled) {
      return;
    }
    unsubscribers.push(listenToPosts(section));
    unsubscribers.push(listenToDrafts(section));
  });
}

// Stops the listeners and clears the lists, e.g. when someone signs out
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
    signInOverlay.style.display = 'none';
  }
  if (signOutButton) {
    signOutButton.hidden = false;
  }
  startListening();
}

function showSignedOut() {
  stopListening();
  sections.forEach(clearComposer);
  userId = '';
  userName = '';
  if (greeting) {
    greeting.textContent = '';
  }
  if (signInOverlay) {
    signInOverlay.style.display = 'flex';
  }
  if (signOutButton) {
    signOutButton.hidden = true;
  }
  if (nameInput) {
    nameInput.focus();
  }
}

// Runs when the page loads (Firebase remembers you between visits)
// and whenever someone signs in or out
onAuthStateChanged(auth, async (user) => {
  if (signingIn) {
    return;
  }
  if (!user) {
    showSignedOut();
    return;
  }

  // Remembered from a previous visit: get your name from members/{userId}.
  // If it isn't there, sign-in never finished, so start over.
  try {
    const member = await getDoc(doc(db, 'members', user.uid));
    if (member.exists()) {
      showSignedIn(user, member.data().name);
      return;
    }
  } catch (error) {
    console.error(error);
  }
  await signOut(auth);
});
