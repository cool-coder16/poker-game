// bots.js — bot personalities and decision-making.
//
// HOW TO ADD A NEW BOT STYLE: add an entry to BOT_PROFILES below. It shows up in the
// "Add a bot" dropdown automatically. The three numbers (0 to 1) shape how it plays:
//   looseness  — how willing it is to call with weaker hands
//   aggression — how often it bets/raises instead of just calling
//   bluff      — how often it bets with a weak hand
// For total control, give a profile its own `decide(ctx)` function (see defaultBotDecide).

const BOT_PROFILES = {
  rock: {
    label: 'The Rock', desc: 'Tight and cautious. Only plays strong hands.',
    avatar: '🪨', color: '#7b8794', looseness: 0.15, aggression: 0.3, bluff: 0.02,
    names: ['Rocky', 'Granite', 'Boulder', 'Pebbles'],
  },
  shark: {
    label: 'The Shark', desc: 'Tight and aggressive. Hard to beat.',
    avatar: '🦈', color: '#2a7fd4', looseness: 0.4, aggression: 0.7, bluff: 0.08,
    names: ['Sophie', 'Jaws', 'Marlin', 'Finn'],
  },
  fox: {
    label: 'The Fox', desc: 'Balanced and tricky, with the occasional bluff.',
    avatar: '🦊', color: '#e07a2f', looseness: 0.55, aggression: 0.55, bluff: 0.18,
    names: ['Foxy', 'Reynard', 'Vixen', 'Rusty'],
  },
  maniac: {
    label: 'The Maniac', desc: 'Loose and wild. Bets constantly.',
    avatar: '🔥', color: '#d6402f', looseness: 0.9, aggression: 1.0, bluff: 0.35,
    names: ['Blaze', 'Wildcard', 'Mad Max', 'Inferno'],
  },
  station: {
    label: 'Calling Station', desc: 'Calls almost everything, rarely raises.',
    avatar: '📞', color: '#8e5bd6', looseness: 0.9, aggression: 0.1, bluff: 0.02,
    names: ['Carl', 'Callie', 'Dial', 'Ringo'],
  },
};

// Monte Carlo equity: deal out the unknown cards randomly many times and count how often
// our hand wins against `numOpp` random opponent hands. Returns 0..1 (ties count as a share).
function simEquity(hole, board, numOpp, sims) {
  const used = new Set(hole.concat(board).map(c => c.id));
  const pool = makeDeck().filter(c => !used.has(c.id));
  const boardNeeded = 5 - board.length;
  const needed = boardNeeded + 2 * numOpp;
  let wins = 0;

  for (let s = 0; s < sims; s++) {
    // Partial shuffle: only randomise the first `needed` cards of the pool
    for (let i = 0; i < needed; i++) {
      const j = i + Math.floor(Math.random() * (pool.length - i));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const fullBoard = board.concat(pool.slice(0, boardNeeded));
    const mine = bestScore(hole.concat(fullBoard));
    let beaten = false, ties = 0;
    for (let o = 0; o < numOpp; o++) {
      const start = boardNeeded + 2 * o;
      const theirs = bestScore([pool[start], pool[start + 1]].concat(fullBoard));
      if (theirs > mine) { beaten = true; break; }
      if (theirs === mine) ties++;
    }
    if (!beaten) wins += 1 / (ties + 1);
  }
  return wins / sims;
}

// Pick a raise-to amount: a fraction of the pot, rounded to the small blind.
function botRaiseTo(profile, ctx) {
  const fraction = 0.4 + Math.random() * 0.5 + profile.aggression * 0.4;
  let to = ctx.currentBet + Math.round(fraction * (ctx.pot + ctx.toCall));
  to = Math.round(to / ctx.sb) * ctx.sb;
  to = Math.max(ctx.minRaiseTo, Math.min(ctx.maxRaiseTo, to));
  if (to >= ctx.maxRaiseTo * 0.6) to = ctx.maxRaiseTo;   // committed enough: just shove
  return to;
}

// ctx = { hole, board, pot, toCall, currentBet, minRaiseTo, maxRaiseTo, canRaise, sb, numOpp }
// Returns { type: 'fold' | 'call' | 'raise', amount? }   ('call' with toCall = 0 means check)
function defaultBotDecide(profile, ctx) {
  // With more opponents, an average hand wins less often, so thresholds scale with that.
  const fair = 1 / (ctx.numOpp + 1);
  const strong = fair + (1 - fair) * 0.30;
  const medium = fair + (1 - fair) * 0.15;
  const equity = simEquity(ctx.hole, ctx.board, ctx.numOpp, 200);
  const roll = Math.random();
  const raise = () => ({ type: 'raise', amount: botRaiseTo(profile, ctx) });

  // Nobody has bet yet: check, or open the betting
  if (ctx.toCall === 0) {
    if (ctx.canRaise) {
      if (equity > strong && roll < 0.45 + 0.55 * profile.aggression) return raise();
      if (equity > medium && roll < profile.aggression * 0.5) return raise();
      if (roll < profile.bluff) return raise();
    }
    return { type: 'call' };
  }

  // Facing a bet: compare our winning chances to the price the pot is offering us
  const potOdds = ctx.toCall / (ctx.pot + ctx.toCall);
  const margin = (1 - profile.looseness) * 0.08 - profile.looseness * 0.04;
  if (ctx.canRaise && equity > strong && roll < 0.3 + 0.7 * profile.aggression) return raise();
  if (equity > potOdds + margin) return { type: 'call' };
  if (ctx.canRaise && roll < profile.bluff * 0.4) return raise();   // rare bluff-raise
  return { type: 'fold' };
}

function botDecide(profile, ctx) {
  return profile.decide ? profile.decide(ctx) : defaultBotDecide(profile, ctx);
}
