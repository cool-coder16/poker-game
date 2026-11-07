// table-ui.js — drawing the table and your betting controls. Shared by the single-player game
// (game.js) and online rooms (room-client.js). No game rules in here: whoever loads this sets
// the globals below (tableList, board, markers, activeId, winnerIds) and calls update().
// Uses poker.js (cards, hand scoring) and common.js ($, fmt).

const SUIT_LETTERS = ['s', 'h', 'd', 'c'];   // matches the order of SUIT_SYMBOLS in poker.js

// What the table currently shows
let tableList = [];    // whoever is currently drawn on the table
let board = [];
let handActive = false;
let activeId = null;   // id of the player whose turn it is
let markers = {};      // ids holding the dealer button / blinds
let winnerIds = new Set();
let humanResolve = null;   // set while we are waiting for you to click something
let humanCtx = null;

// ---------- Drawing ----------
const seatEls = new Map();   // player id -> DOM pieces for that seat

// Spread seats around an ellipse. Seat 0 (you) is at the bottom.
function seatPos(i, n) {
  const angle = (90 + (i * 360) / n) * Math.PI / 180;
  return { x: 50 + 40 * Math.cos(angle), y: 50 + 40 * Math.sin(angle) };
}

function buildTable(list) {
  tableList = list;
  document.querySelectorAll('.seat, .bet').forEach(e => e.remove());
  seatEls.clear();
  const wrap = $('tableWrap');

  list.forEach((p, i) => {
    const { x, y } = seatPos(i, list.length);
    const seat = document.createElement('div');
    seat.className = 'seat' + (p.isHuman ? ' me' : '');
    seat.style.left = x + '%';
    seat.style.top = y + '%';
    seat.innerHTML = `
      <div class="hole"><div class="card"></div><div class="card"></div></div>
      <div class="plate">
        <div class="avatar"></div>
        <div><div class="name"></div><div class="stack"></div></div>
        <div class="dbtn hidden">D</div><div class="btag hidden"></div>
      </div>
      <div class="status"></div>`;
    seat.querySelector('.avatar').textContent = p.avatar;
    seat.querySelector('.avatar').style.setProperty('--c', p.color);
    seat.querySelector('.name').textContent = p.name;

    // Bet chips sit between the seat and the middle of the table
    const bet = document.createElement('div');
    bet.className = 'bet hidden';
    bet.style.left = 50 + (x - 50) * 0.6 + '%';
    bet.style.top = 50 + (y - 50) * 0.6 + '%';
    bet.innerHTML = '<span class="chipstack"></span><span class="amt"></span>';

    wrap.append(seat, bet);
    seatEls.set(p.id, {
      seat, bet,
      cards: [...seat.querySelectorAll('.hole .card')],
      stack: seat.querySelector('.stack'),
      status: seat.querySelector('.status'),
      dbtn: seat.querySelector('.dbtn'),
      btag: seat.querySelector('.btag'),
      chipstack: bet.querySelector('.chipstack'),
      amt: bet.querySelector('.amt'),
    });
  });
  update();
}

function cardFaceHTML(c) {
  const rank = rankLabel(c.r), suit = SUIT_SYMBOLS[c.s];
  return `<div class="corner tl"><b>${rank}</b><i>${suit}</i></div>
          <div class="pip">${suit}</div>
          <div class="corner br"><b>${rank}</b><i>${suit}</i></div>`;
}

// Show a card (face up / face down / empty slot). Only touches the DOM if something changed,
// so the deal and flip animations play once instead of on every redraw.
function setCard(el, card, faceUp) {
  const key = !card ? 'none' : faceUp ? 'f' + card.id : 'back';
  if (el.dataset.key === key) return;
  const wasEmpty = !el.dataset.key || el.dataset.key === 'none';
  el.dataset.key = key;
  el.className = 'card';
  el.innerHTML = '';
  if (key === 'none') { el.classList.add('empty'); return; }
  if (key === 'back') el.classList.add('back');
  else {
    el.classList.add('face');
    if (card.s === 1 || card.s === 2) el.classList.add('red');   // hearts and diamonds
    el.innerHTML = cardFaceHTML(card);
  }
  el.classList.add(wasEmpty ? 'deal' : 'flip');
}

