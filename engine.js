// engine.js — Texas Hold'em as a PURE state machine: no screen, no timers, no network.
// Give it a table and a player's action, and it moves the hand forward. Because it has no
// side effects it runs the same in a browser, in the Node tests (tests/), and on a future server.
// Uses poker.js (makeDeck, shuffle, bestScore, handName).
//
// How a hand flows:   startHand(t)  ->  t.toAct says whose turn it is  ->  act(t, seatIndex, action)
//                     ... repeat ... until t.phase === 'hand-over' (t.result says who won what).
//
// A table `t` is a plain object (see createTable). A seat is a plain object (see newSeat).
// Seats are addressed by their index in t.seats; `seat.id` is a stable id (an account uid or "bot-1").

const STREETS = ['preflop', 'flop', 'turn', 'river'];

function newSeat({ id, name, avatar = '🙂', color = '#6b7a90', isBot = false, botKey = null, chips }) {
  return {
    id, name, avatar, color, isBot, botKey, chips,
    hole: [], bet: 0, totalBet: 0, folded: false, allIn: false, acted: false,
    inHand: false, status: '', statusClass: '', showCards: false, score: 0,
  };
}

function createTable({ seats, sb }) {
  return {
    seats, sb, bb: sb * 2,
    dealerSeat: -1, sbSeat: -1, bbSeat: -1,
    handNo: 0, phase: 'waiting',          // waiting | preflop | flop | turn | river | hand-over
    board: [], deck: [],
    currentBet: 0, minRaise: sb * 2,
    toAct: -1,                            // seat index whose turn it is (-1 = nobody)
    result: null,                         // set when the hand is over
    log: [], logId: 0,                    // text lines for the game log: { id, text, cls }
  };
}

// ---------- Changing who is at the table (only between hands) ----------
// Open tables and the arena let people come and go. Seats are removed and added at the table's
// hand boundary, and the dealer button is kept sensible.
function addSeat(t, seat) {
  t.seats.push(seat);
}

function removeSeats(t, ids) {
  if (!ids.length) return;
  const dealerId = t.seats[t.dealerSeat] ? t.seats[t.dealerSeat].id : null;
  const before = t.dealerSeat;
  t.seats = t.seats.filter(s => !ids.includes(s.id));
  const i = dealerId === null ? -1 : t.seats.findIndex(s => s.id === dealerId);
  // The dealer left: step back one, so the button lands on whoever was next in line
  t.dealerSeat = i !== -1 ? i : Math.max(-1, Math.min(before, t.seats.length) - 1);
}

// ---------- Small helpers ----------
const cardFromId = id => ({ r: (id % 13) + 2, s: Math.floor(id / 13), id });   // inverse of makeDeck()'s ids

const pot = t => t.seats.reduce((sum, s) => sum + s.totalBet, 0);
const liveSeats = t => t.seats.filter(s => s.inHand && !s.folded);                    // still in the hand
const actableSeats = t => t.seats.filter(s => s.inHand && !s.folded && !s.allIn);     // still able to bet

function say(t, text, cls = '') {
  t.log.push({ id: ++t.logId, text, cls });
  if (t.log.length > 40) t.log.shift();
}

// The first seat at or after `start` (going around the table) that satisfies `test`; -1 if none
function seatFrom(t, start, test) {
  const n = t.seats.length;
  for (let k = 0; k < n; k++) {
    const i = (((start + k) % n) + n) % n;
    if (test(t.seats[i])) return i;
  }
  return -1;
}

function commit(s, amount) {
  s.chips -= amount;
  s.bet += amount;
  s.totalBet += amount;
}

function postBlind(t, s, amount, label) {
  const pay = Math.min(amount, s.chips);
  commit(s, pay);
  if (s.chips === 0) { s.allIn = true; s.status = 'All-in'; s.statusClass = 's-allin'; }
  say(t, `${s.name} posts the ${label} (${pay.toLocaleString()}).`);
}

