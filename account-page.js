// account-page.js — your stats, season progress and rating.
// Names come from users, so everything is built with textContent (never innerHTML).

// Small helper: <tag class="cls">text</tag>
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// One stat box: a small label above a big value, plus an optional small note underneath
function tile(label, value, note = '') {
  const box = el('div', 'tile');
  const v = el('div', 'tile-value', value);
  const n = el('div', 'tile-note', note);
  box.append(el('div', 'tile-label', label), v, n);
  box.valueEl = v;   // kept so the rank tile can be filled in after it loads
  box.noteEl = n;
  return box;
}

function section(title, ...children) {
  const sec = el('section', 'panel acct-section');
  sec.appendChild(el('h2', '', title));
  sec.append(...children);
  return sec;
}

const tiles = (...list) => { const g = el('div', 'tile-grid'); g.append(...list); return g; };

// ---------- Page ----------
function renderAccount() {
  const root = $('accountRoot');
  root.textContent = '';

  if (!currentUser || !profile) {
    const box = el('section', 'panel acct-signedout');
    const btn = el('button', 'btn deal', 'Sign in / Create account');
    btn.onclick = openAuthDialog;
    box.append(
      el('h2', '', 'Your account'),
      el('p', '', 'Sign in to save your scores, climb the weekly leaderboard and build your rating.'),
      btn,
    );
    root.appendChild(box);
    return;
  }

  // Who you are
  const head = el('section', 'panel acct-head');
  head.append(el('span', 'who-dot big', (profile.displayName[0] || '?').toUpperCase()));
  const who = el('div', 'acct-who');
  who.append(el('h2', 'acct-name', profile.username || profile.displayName), el('div', 'hint', currentUser.email || ''));
  head.appendChild(who);
  if (!profile.username) {
    const pick = el('button', 'btn small', 'Choose a username');
    pick.onclick = openNameDialog;
    head.appendChild(pick);
  }
  const out = el('button', 'btn small', 'Sign out');
  out.onclick = () => window.pokerAuth.signOut();
  head.appendChild(out);
  root.appendChild(head);

  // Rating (career points from season placements)
  root.appendChild(section('Rating',
    tiles(
      tile('Rating points', fmt(profile.points), 'seasons, Arenas, tournaments'),
      tile('Seasons played', fmt(profile.seasons), `${SEASON_MIN_HANDS}+ hands each`),
      tile('Best finish', profile.bestRank ? '#' + profile.bestRank : '-'),
      tile('High score', fmt(profile.high), 'best run ever'),
      tile('Arena points', fmt(profile.arenaPoints), 'included in your rating'),
      tile('Arenas counted', fmt(profile.arenas), profile.arenaBest ? `best finish #${profile.arenaBest}` : 'top 3 earn points'),
      tile('Tournament points', fmt(profile.tourneyPoints), 'included in your rating'),
      tile('Tournaments counted', fmt(profile.tourneys), profile.tourneyBest ? `best finish #${profile.tourneyBest}` : 'top 3 earn points'),
    )));

  // This season
  const hands = profile.sHands;
  const winRate = hands ? Math.round((profile.sWins / hands) * 100) + '%' : '-';
  const rankTile = tile('Season rank', '…');
  root.appendChild(section(`This season · ${seasonLabel(seasonId())} · ends in ${timeLeftText()}`,
    tiles(
      rankTile,
      tile('Best run', fmt(profile.best), 'chips left when a run ended'),
      tile('Runs finished', fmt(profile.runs)),
      tile('Skill (bb/100)', hands ? signed(bbPer100(profile.sBb, hands)) : '-', 'big blinds won per 100 hands'),
      tile('Hands', `${fmt(hands)} / ${SEASON_MIN_HANDS}`, hands >= SEASON_MIN_HANDS ? 'qualified' : 'to qualify'),
      tile('Win rate', winRate),
    )));
  fillRank(rankTile);

  // Lifetime
  const lifeRate = profile.handsPlayed ? Math.round((profile.handsWon / profile.handsPlayed) * 100) + '%' : '-';
  root.appendChild(section('Lifetime',
    tiles(
      tile('Hands played', fmt(profile.handsPlayed)),
      tile('Hands won', fmt(profile.handsWon), lifeRate),
      tile('Biggest pot won', fmt(profile.biggestPot)),
    )));

  // Recent Arenas (arena-rating.js totals these up after each one finishes)
  if (profile.arenaLog.length) root.appendChild(section('Recent Arenas', arenaTable(profile.arenaLog)));

  // Recent tournaments (tourney-rating.js adds these after each one finishes)
  if (profile.tourneyLog.length) root.appendChild(section('Recent tournaments', tourneyTable(profile.tourneyLog)));

  // Past seasons
  if (profile.history.length) root.appendChild(section('Past seasons', historyTable(profile.history)));
}