// Chip colour/height depends on how much is bet
function drawChips(el, amount) {
  const tiers = [[1000, '#2b2b2b', 4], [250, '#2b6fc4', 3], [50, '#d6402f', 2], [0, '#e8e8e8', 1]];
  const [, color, count] = tiers.find(t => amount >= t[0]);
  el.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.style.background = color;
    chip.style.top = -i * 4 + 'px';
    el.appendChild(chip);
  }
}

function update() {
  // Pot and community cards
  const pot = tableList.reduce((s, p) => s + p.totalBet, 0);
  $('potAmt').textContent = fmt(pot);
  $('pot').classList.toggle('hidden', pot === 0);
  [...$('board').children].forEach((el, i) => setCard(el, board[i], true));

  tableList.forEach(p => {
    const el = seatEls.get(p.id);
    if (!el) return;
    const faceUp = p.isHuman || p.showCards;
    el.cards.forEach((c, k) => setCard(c, p.hole[k], faceUp));
    el.stack.textContent = fmt(p.chips);
    el.status.textContent = p.status;
    el.status.className = 'status ' + p.statusClass;

    el.seat.classList.toggle('active', p.id === activeId);
    el.seat.classList.toggle('folded', p.folded);
    el.seat.classList.toggle('winner', winnerIds.has(p.id));

    el.dbtn.classList.toggle('hidden', markers.dealer !== p.id);
    const tag = markers.sb === p.id ? 'SB' : markers.bb === p.id ? 'BB' : '';
    el.btag.textContent = tag;
    el.btag.classList.toggle('hidden', !tag);

    el.bet.classList.toggle('hidden', p.bet === 0);
    if (p.bet > 0) { el.amt.textContent = fmt(p.bet); drawChips(el.chipstack, p.bet); }
  });
  updateMyHand();
}

function updateMyHand() {
  const me = tableList.find(p => p.isHuman);   // your seat (in single-player this is roster[0])
  let text = '';
  let score = null;
  if (handActive && me && !me.folded && me.hole.length === 2 && board.length >= 3) {
    score = bestScore(me.hole.concat(board));
    text = 'You have: ' + handName(score);
  }
  $('myHand').textContent = text;
  highlightRanking(score);
}

// ---------- Hand rankings panel ----------
// Each row: name, short description, and an example hand. In examples a card is 'rank+suit'
// (suit: s h d c); a trailing '-' marks a kicker that doesn't make the hand (shown dimmed).
const HAND_RANKINGS = [
  { cat: 8, royal: true, name: 'Royal Flush', desc: 'A-K-Q-J-10, all the same suit', cards: ['As', 'Ks', 'Qs', 'Js', '10s'] },
  { cat: 8, name: 'Straight Flush', desc: 'Five in a row, same suit', cards: ['9h', '8h', '7h', '6h', '5h'] },
  { cat: 7, name: 'Four of a Kind', desc: 'Four cards of the same rank', cards: ['Qs', 'Qh', 'Qd', 'Qc', '3s-'] },
  { cat: 6, name: 'Full House', desc: 'Three of a kind plus a pair', cards: ['Js', 'Jh', 'Jd', '8c', '8s'] },
  { cat: 5, name: 'Flush', desc: 'Five cards of the same suit', cards: ['Kd', 'Jd', '8d', '6d', '2d'] },
  { cat: 4, name: 'Straight', desc: 'Five in a row, any suits', cards: ['10c', '9h', '8s', '7d', '6c'] },
  { cat: 3, name: 'Three of a Kind', desc: 'Three cards of the same rank', cards: ['7s', '7h', '7d', 'Kc-', '2s-'] },
  { cat: 2, name: 'Two Pair', desc: 'Two different pairs', cards: ['Ah', 'Ac', '5s', '5d', '9c-'] },
  { cat: 1, name: 'Pair', desc: 'Two cards of the same rank', cards: ['10h', '10s', 'Ad-', '6c-', '3h-'] },
  { cat: 0, name: 'High Card', desc: 'None of the above: highest card plays', cards: ['Ac', 'Jd', '8h', '5s', '2c'] },
];

