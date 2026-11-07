// auth.js — the ONLY file that talks to Firebase. Everything else calls window.pokerAuth.
//
// This is an ES module (<script type="module">) because Firebase's CDN builds are modules.
// firebaseConfig comes from firebase-config.js, which loads before this file.
//
// How usernames work: Firebase signs people in with an email + password. So at sign-up we also
// save a tiny document usernames/<lowercase name> = { uid, email }. At sign-in we look the
// username up, find the email, and sign in with that. (See firestore.rules for who may read it.)
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signInWithPopup, GoogleAuthProvider, signOut, deleteUser, sendPasswordResetEmail,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  getFirestore, doc, getDoc, setDoc, writeBatch, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const STARTER_STATS = { chips: 1000, handsPlayed: 0, handsWon: 0, biggestPot: 0 };
let signingUp = false;   // true while signUp() runs, so onAuthStateChanged doesn't race with it

// ---------- Username helpers ----------
const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;
// Errors made by our own code use an "app/..." code so account.js can show a friendly message
const appError = code => Object.assign(new Error(code), { code });

function checkUsername(name) {
  const clean = String(name || '').trim();
  if (!USERNAME_RE.test(clean)) throw appError('app/bad-username');
  return clean;
}

const usernameRef = name => doc(db, 'usernames', name.toLowerCase());   // case-insensitive: "Bob" == "bob"

// Returns the email saved for a username, or null if there's no such username
async function lookupEmail(name) {
  if (!USERNAME_RE.test(name)) return null;   // also keeps odd characters (like "/") out of the path
  const snap = await getDoc(usernameRef(name));
  return snap.exists() ? snap.data().email : null;
}

// What people type when signing in: an email (has "@") or a username
async function resolveEmail(idOrEmail) {
  const id = idOrEmail.trim();
  return id.includes('@') ? id : lookupEmail(id);
}

// Saves the username claim AND the profile in one batch: both succeed or neither does.
// Rules only allow *creating* a usernames doc, so if someone grabbed the name first, this fails.
async function saveUsername(user, name, stats, extra = {}) {
  const batch = writeBatch(db);
  batch.set(usernameRef(name), { uid: user.uid, email: user.email });
  batch.set(doc(db, 'users', user.uid), {
    ...stats, ...extra, username: name, displayName: name, updatedAt: serverTimestamp(),
  }, { merge: true });
  await batch.commit();
}

// ---------- Loading the profile ----------
// What we keep in Firestore at users/<uid>. username is null until a (Google) user picks one.
function newProfile(user) {
  return { displayName: (user.displayName || 'Player').slice(0, 20), username: null, ...STARTER_STATS };
}

async function loadProfile(user) {
  let profile;
  try {
    const snap = await getDoc(doc(db, 'users', user.uid));
    profile = { ...newProfile(user), ...(snap.exists() ? snap.data() : {}) };   // fill in missing fields
  } catch (err) {
    console.error('Could not load profile', err);
    profile = newProfile(user);   // still let them play; saving may fail until it's fixed
  }
  window.onAuthChanged && window.onAuthChanged(user, profile);
}

// Runs whenever someone signs in, signs out, or the page loads with a saved session.
onAuthStateChanged(auth, user => {
  if (signingUp) return;   // signUp() will load the profile itself once the username is saved
  if (!user) { window.onAuthChanged && window.onAuthChanged(null, null); return; }
  loadProfile(user);
});

window.pokerAuth = {
  async signUp(username, email, password) {
    const name = checkUsername(username);
    if (await lookupEmail(name)) throw appError('app/username-taken');   // friendly early check
    signingUp = true;
    try {
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      try {
        await saveUsername(cred.user, name, STARTER_STATS, { createdAt: serverTimestamp() });
      } catch (err) {
        // Someone grabbed the name in the last second. Remove the half-made account so
        // the email isn't stuck, then report it.
        await deleteUser(cred.user).catch(() => {});
        throw appError('app/username-taken');
      }
      await loadProfile(cred.user);
    } finally {
      signingUp = false;
      if (!auth.currentUser) window.onAuthChanged && window.onAuthChanged(null, null);
    }
  },

  async signIn(idOrEmail, password) {
    const email = await resolveEmail(idOrEmail);
    if (!email) throw appError('auth/invalid-credential');   // same message as a wrong password
    await signInWithEmailAndPassword(auth, email, password);
  },

  google: () => signInWithPopup(auth, new GoogleAuthProvider()),
  signOut: () => signOut(auth),

  async resetPassword(idOrEmail) {
    const email = await resolveEmail(idOrEmail);
    if (email) await sendPasswordResetEmail(auth, email);
    // Unknown username: say nothing different, so the message is the same either way
  },

  // For Google users (or old accounts) who haven't picked a username yet. `p` is the live profile.
  async chooseUsername(username, p) {
    const user = auth.currentUser;
    if (!user) throw appError('auth/requires-recent-login');
    const name = checkUsername(username);
    if (await lookupEmail(name)) throw appError('app/username-taken');
    await saveUsername(user, name, {
      chips: Math.max(0, Math.floor(p.chips)),
      handsPlayed: p.handsPlayed, handsWon: p.handsWon, biggestPot: p.biggestPot,
    });
    return name;
  },

  // Saves progress after a hand. Rules only allow writing your own users/<uid> document.
  async saveProfile(p) {
    if (!auth.currentUser) return;
    await setDoc(doc(db, 'users', auth.currentUser.uid), {
      displayName: String(p.displayName || 'Player').slice(0, 20),
      chips: Math.max(0, Math.floor(p.chips)),
      handsPlayed: p.handsPlayed, handsWon: p.handsWon, biggestPot: p.biggestPot,
      updatedAt: serverTimestamp(),
    }, { merge: true });
  },
};