function arenaTable(log) {
  const table = el('table', 'lb');
  const head = document.createElement('tr');
  ['Arena', 'Place', 'Rating points'].forEach(t => head.appendChild(el('th', '', t)));
  table.appendChild(head);
  log.forEach(l => {
    const tr = document.createElement('tr');
    [arenaLabel(l.id).replace(' UTC', '') + ' · ' + l.id.slice(0, 4) + '-' + l.id.slice(4, 6) + '-' + l.id.slice(6, 8),
      `#${l.rank} of ${l.of}`, l.points ? '+' + l.points : '0'].forEach(t => tr.appendChild(el('td', '', t)));
    table.appendChild(tr);
  });
  const wrap = el('div', 'table-scroll');
  wrap.appendChild(table);
  return wrap;
}

function tourneyTable(log) {
  const table = el('table', 'lb');
  const head = document.createElement('tr');
  ['Tournament', 'Place', 'Rating points'].forEach(t => head.appendChild(el('th', '', t)));
  table.appendChild(head);
  log.forEach(l => {
    const tr = document.createElement('tr');
    [l.kind === 'sng' ? 'Sit & Go' : 'Scheduled', `#${l.place} of ${l.of}`, l.points ? '+' + l.points : '0'].forEach(t => tr.appendChild(el('td', '', t)));
    table.appendChild(tr);
  });
  const wrap = el('div', 'table-scroll');
  wrap.appendChild(table);
  return wrap;
}

function historyTable(history) {
  const table = el('table', 'lb');
  const head = document.createElement('tr');
  ['Season', 'Place', 'Points', 'Best run'].forEach(t => head.appendChild(el('th', '', t)));
  table.appendChild(head);
  history.forEach(h => {
    const tr = document.createElement('tr');
    [seasonLabel(h.season), h.rank ? '#' + h.rank : "Didn't qualify", h.points ? '+' + h.points : '0', fmt(h.score)]
      .forEach(t => tr.appendChild(el('td', '', t)));
    table.appendChild(tr);
  });
  const wrap = el('div', 'table-scroll');
  wrap.appendChild(table);
  return wrap;
}

// Work out your current place among qualified players (loads the top 100 of this week)
async function fillRank(rankTile) {
  if (profile.sHands < SEASON_MIN_HANDS) {
    rankTile.valueEl.textContent = '-';
    rankTile.noteEl.textContent = `${SEASON_MIN_HANDS - profile.sHands} more hands to qualify`;
    return;
  }
  try {
    await whenAuthReady();
    const qualified = (await window.pokerAuth.loadSeason(seasonId(), 100)).filter(r => r.hands >= SEASON_MIN_HANDS);
    const i = qualified.findIndex(r => r.uid === currentUser.uid);
    rankTile.valueEl.textContent = i === -1 ? '100+' : '#' + (i + 1);
    rankTile.noteEl.textContent = i === -1 ? 'outside the top 100' : `of ${qualified.length} qualified`;
  } catch (err) {
    console.error(err);
    rankTile.valueEl.textContent = '?';
    rankTile.noteEl.textContent = "couldn't load";
  }
}

onAuth(renderAccount);
// Before Firebase answers we don't know yet whether you're signed in
$('accountRoot').appendChild(el('p', 'board-msg', 'Loading…'));
