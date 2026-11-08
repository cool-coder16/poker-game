// account.js — sign-in dialogs and the header bar. Shared by every page (needs common.js + season.js).
// Pages that care who is signed in call onAuth(fn); it runs now (if already known) and on every change.

let currentUser = null;   // Firebase user, or null when playing as a guest
let profile = null;       // see zeroStats() in auth.js for the fields
let authKnown = false;    // false until Firebase has told us whether someone is signed in
const authListeners = [];

function onAuth(fn) {
  authListeners.push(fn);
  if (authKnown) fn(currentUser, profile);
}

// auth.js calls this whenever sign-in state changes
window.onAuthChanged = async (user, prof) => {
  currentUser = user;
  profile = prof;
  if (user && prof) await ensureSeason();
  authKnown = true;
  renderAuthBar();
  authListeners.forEach(fn => fn(user, prof));
  // Count any Arenas that finished since your last visit (arena-rating.js; only the pages that load it do this)
  const redraw = changed => { if (changed) authListeners.forEach(fn => fn(currentUser, profile)); };   // show the new rating
  if (user && prof && typeof settleArenas === 'function') {
    settleArenas().then(redraw).catch(err => console.error('Could not count Arena results', err));
  }
  if (user && prof && typeof settleTourneys === 'function') {   // same for finished tournaments (tourney-rating.js)
    settleTourneys().then(redraw).catch(err => console.error('Could not count tournament results', err));
  }
  // Google users pick a username (but don't interrupt the tutorial; `tutorial` only exists on play.html)
  const inTutorial = typeof tutorial !== 'undefined' && tutorial;
  if (user && !prof.username && !inTutorial) openNameDialog();
};

// New week since you last played? Score last week and reset your season numbers (see rollSeason in auth.js)
async function ensureSeason() {
  if (profile.season === seasonId()) return;
  try {
    Object.assign(profile, await window.pokerAuth.rollSeason(profile));
  } catch (err) {
    console.error('Could not start the new season', err);
  }
}

// ---------- Dialogs (the same markup on every page, so it lives here once) ----------
// This is fixed text we wrote ourselves, never user input, so innerHTML is safe here.
document.body.insertAdjacentHTML('beforeend', `
  <dialog id="authDialog">
    <form method="dialog" class="auth-close"><button aria-label="Close">✕</button></form>
    <h2>Welcome to Poker Night</h2>
    <div class="auth-tabs">
      <button type="button" id="tabIn" class="active">Sign in</button>
      <button type="button" id="tabUp">Create account</button>
    </div>
    <form id="authForm">
      <!-- Sign in shows Username only; Create account shows Username + Email.
           setAuthMode swaps the rows (and their "required" flags). -->
      <label id="idRow">Username
        <input id="authId" required autocomplete="username" autocapitalize="none" spellcheck="false">
      </label>
      <label id="nameRow" class="hidden">Username
        <input id="authName" maxlength="16" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="3-16 letters, numbers or _">
      </label>
      <label id="emailRow" class="hidden">Email <small>(only used to reset your password)</small>
        <input id="authEmail" type="email" autocomplete="email">
      </label>
      <label>Password
        <input id="authPass" type="password" required minlength="6" autocomplete="current-password">
      </label>
      <label id="ageRow" class="check hidden"><input type="checkbox" id="authAge"> I am 13 or older</label>
      <p class="auth-error" id="authError" role="alert"></p>
      <button class="btn deal" id="authSubmit" type="submit">Sign in</button>
      <button type="button" class="linkbtn" id="authForgot">Forgot password?</button>
    </form>
    <div class="auth-or"><span>or</span></div>
    <button type="button" class="btn google" id="authGoogle">Continue with Google</button>
    <p class="hint">Guests can play too. An account saves your chips and puts you on the leaderboard.</p>
  </dialog>

  <!-- Shown to Google users (or old accounts) who haven't picked a username yet -->
  <dialog id="nameDialog">
    <form method="dialog" class="auth-close"><button aria-label="Close">✕</button></form>
    <h2>Pick a username</h2>
    <form id="nameForm">
      <label>Username
        <input id="nameInput" required maxlength="16" autocapitalize="none" spellcheck="false" placeholder="3-16 letters, numbers or _">
      </label>
      <p class="auth-error" id="nameError" role="alert"></p>
      <button class="btn deal" type="submit">Save username</button>
    </form>
  </dialog>
`);

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
  const who = document.createElement('a');   // a link to your account page
  who.className = 'who';
  who.href = 'account.html';
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
  // Show the rows for this mode. Hidden inputs must not be "required", or the browser
  // refuses to submit the form because of a field you can't even see.
  const up = mode === 'up';
  $('idRow').classList.toggle('hidden', up);
  $('nameRow').classList.toggle('hidden', !up);
  $('emailRow').classList.toggle('hidden', !up);
  $('ageRow').classList.toggle('hidden', !up);
  $('authId').required = !up;
  $('authName').required = up;
  $('authEmail').required = up;
  $('authAge').required = up;
  $('authForgot').classList.toggle('hidden', up);
  $('authSubmit').textContent = up ? 'Create account' : 'Sign in';
  $('authPass').autocomplete = up ? 'new-password' : 'current-password';
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
    'auth/invalid-credential': 'Wrong username or password.',
    'auth/user-not-found': 'Wrong username or password.',
    'auth/wrong-password': 'Wrong username or password.',
    'app/bad-username': 'Usernames are 3-16 characters: letters, numbers and underscore only.',
    'app/username-taken': 'That username is taken. Try another.',
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
  const password = $('authPass').value;
  if (authMode === 'up') {
    runAuth(() => window.pokerAuth.signUp($('authName').value, $('authEmail').value.trim(), password));
  } else {
    runAuth(() => window.pokerAuth.signIn($('authId').value, password));
  }
};

$('authGoogle').onclick = () => runAuth(() => window.pokerAuth.google());

$('authForgot').onclick = () => {
  const id = $('authId').value.trim();
  if (!id) { showAuthMessage('Type your username above first, then click "Forgot password?".'); return; }
  runAuth(async () => {
    await window.pokerAuth.resetPassword(id);
    // Same wording whether or not the account exists, so this can't be used to probe for accounts
    showAuthMessage('If that account exists, a reset email is on its way. Check your inbox (and spam).', true);
  }, false);
};

// ---------- "Pick a username" dialog (Google users) ----------
function openNameDialog() {
  if (!$('nameDialog').open) $('nameDialog').showModal();
}

$('nameForm').onsubmit = async e => {
  e.preventDefault();
  const err = $('nameError');
  err.textContent = '';
  try {
    const name = await window.pokerAuth.chooseUsername($('nameInput').value, profile);
    profile.username = name;
    profile.displayName = name;
    renderAuthBar();
    authListeners.forEach(fn => fn(currentUser, profile));   // let the page refresh itself
    $('nameDialog').close();
  } catch (ex) {
    err.textContent = friendlyError(ex);
  }
};

// Initial (signed-out) look until Firebase reports otherwise
renderAuthBar();
