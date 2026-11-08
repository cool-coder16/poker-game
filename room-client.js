// room-client.js — the room page: a lobby while players gather (private rooms), then the live table.
// It never runs the game itself (room-host.js does that, in the dealer's browser). It watches the
// room through room-net.js, draws the table with table-ui.js, and sends your moves back.
//
// room.html?code=ABCDE        joins a real room, open table or arena table.
// room.html?local             one-tab demo of a private room (with bots, no network).
// room.html?local=open|arena|sng  one-tab demo of an open table / arena table / Sit & Go.
//
// Remember: the database drops empty arrays, so anything that might be empty is read with `|| []`.

const roomParams = new URLSearchParams(location.search);
const LOCAL = roomParams.has('local');
const MAX_ROOM_SEATS = 8;
const CLAIM_DELAY_MS = 12000;   // how long the dealer must be gone before another player takes over
const SEAT_COLORS = ['#2f8f5b', '#c4572b', '#2b6fc4', '#8e5bd6', '#d6a52b', '#2bb5c4', '#d62b7a', '#6b7a90'];
const colorFor = uid => SEAT_COLORS[[...uid].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % SEAT_COLORS.length];
const isContinuous = meta => Boolean(meta) && (meta.mode === 'open' || meta.mode === 'arena');   // no lobby, people come and go
const isTournament = meta => Boolean(meta) && (meta.kind === 'sng' || meta.kind === 'scheduled');   // Sit & Go or scheduled

let code = '';
let net = null;
let myId = null, myName = '';
let roomData = null;        // everything public about the room: { meta, seats, bots, state, presence }
let myPrivate = null;       // { handNo, hole } my two cards, readable only by me
let isHost = false;
let hostCtl = null;         // the dealer (room-host.js) if I'm the host
let hostStarting = false;   // true while the dealer is being set up, so we never start two
let claimTimer = null;      // set when the dealer has gone: we will take over if they don't come back
let wasSeated = false;
let spectating = false;    // watching without a seat
let controlsSeq = -1;       // the state number my controls were last set up for
let answeredSeq = -1;       // the state number I already sent a move for
let lastSeq = -1;           // newest state number drawn
let lastLogId = 0;
let seatKey = '';           // which players the table was last built for
let overShown = false;
let chatNoticeUntil = 0;   // a notice like "Slow down" stays visible until this time, even if the page redraws
let chatMessages = [], chatBlocked = loadBlocked(), lastChatSent = 0, lastChatSeen = '', chatUnread = 0, chatOpen = false;   // chat (see chat.js)
let lobbyBeat = null;         // timer that keeps a tournament's line in the public list fresh while it is still gathering players
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
  setInterval(tick, 250);

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
  const meta = data.meta;
  const seated = data.seats && data.seats[myId];
  if (!seated) {
    if (meta.status === 'finished') return problem('That table has closed', 'The game there is over.', backToRooms);
    const count = Object.keys(data.seats || {}).length + (isContinuous(meta) ? 0 : Object.keys(data.bots || {}).length);
    const full = count >= (meta.maxSeats || MAX_ROOM_SEATS);
    const canSit = !roomParams.has('watch') && !full && (meta.status === 'lobby' || isContinuous(meta));
    if (canSit) await net.joinSeat(code, { name: myName, avatar: '😎', color: colorFor(myId), joinedAt: Date.now() });
    else spectating = true;   // a full table, a game already under way, or you asked to watch: just watch
  }
  await watchEverything();
  if (meta.arena && !spectating) net.markArenaPlayed(meta.arena).catch(() => {});   // so the site counts this Arena toward your rating later
  if (isTournament(meta) && !LOCAL && !spectating) net.markTourneyPlayed(code).catch(() => {});   // and this tournament
  // I'm the dealer. A private room that was already running (I refreshed) resumes; open and arena tables start or resume.
  if (meta.host === myId && (isContinuous(meta) || meta.status === 'playing')) await startOrResumeHost();
}

