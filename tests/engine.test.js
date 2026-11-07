// tests/engine.test.js — run with:  node tests/engine.test.js
// Plain asserts, no test library needed.
const assert = require('assert');
const { load, stack, seeded } = require('./helpers');
load('poker.js', 'engine.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL  ' + name + '\n' + e.stack); process.exitCode = 1; }
}

const mk = (chipsList, sb = 10) => createTable({
  sb, seats: chipsList.map((chips, i) => newSeat({ id: 'p' + i, name: 'P' + i, chips })),
});
const call = { type: 'call' };
const total = t => t.seats.reduce((s, x) => s + x.chips + x.totalBet, 0);

console.log('engine tests');

test('heads-up: dealer is the small blind, acts first before the flop, big blind first after', () => {
  const t = mk([1000, 1000]);
  assert(startHand(t, { deck: stack(['As', 'Kd', 'Ah', 'Kc', '2c', '7d', '9h', '3s', '4d']) }));
  assert.strictEqual(t.dealerSeat, 0);
  assert.strictEqual(t.sbSeat, 0);
  assert.strictEqual(t.bbSeat, 1);
  assert.strictEqual(t.toAct, 0, 'dealer/SB acts first preflop');
  assert.deepStrictEqual(t.seats[0].hole.map(c => c.r), [14, 14]);   // SB is dealt first: As and Ah
  act(t, 0, call);          // SB completes
  act(t, 1, call);          // BB checks
  assert.strictEqual(t.phase, 'flop');
  assert.strictEqual(t.board.length, 3);
  assert.strictEqual(t.toAct, 1, 'big blind acts first after the flop');
});

test('cards are dealt starting with the small blind', () => {
  const t = mk([1000, 1000, 1000]);
  startHand(t, { deck: stack(['As', 'Kd', 'Qc', 'Ah', 'Kh', 'Qh', '2c', '7d', '9h', '3s', '4d']) });
  // dealer = seat 0, SB = seat 1 gets the first and fourth cards
  assert.deepStrictEqual(t.seats[1].hole.map(c => c.r), [14, 14]);   // As, Ah
  assert.deepStrictEqual(t.seats[2].hole.map(c => c.r), [13, 13]);   // Kd, Kh
  assert.deepStrictEqual(t.seats[0].hole.map(c => c.r), [12, 12]);   // Qc, Qh
});

test('everyone folds: the last player wins the pot', () => {
  const t = mk([1000, 1000, 1000]);
  startHand(t);
  act(t, t.toAct, { type: 'fold' });
  act(t, t.toAct, { type: 'fold' });
  assert.strictEqual(t.phase, 'hand-over');
  assert.strictEqual(t.result.showdown, false);
  assert.strictEqual(t.result.winners[0].amount, 30);   // 10 + 20 blinds
  assert.strictEqual(total(t), 3000);
});

test('showdown: best hand wins the pot', () => {
  const t = mk([1000, 1000]);
  // P0 (SB) gets AA, P1 gets KK, board has no help
  startHand(t, { deck: stack(['As', 'Ks', 'Ah', 'Kh', '2c', '7d', '9h', '3s', '4d']) });
  act(t, 0, call); act(t, 1, call);                       // preflop
  for (let s = 0; s < 3; s++) { act(t, t.toAct, call); act(t, t.toAct, call); }   // flop, turn, river
  assert.strictEqual(t.phase, 'hand-over');
  assert.strictEqual(t.result.showdown, true);
  assert.strictEqual(t.result.winners[0].id, 'p0');
  assert.strictEqual(t.seats[0].chips, 1020);
  assert.strictEqual(t.seats[1].chips, 980);
});

test('side pots: short all-in can only win what it matched', () => {
  const t = mk([100, 300, 1000]);
  // seat0 (short) gets the best hand, seat1 second best, seat2 worst. Dealer = seat 0, SB = seat 1, BB = seat 2.
  // Deal order starts with the SB: seat1, seat2, seat0, seat1, seat2, seat0
  startHand(t, { deck: stack(['Kd', '7c', 'As', 'Kh', '7d', 'Ah', '2c', '5d', '9h', '3s', '4d']) });
  // first to act preflop = seat 0 (after the big blind): shove all-in
  assert.strictEqual(t.toAct, 0);
  act(t, 0, { type: 'raise', amount: 100 });
  act(t, 1, { type: 'raise', amount: 300 });   // seat 1 all-in
  act(t, 2, call);                              // seat 2 calls 300
  assert.strictEqual(t.phase, 'hand-over');
  // seat0 AA wins the 300 main pot (100 x 3); seat1 KK wins the 400 side pot (200 x 2); seat2 gets 0
  assert.strictEqual(t.seats[0].chips, 300);
  assert.strictEqual(t.seats[1].chips, 400);
  assert.strictEqual(t.seats[2].chips, 700);
  assert.strictEqual(total(t), 1400);
});

test('tie: the pot is split, odd chip goes to the player left of the dealer', () => {
  const t = mk([1000, 1000, 1000], 5);   // blinds 5/10, dealer = seat 0, SB = seat 1, BB = seat 2
  // Deal order: seat1, seat2, seat0, seat1, seat2, seat0. Seats 0 and 2 both just play the 5-9 straight on the board.
  startHand(t, { deck: stack(['4h', '2c', '2d', '4d', '3c', '3d', '5s', '6s', '7s', '8s', '9s']) });
  act(t, 0, call);                       // seat 0 calls 10
  act(t, 1, { type: 'fold' });           // SB folds, leaving 5 dead chips in the pot (pot = 25)
  act(t, 2, call);                       // BB checks
  for (let s = 0; s < 3; s++) { act(t, t.toAct, call); act(t, t.toAct, call); }
  assert.strictEqual(t.phase, 'hand-over');
  // 25 split two ways = 12 and 13; the odd chip goes to the first winner left of the dealer: seat 2
  assert.strictEqual(t.seats[2].chips, 1000 - 10 + 13);
  assert.strictEqual(t.seats[0].chips, 1000 - 10 + 12);
  assert.strictEqual(t.seats[1].chips, 995);
  assert.strictEqual(total(t), 3000);
});