function renderRankings() {
  const ol = $('rankings');
  HAND_RANKINGS.forEach((h, i) => {
    const li = document.createElement('li');
    li.dataset.index = i;
    const cards = h.cards.map(code => {
      const kicker = code.endsWith('-');
      const c = kicker ? code.slice(0, -1) : code;
      const suit = SUIT_LETTERS.indexOf(c.slice(-1));
      return `<span class="mini ${suit === 1 || suit === 2 ? 'red' : ''} ${kicker ? 'dim' : ''}">` +
             `<span>${c.slice(0, -1)}</span><span>${SUIT_SYMBOLS[suit]}</span></span>`;
    }).join('');
    li.innerHTML = `<span class="rname">${i + 1}. ${h.name}</span><span class="mini-cards">${cards}</span>` +
                   `<span class="rdesc">${h.desc}</span>`;
    ol.appendChild(li);
  });
}

// Light up the row matching the hand you currently hold (pass null to clear)
function highlightRanking(score) {
  let match = -1;
  if (score !== null) {
    const cat = Math.floor(score / Math.pow(15, 5));
    const topRank = Math.floor(score / Math.pow(15, 4)) % 15;
    match = HAND_RANKINGS.findIndex(h => h.cat === cat && (cat !== 8 || !!h.royal === (topRank === 14)));   // cat 8 has two rows
  }
  document.querySelectorAll('#rankings li').forEach((li, i) => li.classList.toggle('current', i === match));
}

function log(text, cls = '') {
  const li = document.createElement('li');
  li.textContent = text;
  if (cls) li.className = cls;
  const ul = $('log');
  ul.appendChild(li);
  while (ul.children.length > 80) ul.firstChild.remove();
  ul.scrollTop = ul.scrollHeight;
}
const setMessage = t => { $('message').textContent = t; };

// ---------- Your controls ----------
function getHumanAction(ctx) {
  return new Promise(resolve => {
    humanCtx = ctx;
    humanResolve = resolve;
    setupControls(ctx);
  });
}

function submitHuman(action) {
  if (!humanResolve) return;
  const resolve = humanResolve;
  humanResolve = null;
  setControlsEnabled(false);
  resolve(action);
}

function setControlsEnabled(on) {
  ['btnFold', 'btnCall', 'btnRaise', 'raiseSlider', 'raiseInput'].forEach(id => { $(id).disabled = !on; });
  document.querySelectorAll('.quick button').forEach(b => { b.disabled = !on; });
}

function setupControls(ctx) {
  setControlsEnabled(true);
  const all = ctx.toCall >= ctx.chips;
  $('btnCall').textContent = ctx.toCall === 0 ? 'Check' : all ? `All-in ${fmt(ctx.toCall)}` : `Call ${fmt(ctx.toCall)}`;
  $('raiseBox').style.visibility = ctx.canRaise ? 'visible' : 'hidden';
  $('btnRaise').disabled = !ctx.canRaise;
  $('raiseSlider').min = $('raiseInput').min = ctx.minRaiseTo;
  $('raiseSlider').max = $('raiseInput').max = ctx.maxRaiseTo;
  setRaiseValue(ctx.minRaiseTo);
}

function setRaiseValue(v) {
  const c = humanCtx;
  v = Math.max(c.minRaiseTo, Math.min(c.maxRaiseTo, Math.round(v) || c.minRaiseTo));
  $('raiseSlider').value = v;
  $('raiseInput').value = v;
  $('btnRaise').textContent = v >= c.maxRaiseTo ? `All-in ${fmt(v)}` : (c.currentBet === 0 ? 'Bet ' : 'Raise to ') + fmt(v);
}

$('btnFold').onclick = () => submitHuman({ type: 'fold' });
$('btnCall').onclick = () => submitHuman({ type: 'call' });
$('btnRaise').onclick = () => submitHuman({ type: 'raise', amount: Number($('raiseInput').value) });
$('raiseSlider').oninput = e => setRaiseValue(Number(e.target.value));
$('raiseInput').onchange = e => setRaiseValue(Number(e.target.value));
document.querySelectorAll('.quick button').forEach(b => {
  b.onclick = () => {
    if (!humanCtx) return;
    const q = b.dataset.q;
    // "Pot-sized raise" = call first, then raise by the size of the pot
    setRaiseValue(q === 'all' ? humanCtx.maxRaiseTo : humanCtx.currentBet + Number(q) * (humanCtx.pot + humanCtx.toCall));
  };
});