// ---------- Starting a hand ----------
// Returns false if there aren't at least 2 players with chips. opts: { rng, deck } (deck is for tests).
function startHand(t, opts = {}) {
  const ready = t.seats.filter(s => s.chips > 0);
  if (ready.length < 2) return false;

  t.seats.forEach(s => Object.assign(s, {
    hole: [], bet: 0, totalBet: 0, folded: false, allIn: false, acted: false,
    inHand: s.chips > 0, handStartChips: s.chips, status: '', statusClass: '', showCards: false, score: 0,
  }));
  t.handNo++;
  t.board = [];
  t.deck = opts.deck ? opts.deck.slice() : shuffle(makeDeck(), opts.rng || Math.random);
  t.result = null;
  t.log = [];
  say(t, `— Hand #${t.handNo} —`, 'hand');

  // The dealer button moves to the next player who is in this hand
  t.dealerSeat = seatFrom(t, t.dealerSeat + 1, s => s.inHand);
  const n = ready.length;
  // Heads-up (2 players): the dealer is the small blind. Otherwise the blinds are the next two seats.
  t.sbSeat = n === 2 ? t.dealerSeat : seatFrom(t, t.dealerSeat + 1, s => s.inHand);
  t.bbSeat = seatFrom(t, t.sbSeat + 1, s => s.inHand);

  t.currentBet = 0;
  t.minRaise = t.bb;
  postBlind(t, t.seats[t.sbSeat], t.sb, 'small blind');
  postBlind(t, t.seats[t.bbSeat], t.bb, 'big blind');
  t.currentBet = t.bb;

  // Deal two hole cards to everyone, one at a time, starting with the small blind
  for (let round = 0; round < 2; round++) {
    let i = t.sbSeat;
    for (let k = 0; k < n; k++) {
      t.seats[i].hole.push(t.deck.pop());
      i = seatFrom(t, i + 1, s => s.inHand);
    }
  }

  t.phase = 'preflop';
  beginBetting(t, seatFrom(t, t.bbSeat + 1, s => s.inHand));   // before the flop: the seat after the big blind goes first
  return true;
}

// ---------- Betting ----------
// What the seat can legally do right now
function legal(t, idx) {
  const s = t.seats[idx];
  const toCall = Math.min(t.currentBet - s.bet, s.chips);
  const maxRaiseTo = s.bet + s.chips;
  const othersCanRespond = actableSeats(t).some(q => q !== s);
  return {
    toCall, canCheck: toCall === 0, chips: s.chips,
    canRaise: s.chips > toCall && othersCanRespond,
    minRaiseTo: Math.min(t.currentBet + t.minRaise, maxRaiseTo), maxRaiseTo,
    currentBet: t.currentBet, pot: pot(t),
  };
}

// The same "ctx" object the bots in bots.js expect
function botContext(t, idx) {
  const L = legal(t, idx);
  return {
    hole: t.seats[idx].hole, board: t.board.slice(), pot: L.pot, toCall: L.toCall,
    currentBet: L.currentBet, maxRaiseTo: L.maxRaiseTo, minRaiseTo: L.minRaiseTo,
    canRaise: L.canRaise, chips: L.chips, sb: t.sb, numOpp: liveSeats(t).length - 1,
  };
}

// Is this betting round finished? (same rules the single-player game uses)
function roundDone(t) {
  if (liveSeats(t).length <= 1) return true;
  const actable = actableSeats(t);
  if (actable.length === 0) return true;
  if (actable.every(s => s.acted && s.bet === t.currentBet)) return true;
  if (actable.length === 1 && actable[0].bet >= t.currentBet) return true;   // nobody left to bet against
  return false;
}

// Start a betting round with `startIdx` first to act, or skip it if nobody can bet (everyone all-in)
function beginBetting(t, startIdx) {
  const actable = actableSeats(t);
  const needsAction = actable.length >= 2 || actable.some(s => s.bet < t.currentBet);
  if (!needsAction) return endStreet(t);
  const next = seatFrom(t, startIdx, s => s.inHand && !s.folded && !s.allIn && !(s.acted && s.bet === t.currentBet));
  if (next === -1 || roundDone(t)) return endStreet(t);
  t.toAct = next;
}

