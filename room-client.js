// room-client.js — the room page: a lobby while players gather, then the live table.
// It never runs the game itself (room-host.js does that, in the host's browser). It watches the
// room through room-net.js, draws the table with table-ui.js, and sends your moves back.
//
// room.html?code=ABCDE  joins a real room.   room.html?local  is a one-tab demo with bots (no network).
//
// Remember: the database drops empty arrays, so anything that might be empty is read with `|| []`.

const roomParams = new URLSearchParams(location.search);
const LOCAL = roomParams.has('local');
const MAX_ROOM_SEATS = 8;
const SEAT_COLORS = ['#2f8f5b', '#c4572b', '#2b6fc4', '#8e5bd6', '#d6a52b', '#2bb5c4', '#d62b7a', '#6b7a90'];
const colorFor = uid => SEAT_COLORS[[...uid].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % SEAT_COLORS.length];

let code = '';
let net = null;
let myId = null, myName = '';
let roomData = null;        // everything public about the room: { meta, seats, bots, state, presence }
let myPrivate = null;       // { handNo, hole } my two cards, readable only by me
let isHost = false;
let hostCtl = null;         // the dealer (room-host.js) if I'm the host
let wasSeated = false;
let controlsSeq = -1;       // the state number my controls were last set up for
let answeredSeq = -1;       // the state number I already sent a move for
let lastSeq = -1;           // newest state number drawn
let lastLogId = 0;
let seatKey = '';           // which players the table was last built for
let overShown = false;
let turnDeadline = 0, turnName = '';

// ---------- Which screen is showing ----------
const SCREENS = ['problemView', 'lobbyView', 'tableView'];
const show = name => SCREENS.forEach(id => $(id).classList.toggle('hidden', id !== name));

function problem(title, text, actions = []) {
  show('problemView');
  $('problemTitle').textContent = title;
  $('problemText').textContent = text;
  const box = $('problemActions');
  box.textContent = '';
  actions.forEach(a => {
    const el = document.createElement(a.href ? 'a' : 'button');
    el.className = 'btn small';
    el.textContent = a.label;
    if (a.href) el.href = a.href; else el.onclick = a.onclick;
    box.appendChild(el);
  });
}
const backToRooms = [{ label: 'Back to rooms', href: 'rooms.html' }];

// ---------- Getting into the room ----------
function boot() {
  renderRankings();
  Object.entries(BOT_PROFILES).forEach(([key, p]) => {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = `${p.avatar} ${p.label}`;
    $('botSelect').appendChild(opt);
  });
  setInterval(tickTimer, 250);

  if (LOCAL) return startLocal();
  code = normalizeCode(roomParams.get('code'));
  if (!code) return problem('No room code', 'Open a room from the Rooms page.', backToRooms);
  let started = false;
  onAuth((user, prof) => { if (!started) { started = true; begin(user, prof); } });   // wait until we know who is signed in
}

async function begin(user, prof) {
  if (!user) {
    return problem('Sign in to join this room', 'Rooms need a free account so everyone has a name.', [{ label: 'Sign in', onclick: openAuthDialog }]);
  }
  if (!window.pokerRooms) await new Promise(r => window.addEventListener('pokerrooms-ready', r, { once: true }));
  if (!window.pokerRooms.configured) {
    return problem('Online rooms are not switched on yet', 'The site owner still needs to turn on the Realtime Database (see database.rules.json).', backToRooms);
  }
  net = window.pokerRooms.makeNet();
  myId = user.uid;
  myName = prof.displayName || 'Player';
  try { await joinRoom(); } catch (err) { problem("Couldn't open the room", friendlyRoomError(err), backToRooms); }
}

function friendlyRoomError(err) {
  return /permission/i.test(err.message || '') ? "You don't have access to that room (is the code right?)." : (err.message || String(err));
}

async function joinRoom() {
  const data = await net.getRoom(code);
  if (!data || !data.meta) return problem('Room not found', `There is no room with the code ${code}. Check it and try again.`, backToRooms);
  const seated = data.seats && data.seats[myId];
  if (!seated) {
    if (data.meta.status !== 'lobby') return problem('That game has already started', 'Ask the host to make a new room.', backToRooms);
    const count = Object.keys(data.seats || {}).length + Object.keys(data.bots || {}).length;
    if (count >= MAX_ROOM_SEATS) return problem('That room is full', `Rooms hold up to ${MAX_ROOM_SEATS} players.`, backToRooms);
    await net.joinSeat(code, { name: myName, avatar: '😎', color: colorFor(myId), joinedAt: Date.now() });
  }
  await watchEverything();
  // I'm the host and the game was already running (I refreshed): pick up where the table was
  if (data.meta.host === myId && data.meta.status === 'playing') await resumeHost(data);
}

