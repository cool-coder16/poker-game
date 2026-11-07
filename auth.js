// auth.js — the ONLY file that talks to Firebase. Everything else calls window.pokerAuth.
//
// This is an ES module (<script type="module">) because Firebase's CDN builds are modules.
// firebaseConfig comes from firebase-config.js and the season rules from season.js; both
// are plain scripts that load before this file.
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
  getFirestore, doc, getDoc, writeBatch, serverTimestamp,
  collection, query, orderBy, limit, getDocs,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

let signingUp = false;   // true while signUp() runs, so onAuthStateChanged doesn't race with it

// ---------- What we store about a player (users/<uid>) ----------
// Lifetime: handsPlayed, handsWon, biggestPot.
// This season: season (id), chips, sHands, sWins, sBb (net big blinds won), rebuys.
// Rating: points, seasons (played), bestRank, history (last 12 season results).
function zeroStats(season) {
  return {
    chips: SEASON_START_CHIPS, handsPlayed: 0, handsWon: 0, biggestPot: 0,
    season, sHands: 0, sWins: 0, sBb: 0, rebuys: 0,
    points: 0, seasons: 0, bestRank: 0, history: [],
  };
}

// Just the stat fields of a profile (what we are allowed to save)
function statsOf(p) {
  const out = {};
  Object.keys(zeroStats(null)).forEach(k => { out[k] = p[k]; });
  out.chips = Math.max(0, Math.floor(p.chips));
  return out;
}

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
// username is null until a (Google) user picks one; season is null until the first rollSeason.
function newProfile(user) {
  return { displayName: (user.displayName || 'Player').slice(0, 20), username: null, ...zeroStats(null) };
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

// ---------- Seasons & leaderboards ----------
// Top players of a season, best score first. Each row: { uid, username, chips, rebuys, score, hands, wins, bb }
async function loadSeason(id, count = 100) {
  const q = query(collection(db, 'seasons', id, 'players'), orderBy('score', 'desc'), limit(count));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ uid: d.id, ...d.data() }));
}

// All-time rating board. Each row: { uid, username, points, seasons }
async function loadRatings(count = 100) {
  const q = query(collection(db, 'ratings'), orderBy('points', 'desc'), limit(count));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ uid: d.id, ...d.data() }));
}

// Final placement among players who qualified (enough hands) in a finished season
async function rankInSeason(id, uid) {
  const qualified = (await loadSeason(id, 200)).filter(r => r.hands >= SEASON_MIN_HANDS);
  const i = qualified.findIndex(r => r.uid === uid);
  return i === -1 ? qualified.length + 1 : i + 1;
}

// Called after sign-in. If a new week has started: score last week (rank -> rating points),
// then reset this season's numbers. Returns the fields to merge into the profile.
async function rollSeason(p) {
  const user = auth.currentUser;
  const now = seasonId();
  let { points, seasons, bestRank } = p;
  const history = [...(p.history || [])];

  if (p.season && p.season !== now) {
    if (p.sHands >= SEASON_MIN_HANDS) {
      const rank = await rankInSeason(p.season, user.uid);
      const earned = placementPoints(rank);
      points += earned;
      seasons += 1;
      bestRank = bestRank ? Math.min(bestRank, rank) : rank;
      history.unshift({ season: p.season, rank, points: earned, score: seasonScore(p.chips, p.rebuys) });
    } else {
      history.unshift({ season: p.season, rank: 0, points: 0, score: seasonScore(p.chips, p.rebuys) });   // didn't qualify
    }
  }

  const fresh = {
    season: now, chips: SEASON_START_CHIPS, sHands: 0, sWins: 0, sBb: 0, rebuys: 0,
    points, seasons, bestRank, history: history.slice(0, 12),
  };
  const batch = writeBatch(db);
  batch.set(doc(db, 'users', user.uid), { ...fresh, updatedAt: serverTimestamp() }, { merge: true });
  if (p.username && seasons > 0) {
    batch.set(doc(db, 'ratings', user.uid), { username: p.username, points, seasons, updatedAt: serverTimestamp() });
  }
  await batch.commit();
  return fresh;
}

window.pokerAuth = {
  async signUp(username, email, password) {
    const name = checkUsername(username);
    if (await lookupEmail(name)) throw appError('app/username-taken');   // friendly early check
    signingUp = true;
    try {
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      try {
        await saveUsername(cred.user, name, zeroStats(seasonId()), { createdAt: serverTimestamp() });
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

  // Sign-in is username + password only. The email is looked up behind the scenes.
  async signIn(username, password) {
    const email = await lookupEmail(username.trim());
    if (!email) throw appError('auth/invalid-credential');   // same message as a wrong password
    await signInWithEmailAndPassword(auth, email, password);
  },

  google: () => signInWithPopup(auth, new GoogleAuthProvider()),
  signOut: () => signOut(auth),

  async resetPassword(username) {
    const email = await lookupEmail(username.trim());
    if (email) await sendPasswordResetEmail(auth, email);
    // Unknown username: say nothing different, so the message is the same either way
  },

  // For Google users (or old accounts) who haven't picked a username yet. `p` is the live profile.
  async chooseUsername(username, p) {
    const user = auth.currentUser;
    if (!user) throw appError('auth/requires-recent-login');
    const name = checkUsername(username);
    if (await lookupEmail(name)) throw appError('app/username-taken');
    await saveUsername(user, name, statsOf(p));
    return name;
  },

  rollSeason, loadSeason, loadRatings,

  // Saves progress after a hand: your private profile, plus your public line on this
  // season's leaderboard. Rules only allow writing your own documents.
  async saveProfile(p) {
    const user = auth.currentUser;
    if (!user) return;
    const batch = writeBatch(db);
    batch.set(doc(db, 'users', user.uid), {
      ...statsOf(p), displayName: String(p.displayName || 'Player').slice(0, 20), updatedAt: serverTimestamp(),
    }, { merge: true });
    if (p.username && p.season) {
      batch.set(doc(db, 'seasons', p.season, 'players', user.uid), {
        username: p.username, chips: Math.max(0, Math.floor(p.chips)), rebuys: p.rebuys,
        score: seasonScore(Math.max(0, Math.floor(p.chips)), p.rebuys),
        hands: p.sHands, wins: p.sWins, bb: Math.round(p.sBb * 10) / 10,
        updatedAt: serverTimestamp(),
      });
    }
    await batch.commit();
  },
};

window.dispatchEvent(new Event('pokerauth-ready'));