// One-tab demo. ?local = private room, ?local=open or ?local=arena = a table where you are the dealer. Bots keep you company.
async function startLocal() {
  const kind = roomParams.get('local');   // '' | 'open' | 'arena'
  const hub = createMemoryHub();
  net = createRoomNet(hub.store('you'));
  myId = 'you';
  myName = typeof profile !== 'undefined' && profile ? profile.displayName : 'You';
  const rounds = Number(roomParams.get('rounds'));   // ?local=arena&rounds=3 makes rounds short, handy for trying it out
  const meta = kind === 'sng'
    ? tournamentMeta('sng', myName, { size: 3, allowBots: true })   // a 3-player Sit & Go: you and two bots, so it starts at once
    : kind
    ? { ...tableMeta(kind, myName, rounds >= 2 ? { roundHands: rounds } : {}), allowBots: true }
    : { hostName: myName, startChips: 1000, sb: 10, turnSeconds: 30, rising: false, handsPerLevel: 10, allowBots: true };
  if (roomParams.has('watch')) return startLocalWatch(hub, kind || 'open');   // ?local=open&watch: you only watch a table that someone else deals
  code = await net.createRoom(meta);
  await net.joinSeat(code, { name: myName, avatar: '😎', color: colorFor(myId), joinedAt: 1 });
  await net.setBots(code, {
    b1: { key: 'shark', name: BOT_PROFILES.shark.names[0] },
    b2: { key: 'fox', name: BOT_PROFILES.fox.names[0] },
  });
  await watchEverything();
  if (kind === 'open' || kind === 'arena') await startOrResumeHost();   // (a demo Sit & Go starts itself, like a real one)
}

// Demo: a pretend player called "Host" deals an open table and plays (checking and calling), with two bots.
// You are a spectator, and you can chat with them. This is how the spectator view and chat are tried out in one tab.
async function startLocalWatch(hub, kind) {
  const hostNet = createRoomNet(hub.store('host'));
  code = await hostNet.createRoom({ ...tableMeta(kind, 'Host', kind === 'arena' ? { roundHands: 3 } : {}), allowBots: true });
  await hostNet.joinSeat(code, { name: 'Host', avatar: '🎩', color: '#c4572b', joinedAt: 1 });
  await hostNet.setBots(code, {
    b1: { key: 'shark', name: BOT_PROFILES.shark.names[0] },
    b2: { key: 'fox', name: BOT_PROFILES.fox.names[0] },
  });
  await hostNet.announcePresence(code);
  const room = await hostNet.getRoom(code);
  hostNet.watchRoom(code, r => {   // the pretend host just checks or calls
    const st = r && r.state;
    if (st && st.view.toAct === 'host') hostNet.sendAction(code, { seq: st.seq, type: 'call' });
  });
  createRoomHost({ net: hostNet, code, meta: room.meta, seats: room.seats, bots: room.bots }).run();
  hostNet.sendChat(code, 'Host', 'Welcome! You are watching this table.');
  spectating = true;
  await watchEverything();
}

async function watchEverything() {
  if (spectating) await net.announceWatcher(code, myName);   // counted as watching; no seat, so no private cards to read
  else {
    await net.announcePresence(code);
    net.watchPrivate(code, p => { myPrivate = p; if (roomData) render(); });
  }
  net.watchRoom(code, r => { roomData = r; render(); });
  initChat();
}

// A spectator takes a free seat at an open or arena table
async function sitDown() {
  $('btnSit').disabled = true;
  try {
    await net.joinSeat(code, { name: myName, avatar: '😎', color: colorFor(myId), joinedAt: Date.now() });
    await net.stopWatching(code);
    await net.announcePresence(code);
    net.watchPrivate(code, p => { myPrivate = p; if (roomData) render(); });
    if (roomData.meta.arena) net.markArenaPlayed(roomData.meta.arena).catch(() => {});
  } catch (err) {
    $('roomNote').textContent = "Couldn't sit down: " + (err.message || err);
  }
  $('btnSit').disabled = false;
}

// ---------- Being the dealer ----------
function launchHost(meta, seats, bots, resume) {
  hostCtl = createRoomHost({ net, code, meta, seats, bots, resume });
  hostCtl.run().catch(err => { console.error(err); $('roomNote').textContent = 'The game stopped because of an error: ' + err.message; });
}

