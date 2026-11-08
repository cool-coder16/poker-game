// arena-page.js — the Arena page: the clock, the live standings, the tables, and last Arena's results.
// Names come from users, so everything is filled in with textContent (never innerHTML).

let net = null;
let hostName = '';
let lobby = {};
let win = arenaWindow();      // the Arena window we are showing: { id, start, end }
let unwatchNow = null, unwatchLast = null;
let nowTables = {}, lastTables = null;

const setView = name => ['needSignIn', 'notReady', 'arenaView'].forEach(id => $(id).classList.toggle('hidden', id !== name));
const showError = text => { $('arenaError').textContent = text; };

async function ready(user, prof) {
  if (!user) return setView('needSignIn');
  if (!window.pokerRooms) await new Promise(r => window.addEventListener('pokerrooms-ready', r, { once: true }));
  if (!window.pokerRooms.configured) return setView('notReady');
  net = window.pokerRooms.makeNet();
  hostName = prof.displayName;
  setView('arenaView');
  net.watchLobby(all => { lobby = all; drawTables(); });
  watchWindow();
  setInterval(tickClock, 1000);
}

// Subscribe to this window's scores and the previous window's results (and again when a new window starts)
function watchWindow() {
  if (unwatchNow) unwatchNow();
  if (unwatchLast) unwatchLast();
  const previous = arenaWindow(new Date(win.start - 1));
  nowTables = {}; lastTables = null;
  unwatchNow = net.watchArena(win.id, tables => { nowTables = tables; drawStandings(); });
  unwatchLast = net.watchArena(previous.id, tables => { lastTables = tables; drawLast(previous); });
  $('arenaName').textContent = arenaLabel(win.id);
  drawStandings();
}

function tickClock() {
  const now = Date.now();
  if (now >= win.end) { win = arenaWindow(); watchWindow(); }   // a new Arena has started
  const left = win.end - now;
  $('arenaClock').textContent = `${arenaLabel(win.id)} · ends in ${countdownText(left)} · next Arena at ${arenaLabel(arenaWindow(new Date(win.end)).id)}`;
  // Not worth joining in the last minute: the round would not finish
  const tooLate = left < 60000;
  $('btnQuick').disabled = $('btnCreate').disabled = tooLate;
  $('joinHint').textContent = tooLate ? 'Almost over. Join the next Arena in a minute!' : '"Join the Arena" seats you at the fullest table with room, or starts a new one.';
}

// ---------- Tables ----------
function drawTables() {
  const list = $('tableList');
  list.textContent = '';
  const tables = liveTables(lobby).filter(e => e.mode === 'arena' && e.arena === win.id);
  $('tableEmpty').textContent = tables.length ? '' : 'No tables yet. Start one!';
  tables.forEach(e => {
    const li = document.createElement('li');
    const info = document.createElement('div');
    info.className = 'grow';
    const title = document.createElement('b');
    title.textContent = `${e.hostName || 'Someone'}'s table`;
    info.appendChild(title);
    const seats = document.createElement('span');
    seats.className = 'seat-count';
    seats.textContent = `${e.seats}/${e.max}`;
    const join = document.createElement('a');
    const full = e.seats >= e.max;
    join.className = 'btn small' + (full ? ' disabled' : '');
    join.textContent = full ? 'Full' : 'Sit down';
    if (!full) join.href = `room.html?code=${e.code}`;
    const watch = document.createElement('a');
    watch.className = 'linkbtn';
    watch.textContent = 'Watch';
    watch.href = `room.html?code=${e.code}&watch=1`;
    li.append(info, seats, watch, join);
    list.appendChild(li);
  });
}

// ---------- Standings ----------
function fillStandings(table, rows, mineId) {
  table.textContent = '';
  const head = document.createElement('tr');
  ['#', 'Player', 'Points', 'Rounds', 'Wins'].forEach(t => { const th = document.createElement('th'); th.textContent = t; head.appendChild(th); });
  table.appendChild(head);
  rows.slice(0, 20).forEach((r, i) => {
    const tr = document.createElement('tr');
    if (r.uid === mineId) tr.className = 'me';
    [['rank', ['🥇', '🥈', '🥉'][i] || String(i + 1)], ['name', r.name], ['', fmt(r.points)], ['', fmt(r.rounds)], ['', fmt(r.wins)]].forEach(([cls, text]) => {
      const td = document.createElement('td');
      td.textContent = text;
      if (cls) td.className = cls;
      tr.appendChild(td);
    });
    table.appendChild(tr);
  });
}

function drawStandings() {
  const rows = aggregateArena(nowTables);
  fillStandings($('standings'), rows, typeof currentUser !== 'undefined' && currentUser ? currentUser.uid : null);
  $('standingsMsg').textContent = rows.length ? '' : 'Nobody has scored yet. Play a round!';
  const mine = rows.findIndex(r => currentUser && r.uid === currentUser.uid);
  $('myScore').textContent = mine === -1 ? '' : `(you: ${fmt(rows[mine].points)} pts, #${mine + 1})`;
}

function drawLast(previous) {
  $('lastTitle').textContent = `Last Arena (${arenaLabel(previous.id)})`;
  if (lastTables === null) return;
  const rows = aggregateArena(lastTables);
  fillStandings($('lastStandings'), rows, typeof currentUser !== 'undefined' && currentUser ? currentUser.uid : null);
  $('lastMsg').textContent = rows.length ? '' : 'Nobody played in the last Arena.';
}

// ---------- Joining ----------
async function go(getCode) {
  showError('');
  $('btnQuick').disabled = $('btnCreate').disabled = true;
  try { location.href = `room.html?code=${await getCode()}`; }
  catch (err) { showError(err.message || String(err)); $('btnQuick').disabled = $('btnCreate').disabled = false; }
}

$('btnSignIn').onclick = openAuthDialog;
$('btnQuick').onclick = () => go(() => quickJoin(net, 'arena', hostName));
$('btnCreate').onclick = () => go(() => net.createRoom(tableMeta('arena', hostName)));
onAuth(ready);
tickClock();