// The betting round is over: deal the next street, or finish the hand
function endStreet(t) {
  t.toAct = -1;
  if (liveSeats(t).length <= 1 || t.phase === 'river') return finishHand(t);

  collectBets(t);
  t.phase = STREETS[STREETS.indexOf(t.phase) + 1];
  const count = t.phase === 'flop' ? 3 : 1;
  for (let k = 0; k < count; k++) t.board.push(t.deck.pop());
  // After the flop the first to act is the seat after the dealer (heads-up: the big blind)
  const headsUp = t.seats.filter(s => s.inHand).length === 2;
  beginBetting(t, headsUp ? t.bbSeat : t.sbSeat);
}

// New betting round: forget this round's bets (they stay counted in the pot via totalBet)
function collectBets(t) {
  t.seats.forEach(s => {
    s.bet = 0; s.acted = false;
    if (!s.folded && !s.allIn) { s.status = ''; s.statusClass = ''; }
  });
  t.currentBet = 0;
  t.minRaise = t.bb;
}

// A player acts. action = { type: 'fold' | 'call' | 'raise', amount? } ('call' with nothing to pay = check;
// for a raise, amount is the total bet you are raising TO). Returns { ok, error? }.
function act(t, idx, action) {
  if (t.toAct === -1 || idx !== t.toAct) return { ok: false, error: 'not your turn' };
  const s = t.seats[idx];
  const L = legal(t, idx);
  let a = action && ['fold', 'call', 'raise'].includes(action.type) ? action : { type: 'fold' };
  if (a.type === 'raise' && (!L.canRaise || !Number.isFinite(Number(a.amount)))) a = { type: 'call' };   // can't raise: just call

  if (a.type === 'fold') {
    s.folded = true;
    s.status = 'Fold'; s.statusClass = 's-fold';
    say(t, `${s.name} folds.`);
  } else if (a.type === 'call') {
    commit(s, L.toCall);
    s.status = L.toCall === 0 ? 'Check' : 'Call'; s.statusClass = '';
    say(t, L.toCall === 0 ? `${s.name} checks.` : `${s.name} calls ${L.toCall.toLocaleString()}.`);
  } else {
    const raiseTo = Math.max(L.minRaiseTo, Math.min(L.maxRaiseTo, Math.round(Number(a.amount))));
    const wasBet = t.currentBet === 0;
    commit(s, raiseTo - s.bet);
    const size = raiseTo - t.currentBet;
    if (size >= t.minRaise) t.minRaise = size;   // a full raise raises the minimum for the next one
    t.currentBet = raiseTo;
    t.seats.forEach(q => { if (q !== s) q.acted = false; });   // everyone must respond to a raise
    s.status = wasBet ? 'Bet' : 'Raise'; s.statusClass = 's-raise';
    say(t, `${s.name} ${wasBet ? 'bets' : 'raises to'} ${raiseTo.toLocaleString()}.`);
  }
  s.acted = true;
  if (s.chips === 0 && !s.folded) {
    s.allIn = true; s.status = 'All-in'; s.statusClass = 's-allin';
    say(t, `${s.name} is all-in!`);
  }

  if (roundDone(t)) endStreet(t);
  else {
    const next = seatFrom(t, idx + 1, q => q.inHand && !q.folded && !q.allIn && !(q.acted && q.bet === t.currentBet));
    if (next === -1) endStreet(t); else t.toAct = next;
  }
  return { ok: true };
}

// ---------- Winning ----------
// Split the money into the main pot and side pots (needed when someone is all-in for less).
function buildPots(t) {
  const inHand = t.seats.filter(s => s.inHand);
  const levels = [...new Set(inHand.filter(s => s.totalBet > 0).map(s => s.totalBet))].sort((a, b) => a - b);
  const pots = [];
  let prev = 0;
  for (const level of levels) {
    let amount = 0;
    inHand.forEach(s => { amount += Math.max(0, Math.min(s.totalBet, level) - prev); });
    pots.push({ amount, eligible: inHand.filter(s => !s.folded && s.totalBet >= level) });
    prev = level;
  }
  return pots;
}