test('illegal moves are rejected or softened', () => {
  const t = mk([1000, 1000]);
  startHand(t);
  assert.strictEqual(act(t, 1, call).ok, false, 'not your turn');
  const before = t.seats[0].chips;
  act(t, 0, { type: 'raise', amount: 'abc' });        // nonsense amount becomes a call
  assert.strictEqual(t.seats[0].chips, before - 10);
  assert.strictEqual(act(t, 0, call).ok, false, 'turn has passed');
});

test('raise is clamped to the legal range', () => {
  const t = mk([1000, 1000]);
  startHand(t);
  act(t, 0, { type: 'raise', amount: 1 });            // far below the minimum: becomes the minimum raise
  assert.strictEqual(t.currentBet, 40);               // min raise = current 20 + 20
  act(t, 1, { type: 'raise', amount: 99999 });        // above all chips: becomes all-in
  assert.strictEqual(t.seats[1].chips, 0);
});

test('a player with no chips is skipped; hand needs 2 players', () => {
  const t = mk([1000, 0, 1000]);
  assert(startHand(t));
  assert.strictEqual(t.seats[1].inHand, false);
  const t2 = mk([1000, 0, 0]);
  assert.strictEqual(startHand(t2), false);
});

test('publicView never leaks hole cards before a showdown', () => {
  const t = mk([1000, 1000, 1000]);
  startHand(t);
  const view = publicView(t);
  view.seats.forEach(s => { assert.deepStrictEqual(s.hole, []); assert.strictEqual(s.holeCount, 2); });
  assert(!JSON.stringify(view).includes('"deck"'));
});

test('random play: chips are conserved, hands always finish, no negative chips (3000 hands)', () => {
  const rng = seeded(12345);
  for (let game = 0; game < 300; game++) {
    const n = 2 + Math.floor(rng() * 7);
    const stacks = Array.from({ length: n }, () => 50 + Math.floor(rng() * 2000));
    const t = mk(stacks, [5, 10, 25][Math.floor(rng() * 3)]);
    const startTotal = stacks.reduce((a, b) => a + b, 0);
    for (let h = 0; h < 10; h++) {
      if (!startHand(t, { rng })) break;
      let steps = 0;
      while (t.phase !== 'hand-over') {
        assert(++steps < 300, 'hand did not finish');
        const L = legal(t, t.toAct);
        const roll = rng();
        let a;
        if (roll < 0.15 && L.toCall > 0) a = { type: 'fold' };
        else if (roll < 0.45 && L.canRaise) a = { type: 'raise', amount: L.minRaiseTo + Math.floor(rng() * (L.maxRaiseTo - L.minRaiseTo + 1)) };
        else a = call;
        assert(act(t, t.toAct, a).ok);
        assert.strictEqual(total(t), startTotal, 'chips changed mid-hand');
        t.seats.forEach(s => assert(s.chips >= 0, 'negative chips'));
      }
      assert.strictEqual(t.seats.reduce((s, x) => s + x.chips, 0), startTotal);
    }
  }
});

test('legalFromView matches legal() for every seat, at every point of random hands', () => {
  const rng = seeded(777);
  for (let g = 0; g < 100; g++) {
    const t = mk([300, 500, 800, 1200].slice(0, 2 + Math.floor(rng() * 3)), 10);
    if (!startHand(t, { rng })) continue;
    while (t.phase !== 'hand-over') {
      const view = publicView(t);
      t.seats.forEach((s, i) => {
        if (!s.inHand) return;
        const a = legal(t, i), b = legalFromView(view, s.id);
        ['toCall', 'canRaise', 'minRaiseTo', 'maxRaiseTo', 'pot'].forEach(k => assert.strictEqual(b[k], a[k], k));
      });
      const L = legal(t, t.toAct);
      act(t, t.toAct, rng() < 0.3 && L.canRaise ? { type: 'raise', amount: L.minRaiseTo } : call);
    }
  }
});

test('removing a seat keeps the dealer button sensible; adding a seat joins the next hand', () => {
  const t = mk([1000, 1000, 1000, 1000]);
  startHand(t);                                   // dealer = seat 0
  while (t.phase !== 'hand-over') act(t, t.toAct, { type: 'fold' });
  const dealerId = t.seats[t.dealerSeat].id;
  removeSeats(t, ['p2']);                         // someone not the dealer leaves
  assert.strictEqual(t.seats.length, 3);
  assert.strictEqual(t.seats[t.dealerSeat].id, dealerId, 'the dealer is still the dealer');
  // the dealer leaves: the button steps back so the NEXT player becomes dealer
  const t2 = mk([1000, 1000, 1000, 1000]);
  startHand(t2);
  while (t2.phase !== 'hand-over') act(t2, t2.toAct, { type: 'fold' });
  t2.dealerSeat = 1;                              // pretend seat 1 (p1) dealt last
  removeSeats(t2, ['p1']);
  startHand(t2);
  assert.strictEqual(t2.seats[t2.dealerSeat].id, 'p2', 'p2 (next after the old dealer) deals now');
  // a newcomer is dealt in
  addSeat(t2, newSeat({ id: 'new', name: 'New', chips: 500 }));
  while (t2.phase !== 'hand-over') act(t2, t2.toAct, { type: 'fold' });
  startHand(t2);
  assert.strictEqual(t2.seats.find(s => s.id === 'new').inHand, true);
});

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}`);