// One-tab demo: you are the host of a room that already has two bots in it
async function startLocal() {
  const hub = createMemoryHub();
  net = createRoomNet(hub.store('you'));
  myId = 'you';
  myName = typeof profile !== 'undefined' && profile ? profile.displayName : 'You';
  code = await net.createRoom({ hostName: myName, startChips: 1000, sb: 10, turnSeconds: 30, rising: false, handsPerLevel: 10, allowBots: true });
  await net.joinSeat(code, { name: myName, avatar: '😎', color: colorFor(myId), joinedAt: 1 });
  await net.setBots(code, {
    b1: { key: 'shark', name: BOT_PROFILES.shark.names[0] },
    b2: { key: 'fox', name: BOT_PROFILES.fox.names[0] },
  });
  await watchEverything();
}

async function watchEverything() {
  await net.announcePresence(code);
  net.watchPrivate(code, p => { myPrivate = p; if (roomData) render(); });
  net.watchRoom(code, r => { roomData = r; render(); });
}

// ---------- Drawing ----------
function render() {
  if (!roomData || !roomData.meta) {
    if (wasSeated) problem('This room was closed', 'The host closed the room.', backToRooms);
    return;
  }
  const meta = roomData.meta;
  isHost = meta.host === myId;
  $('pageSub').textContent = LOCAL ? 'Local demo' : 'Room ' + code;
  const seated = Boolean(roomData.seats && roomData.seats[myId]);
  if (seated) wasSeated = true;
  else if (wasSeated) return problem('You were removed from the room', 'The host removed you from this room.', backToRooms);
  else return;

  if (meta.status === 'lobby') {
    if (overShown) { overShown = false; $('roomOver').close(); }
    resetTableState();
    show('lobbyView');
    renderLobby();
  } else {
    show('tableView');
    renderGame();
  }
}

// Build a list item with an avatar, a name and a right-hand note
function personRow({ avatar, color, name, small, note }) {
  const li = document.createElement('li');
  li.innerHTML = '<div class="avatar"></div><div class="rname"></div><span class="chips"></span>';   // fixed markup; names are added as text below
  li.querySelector('.avatar').textContent = avatar;
  li.querySelector('.avatar').style.setProperty('--c', color);
  const rname = li.querySelector('.rname');
  rname.append(name);
  if (small) { const s = document.createElement('small'); s.textContent = small; rname.appendChild(s); }
  li.querySelector('.chips').textContent = note || '';
  return li;
}

function removeButton(title, onclick) {
  const x = document.createElement('button');
  x.className = 'x'; x.textContent = '✕'; x.title = title; x.onclick = onclick;
  return x;
}

function renderLobby() {
  const { meta } = roomData;
  const seats = Object.entries(roomData.seats || {}).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));
  const bots = Object.entries(roomData.bots || {});
  const total = seats.length + bots.length;
  const presence = roomData.presence || {};

  $('codeBig').textContent = code;
  $('seatCount').textContent = `(${total}/${MAX_ROOM_SEATS})`;
  const ul = $('lobbyRoster');
  ul.textContent = '';
  seats.forEach(([uid, s]) => {
    const note = uid === meta.host ? 'host' : presence[uid] ? '' : 'offline';
    const li = personRow({ avatar: s.avatar || '😎', color: s.color || '#2f8f5b', name: s.name, small: uid === myId ? 'you' : '', note });
    if (isHost && uid !== myId) li.appendChild(removeButton('Remove ' + s.name, () => net.leaveSeat(code, uid)));
    ul.appendChild(li);
  });
  bots.forEach(([id, b]) => {
    const p = BOT_PROFILES[b.key];
    const li = personRow({ avatar: p.avatar, color: p.color, name: b.name, small: p.label, note: 'bot' });
    if (isHost) li.appendChild(removeButton('Remove ' + b.name, () => removeLobbyBot(id)));
    ul.appendChild(li);
  });

  // Options: only the host can change them
  const set = (el, v) => { if (el.type === 'checkbox') el.checked = Boolean(v); else if (el.value !== String(v)) el.value = String(v); el.disabled = !isHost; };
  set($('optChips'), meta.startChips);
  set($('optBlinds'), meta.sb);
  set($('optTurn'), meta.turnSeconds);
  set($('optRising'), meta.rising);
  set($('optBots'), meta.allowBots !== false);
  $('optsLock').textContent = isHost ? '' : '(only the host can change these)';

  const botsOk = isHost && meta.allowBots !== false;
  $('botBar').classList.toggle('hidden', !botsOk);
  $('btnAddBot').disabled = total >= MAX_ROOM_SEATS;
  $('botHint').textContent = isHost && meta.allowBots === false ? 'Bots are turned off for this room.' : '';

  $('btnStart').classList.toggle('hidden', !isHost);
  $('btnStart').disabled = total < 2;
  $('startHint').textContent = isHost ? (total < 2 ? 'You need at least 2 players.' : '') : 'Waiting for the host to start the game…';
  $('btnLeaveLobby').textContent = isHost ? 'Close room' : 'Leave room';
}