function finishHand(t) {
  collectBets(t);
  t.toAct = -1;
  const live = liveSeats(t);
  const winners = new Map();   // seat -> amount won

  if (live.length === 1) {
    const total = pot(t);
    live[0].chips += total;
    winners.set(live[0], total);
    say(t, `${live[0].name} wins ${total.toLocaleString()} (everyone else folded).`, 'win');
  } else {
    live.forEach(s => { s.showCards = true; s.score = bestScore(s.hole.concat(t.board)); });
    for (const p of buildPots(t)) {
      const pool = p.eligible.length ? p.eligible : live;
      const top = Math.max(...pool.map(s => s.score));
      // Odd leftover chips go to the winner closest to the left of the dealer (the dealer himself is last)
      const n = t.seats.length;
      const distance = s => (t.seats.indexOf(s) - t.dealerSeat - 1 + n) % n;
      const best = pool.filter(s => s.score === top).sort((a, b) => distance(a) - distance(b));
      const share = Math.floor(p.amount / best.length);
      let leftover = p.amount - share * best.length;
      best.forEach(s => {
        const amt = share + (leftover-- > 0 ? 1 : 0);
        s.chips += amt;
        winners.set(s, (winners.get(s) || 0) + amt);
      });
    }
    winners.forEach((amt, s) => say(t, `${s.name} wins ${amt.toLocaleString()} with ${handName(s.score)}.`, 'win'));
  }

  winners.forEach((amt, s) => { s.status = `Wins ${amt.toLocaleString()}`; s.statusClass = 's-win'; });
  t.result = {
    showdown: live.length > 1,
    winners: [...winners].map(([s, amount]) => ({ id: s.id, name: s.name, amount, hand: live.length > 1 ? handName(s.score) : null })),
  };
  t.seats.forEach(s => { s.totalBet = 0; s.bet = 0; });
  t.phase = 'hand-over';
}

// ---------- What other players are allowed to see ----------
// A JSON-safe snapshot of the table with every hole card hidden except at a showdown.
// Cards are sent as ids 0..51 (rebuild with cardFromId). Nothing secret is in here, so it is safe to publish.
function publicView(t) {
  const seatId = i => (i >= 0 && t.seats[i] ? t.seats[i].id : null);
  return {
    handNo: t.handNo, phase: t.phase, sb: t.sb, bb: t.bb,
    dealer: seatId(t.dealerSeat), sbSeat: seatId(t.sbSeat), bbSeat: seatId(t.bbSeat),
    board: t.board.map(c => c.id), pot: pot(t), currentBet: t.currentBet, minRaise: t.minRaise,
    toAct: seatId(t.toAct), result: t.result,
    seats: t.seats.map(s => ({
      id: s.id, name: s.name, avatar: s.avatar, color: s.color, isBot: s.isBot,
      chips: s.chips, bet: s.bet, totalBet: s.totalBet, folded: s.folded, allIn: s.allIn, inHand: s.inHand,
      status: s.status, statusClass: s.statusClass, showCards: s.showCards, waiting: Boolean(s.waiting),
      holeCount: s.hole.length, hole: s.showCards ? s.hole.map(c => c.id) : [],
    })),
  };
}

// What a seat may do, worked out from the public view alone (so a player's browser can build its
// own Fold/Call/Raise controls without ever seeing the real table). Same numbers as legal() above.
function legalFromView(view, id) {
  const me = view.seats.find(s => s.id === id);
  if (!me) return null;
  const toCall = Math.min(view.currentBet - me.bet, me.chips);
  const maxRaiseTo = me.bet + me.chips;
  const othersCanRespond = view.seats.some(s => s.id !== id && s.inHand && !s.folded && !s.allIn);
  return {
    toCall, canCheck: toCall === 0, chips: me.chips,
    canRaise: me.chips > toCall && othersCanRespond,
    minRaiseTo: Math.min(view.currentBet + view.minRaise, maxRaiseTo), maxRaiseTo,
    currentBet: view.currentBet, pot: view.pot,
  };
}
