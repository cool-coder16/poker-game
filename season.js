// season.js — the rules of the weekly competition. Plain functions, no Firebase, no page code.
//
// Singleplayer is a "run": you start with 1,000 chips, there are no rebuys, and the run ends the
// moment anyone at the table goes bankrupt. Your run score is the chips you have at that moment
// (0 if it was you). Blinds rise every 10 hands so a run can't drag on forever.
// A "season" is one week (Monday 00:00 UTC to the next Monday): your season score is your BEST
// run that week. Play at least 30 hands in the week to qualify; the final ranking turns into
// rating points that add up forever.

const RUN_START_CHIPS = 1000;
// Blinds rise during a run so it always finishes: the small blind steps up every 10 hands
// (the big blind is double). Everyone gets the same schedule, so every score is comparable.
const RUN_BLINDS = [10, 15, 25, 50, 75, 100, 150, 200, 300, 400, 600, 800, 1000];
const RUN_HANDS_PER_LEVEL = 10;
const SEASON_MIN_HANDS = 30;

// Small blind for hand number `handNumber` (1 = first hand of the run); stays at the top level once reached
function runSmallBlind(handNumber) {
  const level = Math.floor((handNumber - 1) / RUN_HANDS_PER_LEVEL);
  return RUN_BLINDS[Math.min(level, RUN_BLINDS.length - 1)];
}

// Season id like "2026-W45" (ISO week number, in UTC so everyone's week changes at the same moment)
function seasonId(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;            // Monday = 1 ... Sunday = 7
  d.setUTCDate(d.getUTCDate() + 4 - day);    // the Thursday of this week decides which year it belongs to
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// The moment the current season ends (next Monday 00:00 UTC)
function seasonEnd(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + (8 - day));
  return d;
}

// "3d 4h" / "5h 12m" / "9m" until the season ends
function timeLeftText(date = new Date()) {
  const mins = Math.max(0, Math.floor((seasonEnd(date) - date) / 60000));
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
  if (d > 0) return `${d}d ${h}h`;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// Rating points for a final season placement among qualified players
function placementPoints(rank) {
  if (rank === 1) return 100;
  if (rank === 2) return 70;
  if (rank === 3) return 50;
  if (rank <= 10) return 30;
  return 10;
}

// Big blinds won per 100 hands: the standard poker skill number (fair across different blind sizes)
function bbPer100(bbNet, hands) {
  return hands > 0 ? (bbNet / hands) * 100 : 0;
}

// "+12.5" / "-3.0" / "0.0"
function signed(n, digits = 1) {
  return (n > 0 ? '+' : '') + n.toFixed(digits);
}

// "2026-W45" -> "Week 45, 2026"
function seasonLabel(id) {
  const [year, week] = id.split('-W');
  return `Week ${Number(week)}, ${year}`;
}
