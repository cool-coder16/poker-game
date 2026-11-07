// game.js — table UI plus the Texas Hold'em game loop.
// Uses poker.js (cards, hand scoring) and bots.js (bot AI).

// ---------- Settings & state ----------
// Settings are chosen on settings.html and read here from localStorage (see common.js).
// ($ and fmt also come from common.js, which loads first.)
const cfg = loadSettings();
const MAX_SEATS = 8;
// Tutorial mode is switched on by opening the page as play.html?tutorial
const tutorial = new URLSearchParams(location.search).has('tutorial');

let roster = [];       // everyone at the table (including players waiting to join next hand)
let seated = [];       // the players dealt into the CURRENT hand
let tableList = [];    // whoever is currently drawn on the table
let board = [];
let deck = [];
let dealerIdx = -1;    // index into `seated`
let handNo = 0;
let handActive = false;
let currentBet = 0;    // the highest bet this betting round
let minRaise = 0;      // smallest legal raise increment
let activeId = null;   // id of the player whose turn it is
let markers = {};      // ids holding the dealer button / blinds
let winnerIds = new Set();
let humanWinAmount = 0;   // what you won this hand (0 if nothing); used for profile stats
let humanStartChips = 0;  // your chips before the blinds went in; used to work out bb won this hand
let humanResolve = null;   // set while we are waiting for you to click something
let humanCtx = null;
let nextId = 1;

const sleep = ms => new Promise(r => setTimeout(r, ms * cfg.speed));   // scaled by the speed setting
const winVerb = p => (p.isHuman ? "win" : "wins");   // "You win" vs "Rex wins"
const bigBlind = () => cfg.sb * 2;
const live = () => seated.filter(p => !p.folded);                    // still in the hand
const canAct = () => seated.filter(p => !p.folded && !p.allIn);      // still able to bet

// ---------- Players ----------
function makePlayer({ name, avatar, color, isHuman = false, profile = null, label = '' }) {
  return {
    id: nextId++, name, avatar, color, isHuman, profile, label,
    chips: cfg.startChips, hole: [], bet: 0, totalBet: 0,
    folded: false, allIn: false, acted: false, status: '', statusClass: '',
    showCards: false, score: 0, pending: false, leaving: false,
  };
}

function addBot(profileKey) {
  if (roster.length >= MAX_SEATS) return;
  const profile = BOT_PROFILES[profileKey];
  const taken = new Set(roster.map(p => p.name));
  const name = profile.names.find(n => !taken.has(n)) || profile.label + ' ' + (nextId);
  const bot = makePlayer({ name, avatar: profile.avatar, color: profile.color, profile, label: profile.label });
  bot.pending = handActive;   // joins at the start of the next hand if one is running
  roster.push(bot);
  log(`${name} (${profile.label}) sat down.`);
  if (!handActive) buildTable(roster);
  renderRoster();
}

function removeBot(id) {
  const p = roster.find(x => x.id === id);
  if (!p || p.isHuman) return;
  if (handActive && !p.pending) {
    p.leaving = true;   // can't leave mid-hand; leaves once it ends
    log(`${p.name} will leave after this hand.`);
  } else {
    roster = roster.filter(x => x !== p);
    log(`${p.name} left the table.`);
    if (!handActive) buildTable(roster);
  }
  renderRoster();
}

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
  const me = roster[0];
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

