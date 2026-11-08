// tables.js — the open tables page: a live list of tables you can sit down at.
// Names come from users, so everything is filled in with textContent (never innerHTML).

let net = null;
let hostName = '';
let lobby = {};       // the public list as last reported

const setView = name => ['needSignIn', 'notReady', 'tablesView'].forEach(id => $(id).classList.toggle('hidden', id !== name));
const showError = text => { $('tablesError').textContent = text; };

async function ready(user, prof) {
  if (!user) return setView('needSignIn');
  if (!window.pokerRooms) await new Promise(r => window.addEventListener('pokerrooms-ready', r, { once: true }));
  if (!window.pokerRooms.configured) return setView('notReady');
  net = window.pokerRooms.makeNet();
  hostName = prof.displayName;
  setView('tablesView');
  net.watchLobby(all => { lobby = all; draw(); });
  setInterval(draw, 5000);   // so a table whose dealer vanished drops off the list
}

function draw() {
  const list = $('tableList');
  list.textContent = '';
  const tables = liveTables(lobby).filter(e => e.mode === 'open');
  $('tableEmpty').textContent = tables.length ? '' : 'No open tables right now. Start one!';
  tables.forEach(e => {
    const li = document.createElement('li');
    const info = document.createElement('div');
    info.className = 'grow';
    const title = document.createElement('b');
    title.textContent = `${e.hostName || 'Someone'}'s table`;
    const small = document.createElement('small');
    small.textContent = `Blinds ${fmt(e.sb)}/${fmt(e.sb * 2)} · ${fmt(e.startChips)} chips to start`;
    info.append(title, small);
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

async function go(getCode) {
  showError('');
  $('btnQuick').disabled = $('btnCreate').disabled = true;
  try { location.href = `room.html?code=${await getCode()}`; }
  catch (err) { showError(err.message || String(err)); $('btnQuick').disabled = $('btnCreate').disabled = false; }
}

$('btnSignIn').onclick = openAuthDialog;
$('btnQuick').onclick = () => go(() => quickJoin(net, 'open', hostName));
$('btnCreate').onclick = () => go(() => net.createRoom(tableMeta('open', hostName)));
onAuth(ready);