// ---------- Lobby actions ----------
const randomId = () => Math.random().toString(36).slice(2, 7);

async function addLobbyBot() {
  const key = $('botSelect').value;
  const bots = { ...(roomData.bots || {}) };
  const taken = new Set(Object.values(bots).map(b => b.name).concat(Object.values(roomData.seats || {}).map(s => s.name)));
  const profile = BOT_PROFILES[key];
  const name = profile.names.find(n => !taken.has(n)) || `${profile.label} ${randomId()}`;
  bots[randomId()] = { key, name };
  await net.setBots(code, bots);
}

async function removeLobbyBot(id) {
  const bots = { ...(roomData.bots || {}) };
  delete bots[id];
  await net.setBots(code, bots);
}

function optionChanged() {
  if (!isHost) return;
  net.updateMeta(code, {
    startChips: Number($('optChips').value), sb: Number($('optBlinds').value), turnSeconds: Number($('optTurn').value),
    rising: $('optRising').checked, allowBots: $('optBots').checked,
  });
  if (!$('optBots').checked && roomData.bots) net.setBots(code, {});   // turning bots off removes them
}

async function startGame() {
  $('btnStart').disabled = true;
  const r = await net.getRoom(code);
  const total = Object.keys(r.seats || {}).length + Object.keys(r.bots || {}).length;
  if (total < 2) { $('btnStart').disabled = false; return; }
  await net.updateMeta(code, { status: 'playing' });
  launchHost({ ...r.meta, status: 'playing' }, r.seats, r.bots, null);
}

function launchHost(meta, seats, bots, resume) {
  hostCtl = createRoomHost({ net, code, meta, seats, bots, resume });
  hostCtl.run().catch(err => { console.error(err); $('roomNote').textContent = 'The game stopped because of an error: ' + err.message; });
}

async function resumeHost(data) {
  const saved = await net.loadHostState(code);
  if (!saved || !saved.table || saved.status === 'finished') {
    $('roomNote').textContent = "The saved game couldn't be restored. Leave and make a new room.";
    return;
  }
  launchHost(data.meta, data.seats, data.bots, saved);
}

async function leaveLobby() {
  if (isHost) await net.deleteRoom(code); else await net.leaveSeat(code);
  location.href = 'rooms.html';
}

async function leaveGame() {
  if (isHost) {
    if (!confirm('You are the host: leaving ends the game for everyone. Leave anyway?')) return;
    if (hostCtl) hostCtl.stop();
    await net.updateMeta(code, { status: 'finished' });
  } else {
    if (!confirm('Leave the game? You will fold and lose your chips.')) return;
    await net.sendAction(code, { seq: -1, type: 'leave' });
  }
  location.href = 'rooms.html';
}

// ---------- The live table ----------
function resetTableState() {
  controlsSeq = -1; answeredSeq = -1; lastSeq = -1; lastLogId = 0; seatKey = ''; turnDeadline = 0;
  humanResolve = null; handActive = false; tableList = []; board = [];
  document.querySelectorAll('.seat, .bet').forEach(e => e.remove());
  $('log').textContent = '';
}

