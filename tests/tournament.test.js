// tests/tournament.test.js — run with:  node tests/tournament.test.js
const assert = require('assert');
const { load } = require('./helpers');
load('tournament.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL  ' + name + '\n' + e.stack); process.exitCode = 1; }
}
console.log('tournament tests');

test('points: 5/3/1, a 3-player tournament pays 3/1/0, fewer than 3 humans pays nothing', () => {
  assert.deepStrictEqual([1, 2, 3, 4].map(p => tournamentPoints(p, 6)), [5, 3, 1, 0]);
  assert.deepStrictEqual([1, 2, 3].map(p => tournamentPoints(p, 3)), [3, 1, 0]);
  assert.deepStrictEqual([1, 2].map(p => tournamentPoints(p, 2)), [0, 0]);
});

test('scheduled slots: every 2 hours on even UTC hours', () => {
  const at = iso => new Date(iso);
  assert.strictEqual(new Date(tourneyStartOf(at('2026-11-07T15:40:00Z'))).toISOString(), '2026-11-07T14:00:00.000Z');
  assert.strictEqual(new Date(tourneyStartOf(at('2026-11-07T14:00:00Z'))).toISOString(), '2026-11-07T14:00:00.000Z');
  assert.strictEqual(new Date(nextTourneyStart(at('2026-11-07T15:40:00Z'))).toISOString(), '2026-11-07T16:00:00.000Z');
  assert.strictEqual(new Date(nextTourneyStart(at('2026-11-07T23:59:00Z'))).toISOString(), '2026-11-08T00:00:00.000Z');
  assert.strictEqual(tourneyCode(Date.parse('2026-11-07T14:00:00Z')), 'TN2026110714');
  assert.strictEqual(tourneyCode(Date.parse('2027-01-01T00:00:00Z')), 'TN2027010100');
  assert.strictEqual(tourneyLabel(Date.parse('2026-11-07T08:00:00Z')), '08:00 UTC');
});

test('registration opens an hour before and closes at the start', () => {
  const start = Date.parse('2026-11-07T14:00:00Z');
  assert.strictEqual(tourneyRegistrationOpen(start, start - 61 * 60000), false);
  assert.strictEqual(tourneyRegistrationOpen(start, start - 59 * 60000), true);
  assert.strictEqual(tourneyRegistrationOpen(start, start), false);
});

test('what the host does: Sit & Go starts when full; scheduled starts on time with enough players, else cancels', () => {
  assert.strictEqual(tourneyAction({ kind: 'sng', size: 4 }, 3, 3), 'wait');
  assert.strictEqual(tourneyAction({ kind: 'sng', size: 4 }, 3, 4), 'start', 'bots count toward a full table');
  const sched = { kind: 'scheduled', startAt: 1000, minPlayers: 3 };
  assert.strictEqual(tourneyAction(sched, 5, 5, 999), 'wait', 'not yet');
  assert.strictEqual(tourneyAction(sched, 3, 3, 1000), 'start');
  assert.strictEqual(tourneyAction(sched, 2, 2, 5000), 'cancel');
  assert.strictEqual(tourneyAction({ kind: 'freezeout' }, 9, 9), 'wait', 'private rooms start by hand');
});

test('final places: survivors first, then the last one knocked out, and so on', () => {
  assert.deepStrictEqual(finalPlaces(['ann'], ['dan', 'cat', 'ben']), [
    { id: 'ann', place: 1 }, { id: 'ben', place: 2 }, { id: 'cat', place: 3 }, { id: 'dan', place: 4 }]);
  assert.deepStrictEqual(finalPlaces(['x', 'y'], ['z']).map(p => p.id + p.place), ['x1', 'y2', 'z3']);
});

test('knocked out in the same hand: fewer starting chips places lower', () => {
  assert.deepStrictEqual(knockoutOrder([{ id: 'a', startChips: 500 }, { id: 'b', startChips: 100 }, { id: 'c', startChips: 300 }]), ['b', 'c', 'a']);
});

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}`);