// Start dealing: carry on from the saved table if there is one, or (open and arena tables) begin a new one
async function startOrResumeHost() {
  if (hostCtl || hostStarting) return;
  hostStarting = true;
  try {
    const fresh = await net.getRoom(code);
    const saved = await net.loadHostState(code);
    if (saved && saved.table && saved.status !== 'finished') launchHost(fresh.meta, fresh.seats, fresh.bots, saved);
    else if (isContinuous(fresh.meta) && fresh.meta.status !== 'finished') launchHost(fresh.meta, fresh.seats, fresh.bots, null);
    else $('roomNote').textContent = "The saved game couldn't be restored. Leave and make a new room.";
  } finally { hostStarting = false; }
}

// If the dealer has gone, a seated player takes over after a pause. The database rules only allow this
// when the dealer really is disconnected. The new dealer carries on from the table the old one saved.
function watchTheDealer(meta, seated) {
  const dealerGone = !isHost && seated && meta.status !== 'finished' && !(roomData.presence || {})[meta.host];
  if (dealerGone && !claimTimer) {
    claimTimer = setTimeout(async () => {
      claimTimer = null;
      if (!roomData || (roomData.presence || {})[roomData.meta.host]) return;   // they came back
      try { await net.setHost(code, myId); } catch (err) { /* someone else got there first */ }
    }, CLAIM_DELAY_MS + Math.random() * 3000);   // a little random, so players don't all try at once
  } else if (!dealerGone && claimTimer) {
    clearTimeout(claimTimer);
    claimTimer = null;
  }
}

// ---------- Drawing ----------
const MODE_TITLES = { open: 'Open table ', arena: 'Arena table ' };

