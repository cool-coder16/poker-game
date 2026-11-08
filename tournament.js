// tournament.js — the rules of tournaments. Plain functions: no network, no screen.
//
// Two kinds, both a single table of up to 8 players playing a freezeout (no rebuys; blinds rise; the last
// player with chips wins):
//   Sit & Go   anyone can start one; it begins as soon as the table is full.
//   Scheduled  one every 2 hours (even hours, UTC). Register any time in the hour before; it begins at the
//              start time if at least 3 people are there, and is cancelled if not.
// (Real multi-table tournaments need a server to move players between tables. See MULTIPLAYER.md.)
//
// Finishing place earns rating points: 1st 5, 2nd 3, 3rd 1 (a 3-player tournament pays 3, 1, 0).
// To count, at least 3 HUMAN players must have started (bots may fill seats, but never earn points).

const TOURNEY_EVERY_HOURS = 2;
const TOURNEY_OPENS_MINUTES = 60;      // registration for a scheduled tournament opens this long before the start
const TOURNEY_MIN_PLAYERS = 3;
const TOURNEY_MAX_PLAYERS = 8;
const TOURNEY_START_CHIPS = 1000;
const TOURNEY_SB = 10;
const TOURNEY_HANDS_PER_LEVEL = 5;     // blinds rise every 5 hands, so a tournament finishes in reasonable time
const TOURNEY_SETTLE_WAIT_MS = 6 * 3600000;   // if a tournament's results never show up, stop waiting after this long

const TOURNEY_POINTS = [5, 3, 1];
const TOURNEY_POINTS_SMALL = [3, 1, 0];   // when exactly 3 humans played

// Rating points for finishing `place` (1 = winner) among `humans` human players
function tournamentPoints(place, humans) {
  if (humans < TOURNEY_MIN_PLAYERS) return 0;
  const table = humans === TOURNEY_MIN_PLAYERS ? TOURNEY_POINTS_SMALL : TOURNEY_POINTS;
  return table[place - 1] || 0;
}

// ---------- The schedule ----------
// The start of the scheduled tournament slot containing `date` (ms since 1970)
function tourneyStartOf(date = new Date()) {
  const len = TOURNEY_EVERY_HOURS * 3600000;
  return Math.floor(date.getTime() / len) * len;
}

// The next slot that has not started yet
function nextTourneyStart(date = new Date()) {
  return tourneyStartOf(date) + TOURNEY_EVERY_HOURS * 3600000;
}

// The room code for a scheduled slot, like "TN2026110714" (the same for everyone, so everyone finds the same room)
function tourneyCode(startMs) {
  const d = new Date(startMs);
  const p = n => String(n).padStart(2, '0');
  return `TN${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}`;
}

// "14:00 UTC"
const tourneyLabel = startMs => `${String(new Date(startMs).getUTCHours()).padStart(2, '0')}:00 UTC`;

// Can people register for the slot starting at startMs right now?
function tourneyRegistrationOpen(startMs, now = Date.now()) {
  return now >= startMs - TOURNEY_OPENS_MINUTES * 60000 && now < startMs;
}

// ---------- Starting ----------
// What should the host do with a tournament lobby right now?  'wait' | 'start' | 'cancel'
// meta: { kind, size, startAt, minPlayers }.  here: how many human players are connected.  total: humans + bots seated.
function tourneyAction(meta, here, total, now = Date.now()) {
  if (meta.kind === 'sng') return total >= meta.size ? 'start' : 'wait';
  if (meta.kind === 'scheduled') {
    if (now < meta.startAt) return 'wait';
    return here >= (meta.minPlayers || TOURNEY_MIN_PLAYERS) ? 'start' : 'cancel';
  }
  return 'wait';
}

// ---------- Finishing places ----------
// standing: seats still holding chips when the game ends, best first.  eliminated: ids in the order
// they were knocked out (first out first). Returns [{ id, place }] best first: the survivors take the top
// places, then whoever was knocked out last, and so on.
function finalPlaces(standing, eliminated) {
  const places = [];
  standing.forEach((id, i) => places.push({ id, place: i + 1 }));
  for (let i = eliminated.length - 1; i >= 0; i--) places.push({ id: eliminated[i], place: places.length + 1 });
  return places;
}

// Players knocked out in the SAME hand: the one who started the hand with fewer chips places lower.
// busted: [{ id, startChips }] -> ids, first out (worst) first
function knockoutOrder(busted) {
  return busted.slice().sort((a, b) => a.startChips - b.startChips).map(b => b.id);
}