function renderGame() {
  const { meta, state: st } = roomData;
  if (!st) {
    setMessage(isHost ? 'Dealing…' : 'Waiting for the host…');
    return;
  }
  const view = st.view;
  const me = view.seats.find(s => s.id === myId);

  // A banner when the host (who runs the game) is not connected
  const hostOffline = !isHost && meta.status === 'playing' && !(roomData.presence || {})[meta.host];
  $('roomNote').textContent = hostOffline
    ? '⚠ The host seems to be offline. The game is paused until they come back.'
    : `Room ${code} · blinds ${fmt(view.sb)}/${fmt(view.bb)} · no rebuys, last player with chips wins`;

  // What to draw (see room-view.js), then hand it to table-ui.js
  const shown = tableFromState(view, myId, myPrivate);
  const key = shown.list.map(p => p.id).join(',');
  if (key !== seatKey) { seatKey = key; buildTable(shown.list); } else tableList = shown.list;
  board = shown.board;
  markers = shown.markers;
  activeId = shown.activeId;
  winnerIds = shown.winnerIds;
  handActive = shown.handActive;
  update();
  renderPlayers(view);

  // New log lines
  (st.log || []).filter(l => l.id > lastLogId).forEach(l => { log(l.text, l.cls); lastLogId = l.id; });

  setMessage(shown.message);

  // Everything below only needs doing once per new table state
  if (st.seq !== lastSeq) {
    lastSeq = st.seq;
    const actor = view.seats.find(s => s.id === view.toAct);
    turnName = actor ? (actor.id === myId ? 'Your turn' : actor.name + "'s turn") : '';
    turnDeadline = actor && st.turnMs != null ? performance.now() + st.turnMs : 0;
  }
  if (view.toAct === myId && me && st.seq !== answeredSeq && controlsSeq !== st.seq) {
    controlsSeq = st.seq;
    const L = legalFromView(view, myId);
    humanCtx = L;
    humanResolve = action => { answeredSeq = st.seq; net.sendAction(code, { seq: st.seq, ...action }); };
    setupControls(L);
  } else if (view.toAct !== myId) {
    humanResolve = null;
    setControlsEnabled(false);
  }

  // Game over (the host's game finished, or the host ended it)
  if ((st.status === 'finished' || meta.status === 'finished') && !overShown) showGameOver(st, view);
}

function renderPlayers(view) {
  const ul = $('roster');
  ul.textContent = '';
  const presence = roomData.presence || {};
  view.seats.forEach(s => {
    const small = s.id === myId ? 'you' : s.isBot ? 'bot' : presence[s.id] ? '' : 'offline';
    ul.appendChild(personRow({ avatar: s.avatar, color: s.color, name: s.name, small, note: fmt(s.chips) }));
  });
}

function showGameOver(st, view) {
  overShown = true;
  const winner = view.seats.find(s => s.id === st.winner);
  let text = 'The host ended the game.';
  if (st.endReason === 'last-standing' && winner) text = `${winner.name} won the game with ${fmt(winner.chips)} chips!`;
  else if (st.endReason === 'humans-out' && winner) text = `Every human player is out. ${winner.name} (a bot) was in the lead with ${fmt(winner.chips)} chips.`;
  $('overText').textContent = text;
  $('btnAgain').classList.toggle('hidden', !isHost);
  $('overHint').textContent = isHost ? '' : 'Waiting for the host to open a new lobby, or leave when you like.';
  setControlsEnabled(false);
  $('roomOver').showModal();
}

async function playAgain() {
  hostCtl = null;
  await net.resetRoom(code);
}

// The "Your turn · 12s" countdown
function tickTimer() {
  if (!turnDeadline) { $('turnTimer').textContent = ''; return; }
  const secs = Math.max(0, Math.ceil((turnDeadline - performance.now()) / 1000));
  $('turnTimer').textContent = `⏱ ${turnName} · ${secs}s`;
}

// ---------- Wiring ----------
$('btnAddBot').onclick = addLobbyBot;
['optChips', 'optBlinds', 'optTurn', 'optRising', 'optBots'].forEach(id => { $(id).onchange = optionChanged; });
$('btnStart').onclick = startGame;
$('btnLeaveLobby').onclick = leaveLobby;
$('btnLeaveGame').onclick = leaveGame;
$('btnAgain').onclick = playAgain;
$('btnCopyCode').onclick = () => copyText(code, $('btnCopyCode'));
$('btnCopyLink').onclick = () => copyText(`${location.origin}${location.pathname}?code=${code}`, $('btnCopyLink'));

function copyText(text, button) {
  const done = () => { const old = button.textContent; button.textContent = 'Copied ✓'; setTimeout(() => { button.textContent = old; }, 1500); };
  (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(done, () => window.prompt('Copy this:', text));
}

boot();