function render() {
  if (!roomData || !roomData.meta) {
    if (wasSeated) problem('This room was closed', 'The host closed the room.', backToRooms);
    return;
  }
  const meta = roomData.meta;
  isHost = meta.host === myId;
  $('pageSub').textContent = LOCAL ? 'Local demo' : (MODE_TITLES[meta.mode] || 'Room ') + code;
  const seated = Boolean(roomData.seats && roomData.seats[myId]);
  if (seated) { wasSeated = true; spectating = false; }   // (sitting down at an open table ends spectating)
  else if (wasSeated) return problem('You were removed from the room', 'The host removed you from this room.', backToRooms);
  else if (!spectating) return;
  renderChatState();

  // Dealing duties follow meta.host: take them up when named, drop them when someone else is
  if (hostCtl && !isHost) { hostCtl.stop(); hostCtl = null; }
  if (isHost && !hostCtl && !hostStarting && meta.status !== 'lobby' && meta.status !== 'finished') startOrResumeHost();
  watchTheDealer(meta, seated);

  if (meta.status === 'finished' && isTournament(meta) && !roomData.state) {
    return problem('This tournament was cancelled', 'Not enough players showed up. Try the next one!', [{ label: 'Tournaments', href: 'tournaments.html' }]);
  }
  if (meta.status === 'lobby') {
    if (overShown) { overShown = false; $('roomOver').close(); }
    resetTableState();
    show('lobbyView');
    renderLobby();
    lobbyHostDuties(meta);
  } else {
    stopLobbyBeat();
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

  // Tournaments have fixed rules and start by themselves
  const tourney = isTournament(meta);
  $('tourneyBox').classList.toggle('hidden', !tourney);
  $('optionsPanel').classList.toggle('hidden', tourney);
  if (tourney) renderTourneyBox(meta, total);

  $('btnStart').classList.toggle('hidden', !isHost || tourney);
  $('btnStart').disabled = total < 2;
  $('startHint').textContent = spectating ? 'You are watching.' : tourney ? '' : isHost ? (total < 2 ? 'You need at least 2 players.' : '') : 'Waiting for the host to start the game…';
  $('btnLeaveLobby').textContent = spectating ? 'Stop watching' : isHost ? 'Close room' : 'Leave room';
}

// ---------- Tournaments: the lobby ----------
const humansHere = () => Object.keys(roomData.seats || {}).filter(uid => (roomData.presence || {})[uid]).length;

function renderTourneyBox(meta, total) {
  const sng = meta.kind === 'sng';
  $('tourneyTitle').textContent = sng ? `Sit & Go · ${meta.size} players` : `Scheduled tournament · ${tourneyLabel(meta.startAt)}`;
  const left = sng ? null : countdownText(meta.startAt - Date.now());
  $('tourneyInfo').textContent = sng
    ? `Starts as soon as the table is full: ${total} of ${meta.size} seated.`
    : (Date.now() < meta.startAt
      ? `Starts in ${left}. ${total} registered; needs at least ${meta.minPlayers || TOURNEY_MIN_PLAYERS} to run (up to ${meta.size}).`
      : 'Starting…');
  $('tourneyRules').textContent = `Freezeout: ${fmt(meta.startChips)} chips each, blinds ${meta.sb}/${meta.sb * 2} rising every ${meta.handsPerLevel} hands, no rebuys. `
    + 'Top 3 earn rating points (needs at least 3 human players; bots never earn points).';
}

// The host of a tournament lobby: keep the public list fresh, and start (or cancel) when it's time
function lobbyHostDuties(meta) {
  if (!isHost || !isTournament(meta)) { stopLobbyBeat(); return; }
  if (!lobbyBeat) {
    publishLobbyLine();
    lobbyBeat = setInterval(publishLobbyLine, 20000);
  }
  maybeStartTournament();
}

function stopLobbyBeat() { if (lobbyBeat) { clearInterval(lobbyBeat); lobbyBeat = null; } }

function publishLobbyLine() {
  if (!roomData || !roomData.meta || roomData.meta.status !== 'lobby') return;
  const meta = roomData.meta;
  net.publishLobby(code, makeListing({
    code, meta, hostName: myName, status: 'lobby', humans: Object.keys(roomData.seats || {}).length,
    bots: Object.keys(roomData.bots || {}).length, sb: meta.sb, max: meta.size,
  })).catch(() => {});
}

// Ask tournament.js what to do: wait, start (full table / start time reached) or cancel (start time reached with too few)
async function maybeStartTournament() {
  if (!roomData || !isHost || hostStarting || roomData.meta.status !== 'lobby' || !isTournament(roomData.meta)) return;
  const total = Object.keys(roomData.seats || {}).length + Object.keys(roomData.bots || {}).length;
  const action = tourneyAction(roomData.meta, humansHere() + Object.keys(roomData.bots || {}).length, total);
  if (action === 'wait') return;
  hostStarting = true;
  try {
    if (action === 'cancel') {
      await net.updateMeta(code, { status: 'finished' });
      await net.removeLobby(code);
      return;
    }
    // A scheduled tournament starts with whoever is actually here: people who registered and left are removed first
    if (roomData.meta.kind === 'scheduled') {
      const gone = Object.keys(roomData.seats || {}).filter(uid => !(roomData.presence || {})[uid]);
      await Promise.all(gone.map(uid => net.leaveSeat(code, uid)));
    }
  } finally { hostStarting = false; }
  await startGame();
}

// ---------- Lobby actions (private rooms) ----------
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
  hostStarting = true;   // so render() doesn't also try to start the dealer when the status flips
  try {
    const r = await net.getRoom(code);
    const total = Object.keys(r.seats || {}).length + Object.keys(r.bots || {}).length;
    if (total < 2) { $('btnStart').disabled = false; return; }
    await net.updateMeta(code, { status: 'playing' });
    launchHost({ ...r.meta, status: 'playing' }, r.seats, r.bots, null);
  } finally { hostStarting = false; }
}

async function leaveLobby() {
  if (spectating) { await net.stopWatching(code); location.href = 'rooms.html'; return; }
  if (isHost) {
    // A tournament lobby has other people waiting: hand it to one of them. Otherwise close the room.
    const next = isTournament(roomData.meta) && Object.entries(roomData.seats || {})
      .filter(([uid]) => uid !== myId && (roomData.presence || {})[uid])
      .sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0))[0];
    if (next) { stopLobbyBeat(); await net.setHost(code, next[0]); await net.leaveSeat(code); }
    else { stopLobbyBeat(); await net.removeLobby(code).catch(() => {}); await net.deleteRoom(code); }
  } else await net.leaveSeat(code);
  location.href = 'rooms.html';
}

