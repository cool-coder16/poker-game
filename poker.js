// poker.js — cards, deck and hand evaluation. No UI code in here.
// (Plain <script> files share globals, so game.js and bots.js can call these directly.)

const SUIT_SYMBOLS = ['♠', '♥', '♦', '♣'];
const RANK_LABELS = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const rankLabel = r => RANK_LABELS[r] || String(r);
const RANK_PLURALS = { 2: 'Twos', 3: 'Threes', 4: 'Fours', 5: 'Fives', 6: 'Sixes', 7: 'Sevens',
  8: 'Eights', 9: 'Nines', 10: 'Tens', 11: 'Jacks', 12: 'Queens', 13: 'Kings', 14: 'Aces' };

// A card is { r: 2..14 (14 = Ace), s: 0..3 (suit index), id: unique 0..51 }
function makeDeck() {
  const deck = [];
  for (let s = 0; s < 4; s++) {
    for (let r = 2; r <= 14; r++) deck.push({ r, s, id: s * 13 + (r - 2) });
  }
  return deck;
}

// Fisher-Yates shuffle (in place)
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Score exactly 5 cards as ONE number so hands compare with a simple > or <.
// score = category * 15^5 + tiebreaker ranks packed in base 15.
// Categories: 8 straight flush, 7 four of a kind, 6 full house, 5 flush, 4 straight,
//             3 three of a kind, 2 two pair, 1 pair, 0 high card.
function eval5(cards) {
  const ranks = cards.map(c => c.r).sort((a, b) => b - a);
  const flush = cards.every(c => c.s === cards[0].s);

  // Count how many of each rank we have
  const counts = new Array(15).fill(0);
  ranks.forEach(r => counts[r]++);
  // groups = [[count, rank], ...] sorted by count desc, then rank desc
  const groups = [];
  for (let r = 14; r >= 2; r--) if (counts[r]) groups.push([counts[r], r]);
  groups.sort((a, b) => b[0] - a[0]);

  // Straight: 5 different ranks in a row. A-2-3-4-5 ("wheel") counts as 5-high.
  let straightHigh = 0;
  if (groups.length === 5) {
    if (ranks[0] - ranks[4] === 4) straightHigh = ranks[0];
    else if (ranks[0] === 14 && ranks[1] === 5) straightHigh = 5;
  }

  let cat, tiebreak;
  if (straightHigh && flush) { cat = 8; tiebreak = [straightHigh]; }
  else if (groups[0][0] === 4) { cat = 7; tiebreak = groups.map(g => g[1]); }
  else if (groups[0][0] === 3 && groups[1][0] === 2) { cat = 6; tiebreak = groups.map(g => g[1]); }
  else if (flush) { cat = 5; tiebreak = ranks; }
  else if (straightHigh) { cat = 4; tiebreak = [straightHigh]; }
  else if (groups[0][0] === 3) { cat = 3; tiebreak = groups.map(g => g[1]); }
  else if (groups[0][0] === 2 && groups[1][0] === 2) { cat = 2; tiebreak = groups.map(g => g[1]); }
  else if (groups[0][0] === 2) { cat = 1; tiebreak = groups.map(g => g[1]); }
  else { cat = 0; tiebreak = ranks; }

  let score = cat;
  for (let i = 0; i < 5; i++) score = score * 15 + (tiebreak[i] || 0);
  return score;
}

// All ways to pick 5 positions out of n (n = 5, 6 or 7). Cached because it never changes.
const comboCache = {};
function fiveCardCombos(n) {
  if (comboCache[n]) return comboCache[n];
  const out = [];
  (function pick(start, cur) {
    if (cur.length === 5) { out.push(cur.slice()); return; }
    for (let i = start; i < n; i++) { cur.push(i); pick(i + 1, cur); cur.pop(); }
  })(0, []);
  return (comboCache[n] = out);
}

// Best 5-card score from 5-7 cards (hole cards + board)
function bestScore(cards) {
  let best = -1;
  for (const idx of fiveCardCombos(cards.length)) {
    const score = eval5(idx.map(i => cards[i]));
    if (score > best) best = score;
  }
  return best;
}

// Human-readable name for a score, e.g. "Pair of Kings"
function handName(score) {
  const cat = Math.floor(score / Math.pow(15, 5));
  const topRank = Math.floor(score / Math.pow(15, 4)) % 15;
  switch (cat) {
    case 8: return topRank === 14 ? 'Royal Flush' : 'Straight Flush';
    case 7: return 'Four of a Kind';
    case 6: return 'Full House';
    case 5: return 'Flush';
    case 4: return 'Straight';
    case 3: return 'Three of a Kind';
    case 2: return 'Two Pair';
    case 1: return 'Pair of ' + RANK_PLURALS[topRank];
    default: return rankLabel(topRank) + ' High';
  }
}
