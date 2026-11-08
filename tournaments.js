// tournaments.js — the Tournaments page: the schedule, and Sit & Go tables you can join.
// Names come from users, so everything is filled in with textContent (never innerHTML).

let net = null;
let hostName = '';
let lobby = {};       // the public list as last reported

const setView = name => ['needSignIn', 'notReady', 'tourneyView'].forEach(id => $(id).classList.toggle('hidden', id !== name));
const showError = text => { $('tourneyError').textContent = text; };

async function ready(user, prof) {
  if (!user) return setView('needSignIn');
  if (!window.pokerRooms) await new Promise(r => window.addEventListener('pokerrooms-ready', r, { once: true }));
  if (!window.pokerRooms.configured) return setView('notReady');
  net = window.pokerRooms.makeNet();
  hostName = prof.displayName;
  setView('tourneyView');
  net.watchLobby(all => { lobby = all; draw(); });
  setInterval(draw, 1000);   // the countdowns, and tables whose dealer vanished dropping off the list
}

// A row: a bold title with small text under it, then a right-hand note and a button
function row({ title, small, note, button }) {
  const li = document.createElement('li');
  const info = document.createElement('div');
  info.className = 'grow';
  const b = document.createElement('b'); b.textContent = title;
  const s = document.createElement('small'); s.textContent = small;
  info.append(b, s);
  li.appendChild(info);
  if (note) { const n = document.createElement('span'); n.className = 'seat-count'; n.textContent = note; li.appendChild(n); }
  if (button) li.appendChild(button);
  return li;
}

function linkButton(label, href, enabled = true) {
  const a = document.createElement('a');
  a.className = 'btn small' + (enabled ? '' : ' disabled');
  a.textContent = label;
  if (enabled && href) a.href = href;
  return a;
}

function draw() {
  drawSchedule();
  drawSitAndGos();
  drawLive();
}

// Tournaments that are already under way: you can watch
function drawLive() {
  const list = $('liveList');
  list.textContent = '';
  const live = liveTables(lobby).filter(e => e.kind && e.status === 'playing');
  $('liveEmpty').textContent = live.length ? '' : 'No tournament is being played right now.';
  live.forEach(e => list.appendChild(row({
    title: e.kind === 'sng' ? `${e.hostName || 'Someone'}'s Sit & Go` : `${tourneyLabel(e.startAt)} tournament`,
    small: `${e.seats} players · in progress`, button: linkButton('Watch', `room.html?code=${e.code}&watch=1`),
  })));
}

// The next three scheduled tournaments
function drawSchedule() {
  const list = $('slotList');
  list.textContent = '';
  const now = Date.now();
  const tables = liveTables(lobby);
  const first = nextTourneyStart(new Date(now));
  for (let i = 0; i < 3; i++) {
    const start = first + i * TOURNEY_EVERY_HOURS * 3600000;   // const: each button keeps its own slot
    const code = tourneyCode(start);
    const entry = tables.find(e => e.code === code);
    const registered = entry ? entry.seats : 0;
    const open = tourneyRegistrationOpen(start, now);
    const opensIn = start - TOURNEY_OPENS_MINUTES * 60000 - now;
    const small = open ? `Registration is open · starts in ${countdownText(start - now)}`
      : `Registration opens in ${countdownText(opensIn)}`;
    const btn = document.createElement('button');
    btn.className = 'btn small' + (open ? ' deal' : '');
    btn.textContent = open ? 'Register' : 'Not yet';
    btn.disabled = !open || registered >= TOURNEY_MAX_PLAYERS;
    btn.onclick = () => go(() => registerScheduled(net, start, hostName));
    list.appendChild(row({ title: `${tourneyLabel(start)} tournament`, small, note: open ? `${registered} registered` : '', button: btn }));
  }
}

// Sit & Go tables that are still waiting for players
function drawSitAndGos() {
  const list = $('sngList');
  list.textContent = '';
  const tables = liveTables(lobby).filter(e => e.kind === 'sng' && e.status === 'lobby');
  $('sngEmpty').textContent = tables.length ? '' : 'No Sit & Go is waiting for players right now.';
  tables.forEach(e => {
    const full = e.seats >= e.max;
    list.appendChild(row({
      title: `${e.hostName || 'Someone'}'s Sit & Go`, small: `${e.max} players · starts when full`,
      note: `${e.seats}/${e.max}`, button: linkButton(full ? 'Full' : 'Join', `room.html?code=${e.code}`, !full),
    }));
  });
}

async function go(getCode) {
  showError('');
  try { location.href = `room.html?code=${await getCode()}`; }
  catch (err) { showError(err.message || String(err)); }
}

$('btnSignIn').onclick = openAuthDialog;
$('btnQuick').onclick = () => go(() => quickSitAndGo(net, hostName));
$('btnCreate').onclick = () => go(() => net.createRoom(tournamentMeta('sng', hostName, { size: Number($('sngSize').value), allowBots: $('sngBots').checked })));
onAuth(ready);
