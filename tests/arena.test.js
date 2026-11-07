// tests/arena.test.js — run with:  node tests/arena.test.js
const assert = require('assert');
const { load } = require('./helpers');
load('arena.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL  ' + name + '\n' + e.stack); process.exitCode = 1; }
}
console.log('arena tests');

test('windows start at :00 and :30 UTC and last 30 minutes', () => {
  const w = arenaWindow(new Date('2026-11-07T19:47:12Z'));
  assert.strictEqual(w.id, '20261107-1930');
  assert.strictEqual(new Date(w.start).toISOString(), '2026-11-07T19:30:00.000Z');
  assert.strictEqual(new Date(w.end).toISOString(), '2026-11-07T20:00:00.000Z');
  assert.strictEqual(arenaWindow(new Date('2026-11-07T19:59:59Z')).id, '20261107-1930');
  assert.strictEqual(arenaWindow(new Date('2026-11-07T20:00:00Z')).id, '20261107-2000');
  assert.strictEqual(arenaWindow(new Date('2026-12-31T23:45:00Z')).id, '20261231-2330');
  assert.strictEqual(arenaWindow(new Date('2027-01-01T00:05:00Z')).id, '20270101-0000');
});

test('labels and countdown text', () => {
  assert.strictEqual(arenaLabel('20261107-1930'), '19:30 UTC');
  assert.strictEqual(countdownText(12 * 60000 + 30000), '12m 30s');
  assert.strictEqual(countdownText(45000), '45s');
  assert.strictEqual(countdownText(-5), '0s');
});

test('points: two per player beaten, plus a winner bonus', () => {
  assert.deepStrictEqual([1, 2, 3, 4, 5, 6].map(r => arenaPoints(r, 6)), [12, 8, 6, 4, 2, 0]);
  assert.deepStrictEqual([1, 2].map(r => arenaPoints(r, 2)), [4, 0]);
  assert.deepStrictEqual([1, 2, 3].map(r => arenaPoints(r, 3)), [6, 2, 0]);
});

test('scoreRound ranks by chips; ties share a place and its points', () => {
  const rows = scoreRound([{ id: 'a', chips: 500 }, { id: 'b', chips: 2000 }, { id: 'c', chips: 500 }, { id: 'd', chips: 0 }]);
  assert.deepStrictEqual(rows.map(r => [r.id, r.rank, r.points]), [['b', 1, 8], ['a', 2, 4], ['c', 2, 4], ['d', 4, 0]]);
});

test('aggregateArena sums across tables and breaks ties by wins, then name (Ann and Cat tie on wins; Dan has fewer)', () => {
  const standings = aggregateArena({
    T1: { scores: { ann: { name: 'Ann', points: 12, rounds: 1, wins: 1 }, ben: { name: 'Ben', points: 8, rounds: 1, wins: 0 } } },
    T2: { scores: { ann: { name: 'Ann', points: 2, rounds: 1, wins: 0 }, cat: { name: 'Cat', points: 14, rounds: 2, wins: 1 }, dan: { name: 'Dan', points: 14, rounds: 2, wins: 0 } } },
  });
  assert.deepStrictEqual(standings.map(s => [s.name, s.points, s.rounds]), [['Ann', 14, 2], ['Cat', 14, 2], ['Dan', 14, 2], ['Ben', 8, 1]]);
  assert.deepStrictEqual(aggregateArena(null), []);
});

const T = (...rows) => ({ T1: { scores: Object.fromEntries(rows.map(([uid, points, rounds]) => [uid, { name: uid, points, rounds, wins: 0 }])) } });

test('arena end time and when scores are final', () => {
  assert.strictEqual(new Date(arenaEndOf('20261107-1930')).toISOString(), '2026-11-07T20:00:00.000Z');
  assert.strictEqual(arenaEndOf('nonsense'), Infinity);
  const end = arenaEndOf('20261107-1930');
  assert.strictEqual(arenaSettled('20261107-1930', end + 4 * 60000), false, 'too soon');
  assert.strictEqual(arenaSettled('20261107-1930', end + 5 * 60000), true);
  assert.strictEqual(arenaSettled('bad-id', Date.now() + 1e12), false, 'a bad id is never settled');
});

test('arenaResult: top 3 earn 3/2/1 rating points, others 0', () => {
  const tables = T(['a', 30, 3], ['b', 20, 3], ['c', 10, 2], ['d', 4, 2], ['e', 2, 3]);
  assert.deepStrictEqual(['a', 'b', 'c', 'd', 'e'].map(u => arenaResult(tables, u).points), [3, 2, 1, 0, 0]);
  assert.deepStrictEqual(arenaResult(tables, 'b'), { counted: true, rank: 2, of: 5, points: 2 });
});

test('arenaResult: needs 2 rounds, and 3 qualified players in the arena', () => {
  const tables = T(['a', 30, 3], ['b', 20, 3], ['c', 50, 1]);   // c won big but only played 1 round: doesn't count
  assert.deepStrictEqual(arenaResult(tables, 'c'), { counted: false, rank: 0, of: 2, points: 0 });
  assert.strictEqual(arenaResult(tables, 'a').points, 0, 'only 2 qualified players: nobody earns points');
  assert.strictEqual(arenaResult(tables, 'a').counted, true);
  assert.deepStrictEqual(arenaResult(null, 'a'), { counted: false, rank: 0, of: 0, points: 0 });
});

test('arenaResult: equal points share a place', () => {
  const tables = T(['a', 20, 2], ['b', 20, 2], ['c', 10, 2], ['d', 5, 2]);
  assert.deepStrictEqual(['a', 'b', 'c', 'd'].map(u => arenaResult(tables, u).rank), [1, 1, 3, 4]);
  assert.deepStrictEqual(['a', 'b', 'c', 'd'].map(u => arenaResult(tables, u).points), [3, 3, 1, 0]);
});

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}`);