function renderRoster() {
  const ul = $('roster');
  ul.innerHTML = '';
  roster.forEach(p => {
    const li = document.createElement('li');
    const sub = p.leaving ? 'leaving after this hand' : p.pending ? 'joins next hand' : p.label || 'You';
    li.innerHTML = `<div class="avatar"></div><div class="rname"></div><span class="chips"></span>`;
    li.querySelector('.avatar').textContent = p.avatar;
    li.querySelector('.avatar').style.setProperty('--c', p.color);
    // Names can come from user accounts, so add them as plain text (never as HTML)
    const rname = li.querySelector('.rname');
    rname.append(p.name);
    const small = document.createElement('small');
    small.textContent = sub;
    rname.appendChild(small);
    li.querySelector('.chips').textContent = fmt(p.chips);
    if (!p.isHuman) {
      const x = document.createElement('button');
      x.className = 'x'; x.textContent = '✕'; x.title = 'Remove ' + p.name;
      x.onclick = () => removeBot(p.id);
      li.appendChild(x);
    }
    ul.appendChild(li);
  });
  $('btnAddBot').disabled = roster.length >= MAX_SEATS;
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

// ---------- Hand flow ----------
async function startHand() {
  if (handActive) return;
  winnerIds = new Set();
  applyPendingProfile();   // game-account.js: apply a sign-in/out that happened mid-hand

  // Apply seat changes that were waiting for the hand boundary
  roster.filter(p => p.leaving).forEach(p => log(`${p.name} left the table.`));
  roster = roster.filter(p => !p.leaving);
  roster.forEach(p => { p.pending = false; });
  const me = roster[0];
  if (me.chips <= 0) {
    me.chips = humanRebuyAmount();   // game-account.js: season rebuys are counted against your score
    log(`You rebought for ${fmt(me.chips)}.`);
  }
  roster.filter(p => !p.isHuman && p.chips <= 0).forEach(p => {
    if (cfg.botRebuy) { p.chips = cfg.startChips; log(`${p.name} rebought.`); }
    else { log(`${p.name} is out of chips.`); }
  });
  roster = roster.filter(p => p.isHuman || p.chips > 0);

  seated = roster.slice();
  renderRoster();
  if (seated.length < 2) {
    buildTable(roster);
    setMessage('Add a bot to start playing.');
    return;
  }

  handActive = true;
  $('btnDeal').disabled = true;
  try { await playHand(); }
  catch (err) { console.error(err); log('Something went wrong: ' + err.message); }
  endHand();
}

async function playHand() {
  handNo++;
  humanWinAmount = 0;
  humanStartChips = roster[0].chips;
  const n = seated.length;
  seated.forEach(p => Object.assign(p, {
    hole: [], bet: 0, totalBet: 0, folded: false, allIn: false, acted: false,
    status: '', statusClass: '', showCards: false,
  }));
  board = [];
  deck = tutorial ? stackedDeck() : shuffle(makeDeck());   // tutorial uses a fixed, known deal
  dealerIdx = (dealerIdx + 1) % n;

  // Heads-up (2 players): the dealer is the small blind. Otherwise blinds are the next two seats.
  const sbIdx = n === 2 ? dealerIdx : (dealerIdx + 1) % n;
  const bbIdx = (sbIdx + 1) % n;
  markers = { dealer: seated[dealerIdx].id, sb: seated[sbIdx].id, bb: seated[bbIdx].id };
  const firstPre = (bbIdx + 1) % n;                       // first to act before the flop
  const firstPost = n === 2 ? bbIdx : sbIdx;               // first to act after the flop

  buildTable(seated);
  log(`— Hand #${handNo} —`, 'hand');
  setMessage(`Hand #${handNo}`);
  await tutorialStep('intro');
  currentBet = 0; minRaise = bigBlind();
  postBlind(seated[sbIdx], cfg.sb, 'small blind');
  postBlind(seated[bbIdx], bigBlind(), 'big blind');
  currentBet = bigBlind();
  update();

  // Deal two hole cards to everyone, one at a time
  for (let round = 0; round < 2; round++) {
    for (let k = 0; k < n; k++) {
      seated[(sbIdx + k) % n].hole.push(deck.pop());
      update();
      await sleep(80);
    }
  }
  await sleep(300);
  await tutorialStep('hole');

  const stages = ['Pre-flop', 'Flop', 'Turn', 'River'];
  for (let s = 0; s < 4; s++) {
    if (s > 0) {
      collectBets();
      const count = s === 1 ? 3 : 1;
      for (let k = 0; k < count; k++) { board.push(deck.pop()); update(); await sleep(150); }
      setMessage(stages[s]);
      await sleep(250);
      await tutorialStep(stages[s].toLowerCase());   // 'flop', 'turn' or 'river'
    } else {
      setMessage('Pre-flop');
    }
    if (live().length <= 1) break;
    const needsAction = canAct().length >= 2 || canAct().some(p => p.bet < currentBet);
    if (needsAction) await bettingRound(s === 0 ? firstPre : firstPost);
    if (live().length <= 1) break;
  }
  collectBets();

  if (live().length === 1) await awardUncontested();
  else await showdown();
}

function postBlind(p, amount, label) {
  const pay = Math.min(amount, p.chips);
  commit(p, pay);
  if (p.chips === 0) { p.allIn = true; p.status = 'All-in'; p.statusClass = 's-allin'; }
  log(`${p.name} posts the ${label} (${fmt(pay)}).`);
}

function commit(p, amount) {
  p.chips -= amount;
  p.bet += amount;
  p.totalBet += amount;
}

// New betting round: forget this round's bets (they stay counted in the pot via totalBet)
function collectBets() {
  seated.forEach(p => { p.bet = 0; p.acted = false; if (!p.folded && !p.allIn) { p.status = ''; p.statusClass = ''; } });
  currentBet = 0;
  minRaise = bigBlind();
  update();
}

// Go around the table until everyone still in has acted and matched the highest bet.
async function bettingRound(startIdx) {
  const n = seated.length;
  let i = startIdx % n;
  while (true) {
    if (live().length <= 1) return;
    const actable = canAct();
    if (actable.length === 0) return;
    if (actable.every(p => p.acted && p.bet === currentBet)) return;
    if (actable.length === 1 && actable[0].bet >= currentBet) return;   // nobody left to bet against

    const p = seated[i];
    if (!p.folded && !p.allIn && !(p.acted && p.bet === currentBet)) await takeTurn(p);
    i = (i + 1) % n;
  }
}

async function takeTurn(p) {
  activeId = p.id;
  update();

  const toCall = Math.min(currentBet - p.bet, p.chips);
  const maxRaiseTo = p.bet + p.chips;
  const othersCanRespond = canAct().some(q => q !== p);
  const ctx = {
    hole: p.hole, board: board.slice(),
    pot: seated.reduce((s, q) => s + q.totalBet, 0),
    toCall, currentBet, maxRaiseTo,
    minRaiseTo: Math.min(currentBet + minRaise, maxRaiseTo),
    canRaise: p.chips > toCall && othersCanRespond,
    chips: p.chips, sb: cfg.sb, numOpp: live().length - 1,
  };

  let action;
  if (p.isHuman) {
    action = await getHumanAction(ctx);
  } else {
    await sleep(700 + Math.random() * 700);   // "thinking" time
    action = botDecide(p.profile, ctx);
  }
  if (action.type === 'raise' && !ctx.canRaise) action = { type: 'call' };   // safety net

  applyAction(p, action, ctx);
  activeId = null;
  update();
}

function applyAction(p, action, ctx) {
  if (action.type === 'fold') {
    p.folded = true;
    p.status = 'Fold'; p.statusClass = 's-fold';
    log(`${p.name} folds.`);
  } else if (action.type === 'call') {
    const pay = ctx.toCall;
    commit(p, pay);
    p.status = pay === 0 ? 'Check' : 'Call'; p.statusClass = '';
    log(pay === 0 ? `${p.name} checks.` : `${p.name} calls ${fmt(pay)}.`);
  } else {
    const raiseTo = Math.max(ctx.minRaiseTo, Math.min(ctx.maxRaiseTo, Math.round(action.amount)));
    const wasBet = currentBet === 0;
    commit(p, raiseTo - p.bet);
    const size = raiseTo - currentBet;
    if (size >= minRaise) minRaise = size;      // a full raise raises the minimum for the next one
    currentBet = raiseTo;
    seated.forEach(q => { if (q !== p) q.acted = false; });   // everyone must respond to a raise
    p.status = wasBet ? 'Bet' : 'Raise'; p.statusClass = 's-raise';
    log(`${p.name} ${wasBet ? 'bets' : 'raises to'} ${fmt(raiseTo)}.`);
  }
  p.acted = true;
  if (p.chips === 0 && !p.folded) {
    p.allIn = true; p.status = 'All-in'; p.statusClass = 's-allin';
    log(`${p.name} is all-in!`);
  }
}

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

// ---------- Winning ----------
// Split the money into the main pot and side pots (needed when someone is all-in for less).
function buildPots() {
  const levels = [...new Set(seated.filter(p => p.totalBet > 0).map(p => p.totalBet))].sort((a, b) => a - b);
  const pots = [];
  let prev = 0;
  for (const level of levels) {
    let amount = 0;
    seated.forEach(p => { amount += Math.max(0, Math.min(p.totalBet, level) - prev); });
    pots.push({ amount, eligible: seated.filter(p => !p.folded && p.totalBet >= level) });
    prev = level;
  }
  return pots;
}

async function awardUncontested() {
  const winner = live()[0];
  const amount = seated.reduce((s, p) => s + p.totalBet, 0);
  winner.chips += amount;
  winner.status = `Wins ${fmt(amount)}`; winner.statusClass = 's-win';
  winnerIds.add(winner.id);
  if (winner.isHuman) humanWinAmount = amount;
  seated.forEach(p => { p.totalBet = 0; p.bet = 0; });
  setMessage(`${winner.name} ${winVerb(winner)} ${fmt(amount)}`);
  log(`${winner.name} ${winVerb(winner)} ${fmt(amount)} (everyone else folded).`, 'win');
  update();
  await tutorialStep('fold');
}

async function showdown() {
  // Run out any remaining board cards (happens when players are all-in)
  while (board.length < 5) { board.push(deck.pop()); update(); await sleep(400); }

  const contenders = live();
  contenders.forEach(p => { p.showCards = true; p.score = bestScore(p.hole.concat(board)); });
  setMessage('Showdown');
  update();
  await sleep(900);

  const won = new Map();
  for (const pot of buildPots()) {
    const pool = pot.eligible.length ? pot.eligible : contenders;
    const top = Math.max(...pool.map(p => p.score));
    // Odd leftover chips go to the winner closest to the left of the dealer
    const winners = pool.filter(p => p.score === top)
      .sort((a, b) => ((seated.indexOf(a) - dealerIdx + 99) % seated.length) - ((seated.indexOf(b) - dealerIdx + 99) % seated.length));
    const share = Math.floor(pot.amount / winners.length);
    let leftover = pot.amount - share * winners.length;
    winners.forEach(w => {
      const amt = share + (leftover-- > 0 ? 1 : 0);
      w.chips += amt;
      won.set(w, (won.get(w) || 0) + amt);
    });
  }

  const summary = [];
  won.forEach((amt, p) => {
    winnerIds.add(p.id);
    if (p.isHuman) humanWinAmount = amt;
    p.status = `Wins ${fmt(amt)}`; p.statusClass = 's-win';
    summary.push(`${p.name} ${winVerb(p)} ${fmt(amt)} with ${handName(p.score)}`);
    log(`${p.name} ${winVerb(p)} ${fmt(amt)} with ${handName(p.score)}.`, 'win');
  });
  seated.forEach(p => { p.totalBet = 0; p.bet = 0; });
  setMessage(summary.join(' · '));
  update();
  await tutorialStep('showdown');
}

async function endHand() {
  handActive = false;
  activeId = null;
  humanResolve = null;
  setControlsEnabled(false);
  $('btnCall').textContent = 'Check';
  renderRoster();
  update();
  if (!tutorial) recordHandResult();   // game-account.js: update + save stats when signed in

  const me = roster[0];
  const btn = $('btnDeal');
  btn.disabled = false;
  btn.textContent = me.chips <= 0 ? 'Rebuy & deal' : 'Deal next hand';
  if (me.chips <= 0) setMessage('You are out of chips! Rebuy to keep playing.');

  if (tutorial) {
    // After the lesson, the Deal button takes you to a real game instead of another rigged hand
    btn.textContent = 'Play a real game';
    btn.onclick = () => { location.href = location.pathname; };
    await tutorialStep('end');
    return;
  }

  if (cfg.autoDeal && me.chips > 0) {
    await sleep(3000);
    if (cfg.autoDeal && !handActive) startHand();
  }
}

// ---------- Tutorial mode ----------
// A scripted practice hand: fixed cards, and an opponent who only checks/calls so the hand
// always plays out the same way. tutorialStep(key) shows a coach message at that moment of
// the hand; if the step has `next: true` the game waits for you to press Next.

// Cards in the order they're dealt: you, Rex, you, Rex, then flop (3), turn, river.
const TUTORIAL_DEALS = ['Ks', 'Ac', 'Kd', '9c', 'Kh', '7c', '2d', '9s', '4h'];

// Rex never folds or raises. `decide` overrides the normal bot AI (see bots.js).
const TUTORIAL_BOT = { label: 'Practice opponent', decide: () => ({ type: 'call' }) };

const TUTORIAL_STEPS = {
  intro: { n: 1, next: true, title: "Welcome to Texas Hold'em 🎓",
    text: `Every player gets <b>2 private cards</b>, and <b>5 shared cards</b> are dealt face-up in the middle.
           Your goal is to win chips by making the <b>best 5-card hand</b> from any mix of your 2 cards and the 5 shared ones.
           This is a practice hand against one opponent, Rex. Nothing here is real.` },
  hole: { n: 2, highlight: 'call', title: 'Your cards and the blinds',
    text: `You hold <b>K♠ K♦</b>: a pair of Kings, one of the best starting hands!
           Before the cards were dealt, two forced bets called <b>blinds</b> went in: you're the small blind (10, marked SB) and Rex is the big blind (20, BB).
           Now it's your move. <b>Call</b> means match the 20, <b>Raise</b> means bet more, <b>Fold</b> means give up the hand. Try <b>Call</b>!` },
  flop: { n: 3, highlight: 'rankings', title: 'The flop',
    text: `The first 3 shared cards are out: <b>K♥ 7♣ 2♦</b>. With your two Kings you now have <b>Three of a Kind</b>!
           Look at "You have:" above your buttons and the gold row in <b>Hand Rankings</b> on the right.
           Rex acts first, then it's you. You can <b>Check</b> (pass for free) or <b>Bet</b>.` },
  turn: { n: 4, highlight: 'raise', title: 'The turn',
    text: `A 4th shared card, <b>9♠</b>. You still have three Kings, so you're probably ahead. When you think you're ahead, bet to build the pot!
           Use the quick buttons (<b>½ Pot</b>, <b>Pot</b>) or the slider to pick a bet size, then press the green button.` },
  river: { n: 5, highlight: 'pot', title: 'The river',
    text: `The last shared card, <b>4♥</b>. This is the final round of betting. The <b>Pot</b> in the middle is all the chips in play.
           <b>All-in</b> bets every chip you have. Bet, check, or call, and see who wins!` },
  showdown: { n: 6, next: true, title: 'Showdown!',
    text: `When betting ends, everyone still in the hand turns their cards over and the <b>best 5-card hand wins the pot</b>.
           You had <b>Three of a Kind</b>; Rex had only a pair of 9s. Nice!` },
  fold: { n: 6, next: true, title: 'The hand ended early',
    text: `When someone folds, the other player wins the pot without showing cards. That's also how bluffing works.
           In this practice hand you would have won with Three Kings. Reload the tutorial to try again!` },
  end: { n: 7, next: true, exit: true, nextLabel: 'Play a real game', title: "You're ready to play!",
    text: `<b>Fold</b> = quit the hand. <b>Check</b> = pass for free. <b>Call</b> = match the bet. <b>Raise</b> = bet more.
           In a real game you'll face bots with different styles. You can add or remove them in the Players panel,
           and Hand Rankings is always on the side if you forget what beats what.` },
};

// "Ks" -> a card object like the ones makeDeck() builds
function cardFromCode(code) {
  const r = code.slice(0, -1);
  const rank = { J: 11, Q: 12, K: 13, A: 14 }[r] || Number(r);
  const s = SUIT_LETTERS.indexOf(code.slice(-1));
  return { r: rank, s, id: s * 13 + (rank - 2) };
}

// The game deals with deck.pop() (takes from the END), so the scripted cards go last, reversed.
function stackedDeck() {
  const rigged = TUTORIAL_DEALS.map(cardFromCode);
  const used = new Set(rigged.map(c => c.id));
  const rest = shuffle(makeDeck().filter(c => !used.has(c.id)));
  return rest.concat(rigged.reverse());
}

function tutorialStep(key) {
  const step = TUTORIAL_STEPS[key];
  if (!tutorial || !step) return Promise.resolve();

  $('coach').classList.remove('hidden');
  $('coachTitle').textContent = step.title;
  $('coachText').innerHTML = step.text;     // our own text above, never user input
  $('coachStep').textContent = `Step ${step.n} of 7`;
  document.body.dataset.tut = step.highlight || '';

  const nextBtn = $('coachNext');
  if (!step.next) { nextBtn.classList.add('hidden'); return Promise.resolve(); }   // you act instead
  nextBtn.classList.remove('hidden');
  nextBtn.textContent = step.nextLabel || 'Next';
  return new Promise(resolve => {
    nextBtn.onclick = () => {
      if (step.exit) location.href = location.pathname;
      resolve();
    };
  });
}

// ---------- Sidebar wiring ----------
$('btnDeal').onclick = startHand;
$('tutLink').onclick = () => !handActive || confirm('Leave this game and start the tutorial?');
$('btnAddBot').onclick = () => addBot($('botSelect').value);

Object.entries(BOT_PROFILES).forEach(([key, p]) => {
  const opt = document.createElement('option');
  opt.value = key;
  opt.textContent = `${p.avatar} ${p.label}`;
  $('botSelect').appendChild(opt);
});
const showBotDesc = () => { $('botDesc').textContent = BOT_PROFILES[$('botSelect').value].desc; };
$('botSelect').onchange = showBotDesc;

// ---------- Start-up ----------
const SUIT_LETTERS = ['s', 'h', 'd', 'c'];   // matches the order of SUIT_SYMBOLS in poker.js
renderRankings();
// Five empty slots for the community cards
for (let i = 0; i < 5; i++) {
  const slot = document.createElement('div');
  slot.className = 'card';
  $('board').appendChild(slot);
}
roster.push(makePlayer({ name: 'You', avatar: '😎', color: '#2f8f5b', isHuman: true }));
showBotDesc();
if (tutorial) {
  document.body.classList.add('tutorial');
  const rex = makePlayer({ name: 'Rex', avatar: '🤖', color: '#6b7a90', profile: TUTORIAL_BOT, label: 'Practice opponent' });
  roster.push(rex);
  buildTable(roster);
  $('btnDeal').classList.add('hidden');   // the lesson deals itself
  startHand();
} else {
  addBot('shark');
  addBot('fox');
  addBot('station');
  log('Welcome! Press Deal to start. Add or remove bots any time.');
}