// ---------- Leaving a game in progress ----------
async function leaveGame() {
  const meta = roomData.meta;
  if (spectating) { await net.stopWatching(code); location.href = 'rooms.html'; return; }
  if (isContinuous(meta)) {
    if (!confirm('Leave this table? You take your chips with you.')) return;
    if (isHost) {
      // Hand the dealing to another connected player; if I'm alone, close the table
      const next = Object.entries(roomData.seats || {})
        .filter(([uid]) => uid !== myId && (roomData.presence || {})[uid])
        .sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0))[0];
      if (next) {
        if (hostCtl) { hostCtl.stop(); hostCtl = null; }
        await net.setHost(code, next[0]);
      } else {
        if (hostCtl) await hostCtl.close();
        await net.deleteRoom(code);
        location.href = 'rooms.html';
        return;
      }
    } else {
      await net.sendAction(code, { seq: -1, type: 'leave' });   // folds me if it's my turn
    }
    await net.leaveSeat(code);
  } else if (isHost) {
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

// The line above the table: what kind of table this is, and its blinds / round / clock
let noteContext = null;   // { meta, st, view, hostOffline, waitingToSit, watching } from the latest draw (the arena clock re-uses it every tick)

function noteText() {
  const { meta, st, view, hostOffline, waitingToSit, watching } = noteContext;
  if (hostOffline) return '⚠ The dealer seems to be offline. Another player will take over in a few seconds…';
  let text;
  if (meta.mode === 'arena') {
    const where = st.round ? `round ${st.round.n}, hand ${Math.min(st.round.hands + 1, st.round.of)} of ${st.round.of}` : 'between rounds';
    text = `Arena ${arenaLabel(meta.arena)} · ${where} · arena ends in ${countdownText(meta.arenaEnd - Date.now())}`;
    if (meta.fillBots) text += ' · bots fill empty seats (they never score)';
  } else if (meta.mode === 'open') {
    text = `Open table · blinds ${fmt(view.sb)}/${fmt(view.bb)} · sit down or leave any time · rebuy if you bust`;
  } else {
    const title = meta.kind === 'sng' ? 'Sit & Go' : meta.kind === 'scheduled' ? `Tournament ${tourneyLabel(meta.startAt)}` : `Room ${code}`;
    text = `${title} · blinds ${fmt(view.sb)}/${fmt(view.bb)} · no rebuys, last player with chips wins`;
  }
  if (waitingToSit) text += meta.mode === 'arena' ? ' · you play from the next round' : ' · you are dealt in at the next hand';
  if (watching) text += ' · you are watching';
  const watchers = Object.keys(roomData.watchers || {}).length;
  if (watchers) text += ` · 👁 ${watchers} watching`;
  return text;
}

function renderGame() {
  const { meta, state: st } = roomData;
  if (!st) {
    setMessage(isHost ? 'Setting up the table…' : 'Waiting for the host…');
    renderSeatsOnly();
    return;
  }
  const view = st.view;
  const me = view.seats.find(s => s.id === myId);

  // The note above the table; a banner when the dealer (who runs the game) is not connected
  noteContext = {
    meta, st, view,
    hostOffline: !isHost && meta.status === 'playing' && !(roomData.presence || {})[meta.host],
    waitingToSit: !me && !spectating,   // I have a seat but the dealer hasn't dealt me in yet
    watching: spectating,
  };
  $('roomNote').textContent = noteText();

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

  // The message under the pot
  let message = shown.message;
  if (st.status === 'waiting') message = meta.mode === 'arena' ? 'Waiting for another player…' : 'Waiting for more players…';
  if (meta.mode === 'arena' && !st.round && st.roundResult) {
    message = `Round ${st.roundResult.n}: ` + st.roundResult.rows.map(r => `${r.name} +${r.points}`).join(' · ');
  }
  setMessage(message);

  // Spectators: the leave button says so, and at open/arena tables they can take a free seat
  $('btnLeaveGame').textContent = spectating ? 'Stop watching' : 'Leave game';
  const seatedHumans = Object.keys(roomData.seats || {}).length;
  $('btnSit').classList.toggle('hidden', !(spectating && isContinuous(meta) && meta.status !== 'finished' && seatedHumans < (meta.maxSeats || 6)));

  // The rebuy button (open tables): when I'm out of chips
  $('btnRebuy').classList.toggle('hidden', !(meta.mode === 'open' && me && me.chips === 0 && !me.inHand));

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

  // Game over (the host's game finished, the arena ended, or the host closed the table)
  if ((st.status === 'finished' || meta.status === 'finished') && !overShown) showGameOver(st, view, meta);
}

// Before the first state arrives (an open table that is just starting): list who is sitting here
function renderSeatsOnly() {
  const ul = $('roster');
  ul.textContent = '';
  Object.values(roomData.seats || {}).forEach(s => ul.appendChild(personRow({ avatar: s.avatar || '😎', color: s.color || '#2f8f5b', name: s.name })));
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

function showGameOver(st, view, meta) {
  overShown = true;
  const winner = view.seats.find(s => s.id === st.winner);
  let text = isContinuous(meta) ? 'This table has closed.' : 'The host ended the game.';
  if (st.endReason === 'last-standing' && winner) text = `${winner.name} won the game with ${fmt(winner.chips)} chips!`;
  else if (st.endReason === 'humans-out' && winner) text = `Every human player is out. ${winner.name} (a bot) was in the lead with ${fmt(winner.chips)} chips.`;
  else if (st.endReason === 'arena-over') text = 'The arena is over. Check the standings to see where you finished!';
  $('overText').textContent = text;
  renderStandings(st.places, meta);
  const arenaOver = st.endReason === 'arena-over';
  $('overLink').textContent = arenaOver ? 'Arena standings' : 'Back to rooms';
  $('overLink').href = arenaOver ? 'arena.html' : 'rooms.html';
  $('btnAgain').classList.toggle('hidden', !isHost || isContinuous(meta));
  $('overHint').textContent = isHost || isContinuous(meta) ? '' : 'Waiting for the host to open a new lobby, or leave when you like.';
  setControlsEnabled(false);
  $('roomOver').showModal();
}

// The final standings, with the rating points a tournament pays (counted the next time you open the site)
function renderStandings(places, meta) {
  const ol = $('overPlaces');
  ol.textContent = '';
  (places || []).forEach(p => {
    const li = document.createElement('li');
    li.textContent = p.name + (p.isBot ? ' (bot)' : '');
    if (isTournament(meta) && !p.isBot) {
      const humans = (places || []).filter(x => !x.isBot);
      const points = tournamentPoints(humans.findIndex(x => x.id === p.id) + 1, humans.length);
      if (points) { const tag = document.createElement('b'); tag.textContent = ` +${points} rating`; li.appendChild(tag); }
    }
    if (p.id === myId) li.className = 'me';
    ol.appendChild(li);
  });
}

async function playAgain() {
  hostCtl = null;
  await net.resetRoom(code);
}

// Runs four times a second: the "Your turn · 12s" countdown, and the arena clock
function tick() {
  if (!turnDeadline) { $('turnTimer').textContent = ''; }
  else {
    const secs = Math.max(0, Math.ceil((turnDeadline - performance.now()) / 1000));
    $('turnTimer').textContent = `⏱ ${turnName} · ${secs}s`;
  }
  if (noteContext && noteContext.meta.mode === 'arena') $('roomNote').textContent = noteText();
  if (roomData && roomData.meta && roomData.meta.status === 'lobby' && isTournament(roomData.meta)) {
    renderTourneyBox(roomData.meta, Object.keys(roomData.seats || {}).length + Object.keys(roomData.bots || {}).length);   // the countdown
    maybeStartTournament();                                                                                              // the host starts it on time
  }
}

// ---------- Chat ----------
const CHAT_DEFAULT_HINT = 'Be kind. Everyone at this table can read this.';
// Names and messages come from users, so they are only ever added as text (never as HTML).
function initChat() {
  $('chat').classList.remove('hidden');
  net.watchChat(code, CHAT_SHOWN, list => {
    const fresh = list.filter(m => m.id > lastChatSeen && m.uid !== myId && !chatBlocked.includes(m.uid));
    if (list.length) lastChatSeen = list[list.length - 1].id;
    if (!chatOpen) chatUnread += fresh.length;
    chatMessages = list;
    renderChat();
  });
}

function iconButton(text, title, onclick) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'chat-icon'; b.textContent = text; b.title = title; b.onclick = onclick;
  return b;
}

function renderChat() {
  const ul = $('chatList');
  const nearBottom = ul.scrollHeight - ul.scrollTop - ul.clientHeight < 60;
  ul.textContent = '';
  chatVisible(chatMessages, chatBlocked).forEach(m => {
    const li = document.createElement('li');
    if (m.uid === myId) li.className = 'mine';
    const name = document.createElement('b');
    name.textContent = m.name;
    li.append(name, ' ', document.createTextNode(m.text));
    if (m.uid !== myId) li.appendChild(iconButton('🚫', `Hide ${m.name} (only for you)`, () => { chatBlocked.push(m.uid); saveBlocked(chatBlocked); renderChat(); }));
    if (isHost && m.uid !== myId) li.appendChild(iconButton('🔇', `Mute ${m.name} for everyone`, () => net.setMuted(code, m.uid, true)));
    if (isHost) li.appendChild(iconButton('🗑', 'Delete this message', () => net.deleteChatMessage(code, m.id)));
    ul.appendChild(li);
  });
  if (nearBottom) ul.scrollTop = ul.scrollHeight;
  $('chatBadge').textContent = chatUnread;
  $('chatBadge').classList.toggle('hidden', chatUnread === 0 || chatOpen);
}

// Whether you can type right now (chat switched off, or you were muted), and the host's tools
function renderChatState() {
  if (!roomData || !roomData.meta) return;
  const gate = chatAllowed(roomData.meta, roomData.muted, myId);
  $('chatInput').disabled = !gate.ok;
  $('chatSend').disabled = !gate.ok;
  if (!gate.ok || Date.now() > chatNoticeUntil) $('chatHint').textContent = gate.ok ? CHAT_DEFAULT_HINT : gate.reason;
  const tools = $('chatTools');
  tools.textContent = '';
  if (isHost) {
    const on = roomData.meta.chat !== false;
    const toggle = document.createElement('button');
    toggle.type = 'button'; toggle.className = 'linkbtn'; toggle.textContent = on ? 'Turn chat off' : 'Turn chat on';
    toggle.onclick = () => net.setChatOn(code, !on);
    const clear = document.createElement('button');
    clear.type = 'button'; clear.className = 'linkbtn'; clear.textContent = 'Clear';
    clear.onclick = () => net.clearChat(code);
    tools.append(toggle, clear);
  }
}

async function sendChatMessage(e) {
  e.preventDefault();
  const text = cleanChatText($('chatInput').value);
  if (!text) return;
  const gate = chatAllowed(roomData.meta, roomData.muted, myId);
  if (!gate.ok) { $('chatHint').textContent = gate.reason; return; }
  const wait = chatCooldownLeft(lastChatSent);
  if (wait > 0) { chatNotice('Slow down a little…', wait + 300); return; }
  lastChatSent = Date.now();
  $('chatInput').value = '';
  try { await net.sendChat(code, myName, text); }
  catch (err) { $('chatInput').value = text; chatNotice("That message wasn't sent. Try again in a moment.", 4000); }
}

// Show a short notice under the chat box, then go back to the usual line
function chatNotice(text, ms) {
  chatNoticeUntil = Date.now() + ms;
  $('chatHint').textContent = text;
  setTimeout(renderChatState, ms + 50);
}

function toggleChat() {
  chatOpen = !chatOpen;
  $('chatBox').classList.toggle('hidden', !chatOpen);
  if (chatOpen) { chatUnread = 0; renderChat(); $('chatList').scrollTop = $('chatList').scrollHeight; $('chatInput').focus(); }
  else renderChat();
}

// ---------- Wiring ----------
$('btnAddBot').onclick = addLobbyBot;
['optChips', 'optBlinds', 'optTurn', 'optRising', 'optBots'].forEach(id => { $(id).onchange = optionChanged; });
$('btnStart').onclick = startGame;
$('btnLeaveLobby').onclick = leaveLobby;
$('btnLeaveGame').onclick = leaveGame;
$('btnAgain').onclick = playAgain;
$('btnSit').onclick = sitDown;
$('chatToggle').onclick = toggleChat;
$('chatForm').onsubmit = sendChatMessage;
$('btnRebuy').onclick = () => { $('btnRebuy').classList.add('hidden'); net.sendAction(code, { seq: -1, type: 'rebuy' }); };
$('btnCopyCode').onclick = () => copyText(code, $('btnCopyCode'));
$('btnCopyLink').onclick = () => copyText(`${location.origin}${location.pathname}?code=${code}`, $('btnCopyLink'));

function copyText(text, button) {
  const done = () => { const old = button.textContent; button.textContent = 'Copied ✓'; setTimeout(() => { button.textContent = old; }, 1500); };
  (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(done, () => window.prompt('Copy this:', text));
}

boot();
