// account.js — sign-in dialog, profile panel, and the glue between Firebase (auth.js) and the game.
// Loaded after game.js, so it can use the game's globals ($, roster, cfg, fmt, log, ...).

let currentUser = null;   // Firebase user, or null when playing as a guest
let profile = null;       // { displayName, chips, handsPlayed, handsWon, biggestPot }
let authDirty = false;    // you signed in/out mid-hand: apply it when the next hand starts

// ---------- Game <-> account glue ----------
// Put your saved name and chips on your seat (or go back to "You" as a guest).
function syncProfileToGame() {
  if (handActive) { authDirty = true; return; }   // never change seats in the middle of a hand
  authDirty = false;
  const me = roster[0];
  if (currentUser && profile) {
    me.name = profile.displayName;
    me.chips = profile.chips > 0 ? profile.chips : cfg.startChips;   // busted last time: rebuy
  } else {
    me.name = 'You';
    me.chips = cfg.startChips;
  }
  buildTable(roster);
  renderRoster();
}

// game.js calls this at the start of every hand
function applyPendingProfile() {
  if (authDirty) syncProfileToGame();
}

// game.js calls this at the end of every hand: update stats and save them
function recordHandResult() {
  if (!currentUser || !profile || authDirty) return;
  profile.chips = roster[0].chips;
  profile.handsPlayed++;
  if (humanWinAmount > 0) {
    profile.handsWon++;
    profile.biggestPot = Math.max(profile.biggestPot, humanWinAmount);
  }
  renderProfilePanel();
  window.pokerAuth.saveProfile(profile).catch(err => log('Could not save your progress: ' + err.message));
}

// auth.js calls this whenever sign-in state changes
window.onAuthChanged = (user, prof) => {
  currentUser = user;
  profile = prof;
  if (!tutorial) syncProfileToGame();   // the tutorial table is separate: leave it alone
  renderAuthBar();
  renderProfilePanel();
};

// ---------- Header: sign in / account ----------
// Names come from users, so everything below uses textContent (never innerHTML).
function renderAuthBar() {
  const bar = $('authBar');
  bar.textContent = '';
  if (!currentUser) {
    const btn = document.createElement('button');
    btn.className = 'btn small';
    btn.textContent = 'Sign in';
    btn.onclick = openAuthDialog;
    bar.appendChild(btn);
    return;
  }
  const who = document.createElement('span');
  who.className = 'who';
  const dot = document.createElement('span');
  dot.className = 'who-dot';
  dot.textContent = (profile.displayName[0] || '?').toUpperCase();
  const name = document.createElement('span');
  name.textContent = profile.displayName;
  who.append(dot, name);
  const out = document.createElement('button');
  out.className = 'linkbtn';
  out.textContent = 'Sign out';
  out.onclick = () => window.pokerAuth.signOut();
  bar.append(who, out);
}

// ---------- Sidebar: profile panel ----------
function renderProfilePanel() {
  const body = $('profileBody');
  body.textContent = '';
  if (!currentUser || !profile) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = "You're playing as a guest. Sign in to save your chips and stats.";
    const btn = document.createElement('button');
    btn.className = 'btn small';
    btn.textContent = 'Sign in / Create account';
    btn.onclick = openAuthDialog;
    body.append(p, btn);
    return;
  }
  const rate = profile.handsPlayed ? Math.round((profile.handsWon / profile.handsPlayed) * 100) + '%' : '-';
  const rows = [
    ['Name', profile.displayName],
    ['Account', currentUser.email || 'Google'],
    ['Chips', fmt(profile.chips)],
    ['Hands played', fmt(profile.handsPlayed)],
    ['Hands won', `${fmt(profile.handsWon)} (${rate})`],
    ['Biggest pot won', fmt(profile.biggestPot)],
  ];
  const dl = document.createElement('dl');
  dl.className = 'stats';
  rows.forEach(([label, value]) => {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dl.append(dt, dd);
  });
  body.appendChild(dl);
}

