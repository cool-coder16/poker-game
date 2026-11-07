// arena.js — the rules of the Arena. Plain functions: no network, no screen.
//
// An Arena is a 30-minute window that starts at :00 and :30 (UTC), so everyone agrees on when it is
// without any server. During the window you sit at an arena table. A table plays short ROUNDS:
// everyone starts the round with the same chips, 10 hands are played (blinds rise), and your
// finishing place in the round earns points. Your arena score is the total of your round points.
// There is no elimination: if you bust you just wait for the next round.

const ARENA_MINUTES = 30;
const ARENA_ROUND_HANDS = 10;      // hands per round
const ARENA_HANDS_PER_LEVEL = 3;   // the blinds step up every 3 hands inside a round

const pad2 = n => String(n).padStart(2, '0');

// The arena window containing `date`: { id: '20261107-1930', start, end } (start/end are ms since 1970)
function arenaWindow(date = new Date()) {
  const len = ARENA_MINUTES * 60000;
  const start = Math.floor(date.getTime() / len) * len;
  const d = new Date(start);
  const id = `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}-${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}`;
  return { id, start, end: start + len };
}

// "19:30 UTC" for a window id like 20261107-1930
function arenaLabel(id) {
  const [, time] = id.split('-');
  return `${time.slice(0, 2)}:${time.slice(2)} UTC`;
}

// "12m 30s" until `ms`
function countdownText(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${pad2(s % 60)}s` : `${s}s`;
}

// Points for finishing a round of n players in place `rank` (1 = best): two points for every player you
// beat, plus a 2-point bonus for winning. So a 6-player round pays 12, 8, 6, 4, 2, 0.
const arenaPoints = (rank, n) => (n - rank) * 2 + (rank === 1 ? 2 : 0);

// rows: [{ id, chips }] -> same rows with `rank` and `points` added, best first.
// Players with the same chips share a place (and its points).
function scoreRound(rows) {
  const sorted = rows.slice().sort((a, b) => b.chips - a.chips);
  return sorted.map(r => {
    const rank = 1 + sorted.filter(o => o.chips > r.chips).length;
    return { ...r, rank, points: arenaPoints(rank, sorted.length) };
  });
}

// Every arena table publishes its own scores; add them up per player across all tables.
// tables: { <tableCode>: { scores: { <uid>: { name, points, rounds, wins } } } } -> standings, best first
function aggregateArena(tables) {
  const totals = {};
  Object.values(tables || {}).forEach(table => {
    Object.entries((table && table.scores) || {}).forEach(([uid, s]) => {
      const t = totals[uid] || (totals[uid] = { uid, name: s.name, points: 0, rounds: 0, wins: 0 });
      t.points += s.points || 0;
      t.rounds += s.rounds || 0;
      t.wins += s.wins || 0;
    });
  });
  return Object.values(totals).sort((a, b) => b.points - a.points || b.wins - a.wins || a.name.localeCompare(b.name));
}
