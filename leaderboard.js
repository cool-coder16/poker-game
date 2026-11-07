// leaderboard.js — loads a board from Firebase and draws it as a table.
// Player names come from users, so every cell is filled with textContent (never innerHTML).

const lastWeekId = () => seasonId(new Date(Date.now() - 7 * 86400000));

let tab = 'week';
let rows = null;      // null while loading, otherwise the list from Firebase
let loadFailed = false;

// ---------- Loading ----------
async function showTab(name) {
  tab = name;
  rows = null;
  loadFailed = false;
  document.querySelectorAll('#boardTabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  draw();
  try {
    await whenAuthReady();
    if (name === 'rating') rows = await window.pokerAuth.loadRatings(100);
    else rows = await window.pokerAuth.loadSeason(name === 'week' ? seasonId() : lastWeekId(), 100);
  } catch (err) {
    console.error(err);
    loadFailed = true;
  }
  if (tab === name) draw();   // ignore the answer if you already clicked a different tab
}

// ---------- Drawing ----------
function cell(row, text, className = '') {
  const td = document.createElement('td');
  td.textContent = text;
  if (className) td.className = className;
  row.appendChild(td);
  return td;
}

function headRow(labels) {
  const tr = document.createElement('tr');
  labels.forEach(text => {
    const th = document.createElement('th');
    th.textContent = text;
    tr.appendChild(th);
  });
  return tr;
}

const medal = rank => ['🥇', '🥈', '🥉'][rank - 1] || String(rank);

function draw() {
  const table = $('board');
  table.textContent = '';
  const msg = $('boardMsg');
  msg.textContent = '';

  $('boardInfo').textContent = {
    week: `${seasonLabel(seasonId())} · ends in ${timeLeftText()}`,
    last: `Final standings, ${seasonLabel(lastWeekId())}`,
    rating: 'Career rating points from season placements',
  }[tab];

  if (loadFailed) { msg.textContent = "Couldn't load the leaderboard. Check your connection and try again."; return; }
  if (rows === null) { msg.textContent = 'Loading…'; return; }
  if (rows.length === 0) {
    msg.textContent = tab === 'rating'
      ? 'No ratings yet. Ratings appear after the first season ends.'
      : 'Nobody has played this week yet. Be the first!';
    return;
  }
  if (tab === 'rating') drawRatings(table); else drawSeason(table);
}

function drawSeason(table) {
  table.appendChild(headRow(['#', 'Player', 'Score', 'Hands', 'bb/100', tab === 'week' ? 'Pts if it ended now' : 'Pts']));
  const qualified = rows.filter(r => r.hands >= SEASON_MIN_HANDS);
  const waiting = rows.filter(r => r.hands < SEASON_MIN_HANDS);

  qualified.forEach((r, i) => addSeasonRow(table, r, i + 1));
  waiting.forEach(r => addSeasonRow(table, r, 0));
}

// rank 0 means "not qualified yet"
function addSeasonRow(table, r, rank) {
  const tr = document.createElement('tr');
  if (currentUser && r.uid === currentUser.uid) tr.className = 'me';
  if (!rank) tr.classList.add('waiting');
  cell(tr, rank ? medal(rank) : '-', 'rank');
  cell(tr, r.username, 'name');
  cell(tr, fmt(r.score));
  cell(tr, fmt(r.hands));
  cell(tr, signed(bbPer100(r.bb, r.hands)));
  cell(tr, rank ? '+' + placementPoints(rank) : `${SEASON_MIN_HANDS - r.hands} more hands`, 'pts');
  table.appendChild(tr);
}

function drawRatings(table) {
  table.appendChild(headRow(['#', 'Player', 'Rating', 'Seasons']));
  rows.forEach((r, i) => {
    const tr = document.createElement('tr');
    if (currentUser && r.uid === currentUser.uid) tr.className = 'me';
    cell(tr, medal(i + 1), 'rank');
    cell(tr, r.username, 'name');
    cell(tr, fmt(r.points));
    cell(tr, fmt(r.seasons));
    table.appendChild(tr);
  });
}

// ---------- Wiring ----------
document.querySelectorAll('#boardTabs button').forEach(b => { b.onclick = () => showTab(b.dataset.tab); });
onAuth(() => { if (rows) draw(); });   // highlight your own row once we know who you are
showTab('week');