// ---------- Sign-in dialog ----------
let authMode = 'in';   // 'in' (sign in) or 'up' (create account)

function openAuthDialog() {
  setAuthMode('in');
  $('authDialog').showModal();   // <dialog> gives us the overlay, focus handling and Esc-to-close
}

function setAuthMode(mode) {
  authMode = mode;
  $('tabIn').classList.toggle('active', mode === 'in');
  $('tabUp').classList.toggle('active', mode === 'up');
  $('nameRow').classList.toggle('hidden', mode !== 'up');
  $('authForgot').classList.toggle('hidden', mode === 'up');
  $('authSubmit').textContent = mode === 'up' ? 'Create account' : 'Sign in';
  $('authPass').autocomplete = mode === 'up' ? 'new-password' : 'current-password';
  showAuthMessage('');
}

function showAuthMessage(text, ok = false) {
  const el = $('authError');
  el.textContent = text;
  el.classList.toggle('ok', ok);
}

function friendlyError(err) {
  const messages = {
    'auth/invalid-email': "That email address doesn't look right.",
    'auth/email-already-in-use': 'An account with that email already exists. Try signing in.',
    'auth/weak-password': 'Password must be at least 6 characters.',
    'auth/invalid-credential': 'Wrong email or password.',
    'auth/user-not-found': 'Wrong email or password.',
    'auth/wrong-password': 'Wrong email or password.',
    'auth/too-many-requests': 'Too many attempts. Wait a bit and try again.',
    'auth/network-request-failed': 'Network problem. Check your connection.',
    'auth/popup-blocked': 'Your browser blocked the sign-in popup. Allow popups and try again.',
    'auth/operation-not-allowed': "This sign-in method isn't turned on yet.",
    'auth/unauthorized-domain': "This website isn't authorized for sign-in yet.",
    'auth/popup-closed-by-user': '',       // they just closed the popup: not an error
    'auth/cancelled-popup-request': '',
  };
  return err.code in messages ? messages[err.code] : 'Something went wrong: ' + (err.message || err);
}

// Run an auth action while the buttons are disabled; show a friendly error if it fails
async function runAuth(action, closeOnSuccess = true) {
  if (!window.pokerAuth) {
    showAuthMessage('Accounts are still loading (or blocked). Check your connection and try again.');
    return;
  }
  const buttons = $('authDialog').querySelectorAll('button');
  buttons.forEach(b => { b.disabled = true; });
  try {
    await action();
    if (closeOnSuccess) { $('authDialog').close(); $('authForm').reset(); showAuthMessage(''); }
  } catch (err) {
    showAuthMessage(friendlyError(err));
  } finally {
    buttons.forEach(b => { b.disabled = false; });
  }
}

$('tabIn').onclick = () => setAuthMode('in');
$('tabUp').onclick = () => setAuthMode('up');
$('authDialog').addEventListener('click', e => { if (e.target === $('authDialog')) $('authDialog').close(); });

$('authForm').onsubmit = e => {
  e.preventDefault();
  const email = $('authEmail').value.trim();
  const password = $('authPass').value;
  if (authMode === 'up') {
    const name = $('authName').value.replace(/[<>]/g, '').trim();
    if (!name) { showAuthMessage('Pick a display name (up to 20 characters).'); return; }
    runAuth(() => window.pokerAuth.signUp(email, password, name));
  } else {
    runAuth(() => window.pokerAuth.signIn(email, password));
  }
};

$('authGoogle').onclick = () => runAuth(() => window.pokerAuth.google());

$('authForgot').onclick = () => {
  const email = $('authEmail').value.trim();
  if (!email) { showAuthMessage('Type your email above first, then click "Forgot password?".'); return; }
  runAuth(async () => {
    await window.pokerAuth.resetPassword(email);
    showAuthMessage('Password reset email sent. Check your inbox (and spam).', true);
  }, false);
};

// Initial (signed-out) look until Firebase reports otherwise
renderAuthBar();
renderProfilePanel();
