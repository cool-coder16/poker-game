// auth.js — the ONLY file that talks to Firebase. Everything else calls window.pokerAuth.
//
// This is an ES module (<script type="module">) because Firebase's CDN builds are modules.
// firebaseConfig comes from firebase-config.js, which loads before this file.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signInWithPopup, GoogleAuthProvider, signOut, updateProfile, sendPasswordResetEmail,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  getFirestore, doc, getDoc, setDoc, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const STARTING_CHIPS = 1000;
let pendingName = null;   // the display name typed on the sign-up form (see signUp below)

const cleanName = s => String(s || '').replace(/[<>]/g, '').trim().slice(0, 20);

// What we store in Firestore at users/<uid>. Only these fields are ever written.
function newProfile(user) {
  const fallback = user.email ? user.email.split('@')[0] : 'Player';
  return {
    displayName: cleanName(pendingName || user.displayName || fallback) || 'Player',
    chips: STARTING_CHIPS, handsPlayed: 0, handsWon: 0, biggestPot: 0,
  };
}

// Runs whenever someone signs in, signs out, or the page loads with a saved session.
onAuthStateChanged(auth, async user => {
  if (!user) { window.onAuthChanged && window.onAuthChanged(null, null); return; }
  const ref = doc(db, 'users', user.uid);
  let profile;
  try {
    const snap = await getDoc(ref);
    if (snap.exists()) {
      profile = { ...newProfile(user), ...snap.data() };   // fill in any missing fields
    } else {
      profile = newProfile(user);                          // first sign-in: create the profile
      await setDoc(ref, { ...profile, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    }
  } catch (err) {
    console.error('Could not load profile', err);
    profile = newProfile(user);   // still let them play; saving may fail until it's fixed
  }
  pendingName = null;
  window.onAuthChanged && window.onAuthChanged(user, profile);
});

window.pokerAuth = {
  async signUp(email, password, name) {
    pendingName = name;   // onAuthStateChanged fires inside createUser..., so remember the name first
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    await updateProfile(cred.user, { displayName: cleanName(name) });
  },
  signIn: (email, password) => signInWithEmailAndPassword(auth, email, password),
  google: () => signInWithPopup(auth, new GoogleAuthProvider()),
  signOut: () => signOut(auth),
  resetPassword: email => sendPasswordResetEmail(auth, email),

  // Saves progress after a hand. Rules only allow writing your own users/<uid> document.
  async saveProfile(p) {
    if (!auth.currentUser) return;
    await setDoc(doc(db, 'users', auth.currentUser.uid), {
      displayName: cleanName(p.displayName) || 'Player',
      chips: Math.max(0, Math.floor(p.chips)),
      handsPlayed: p.handsPlayed, handsWon: p.handsWon, biggestPot: p.biggestPot,
      updatedAt: serverTimestamp(),
    }, { merge: true });
  },
};
