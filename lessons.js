// lessons.js — the scripted tutorials (play.html?lesson=basic or ?lesson=advanced).
//
// A lesson is a list of HANDS. Each hand has:
//   deals  the exact cards: your 2, Rex's 2, then the 5 board cards (so every hand plays out the same way)
//   bot    a function that decides what Rex does (it gets the same `ctx` the bots in bots.js get)
//   steps  coach messages (a decision step may have `when(ctx)` to show only in some situations), shown at certain moments: intro, hole, flop, turn, river, showdown, end,
//          plus the decision moments actPre/actFlop/actTurn/actRiver (just before YOU act),
//          and youFold / rexFolds (or the older single `fold`) when a hand ends by a fold.
//   total  how many steps the hand has (for the "step 3 of 9" counter)
// A step with `next: true` waits for you to press Next. A step with `odds` also fills the odds panel.
// Uses (at call time) the game's globals from game.js: roster, board, seated, dealerIdx, ...

let lessonIdx = 0;   // which hand of the lesson we are on
const lessonHands = () => LESSONS[lessonName].hands;
const currentLessonHand = () => lessonHands()[lessonIdx];

// Rex's brain: whatever the current hand's script says
const LESSON_BOT = { label: 'Practice opponent', decide: ctx => currentLessonHand().bot(ctx) };
const checkCall = () => ({ type: 'call' });   // "call" with nothing to pay means check

const LESSONS = {
  // ------------------------------------------------------------------ basic: one scripted hand
  basic: { hands: [{
    deals: { you: ['Ks', 'Kd'], rex: ['Ac', '9c'], board: ['Kh', '7c', '2d', '9s', '4h'] },
    bot: checkCall,
    total: 7,
    steps: {
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
      end: { n: 7, next: true, exit: true, nextLabel: 'Back to tutorials', href: 'tutorials.html', title: "You're ready to play!",
        text: `<b>Fold</b> = quit the hand. <b>Check</b> = pass for free. <b>Call</b> = match the bet. <b>Raise</b> = bet more.
               In <b>Practice</b> you can add bots with different styles and rebuy any time. In <b>Singleplayer</b> you chase a high score
               with no rebuys. Hand Rankings is always on the side if you forget what beats what. Want to think like a player? Try the <b>Advanced</b> tutorial.` },
    },
  }] },

  // ------------------------------------------------------------------ advanced: four hands, four ideas
  advanced: { hands: [
    // ---- Lesson 1: outs, rule of 4 and 2, pot odds. You are the button (act last after the flop).
    {
      deals: { you: ['Ah', '9h'], rex: ['Kc', 'Kd'], board: ['Kh', '7h', '2c', '4c', '3h'] },
      // Rex bets the minimum (20) on the flop and turn, then checks the river
      bot: ctx => (ctx.toCall === 0 && ctx.canRaise && (ctx.board.length === 3 || ctx.board.length === 4))
        ? { type: 'raise', amount: 20 } : checkCall(),
      total: 9,
      steps: {
        intro: { n: 1, next: true, title: 'Advanced 1 of 4: Outs and pot odds 🎯',
          text: `Good poker is a math game played against people. This lesson teaches two numbers:
                 <b>outs</b> (how many cards would help you) and <b>pot odds</b> (the price the pot offers you).
                 Rex only follows a script, but treat every decision like it's real.` },
        hole: { n: 2, highlight: 'call', title: 'Suited cards',
          text: `You hold <b>A♥ 9♥</b>: two hearts. Nothing yet, but suited cards can grow into a <b>flush</b> (5 cards of one suit).
                 You're on the <b>button</b> (the dealer), so you act last after the flop. Acting last is a big advantage: you see what your opponent does first.
                 For now, just <b>Call</b> to match the big blind.` },
        flop: { n: 3, next: true, title: 'The flop: a flush draw',
          text: `Flop: <b>K♥ 7♥ 2♣</b>. You have 4 hearts (2 in your hand, 2 on the board): a <b>flush draw</b>. Any 5th heart makes a flush, which beats three Kings.
                 Those cards are your <b>outs</b>. A suit has 13 cards and you can see 4, so you have <b>9 outs</b> among the <b>47</b> cards you can't see.
                 <b>Rule of 4</b> (two cards to come): outs × 4 ≈ your chance to hit by the river → 9 × 4 = <b>36%</b> (the exact answer is 35%).` },
        actFlop: { n: 4, highlight: 'odds', odds: { mode: 'draw', outs: 9 }, title: 'Is the price right?',
          text: `Rex bets. <b>Pot odds</b> = what you must pay ÷ (the pot after you pay). That's how often you need to win just to break even.
                 If your chance of hitting is <b>bigger</b> than the price, calling makes money over time. The panel does the math. Press <b>Call</b>.` },
        turn: { n: 5, next: true, title: 'The turn: a miss',
          text: `Turn: <b>4♣</b>. No heart, so you haven't hit yet. The draw is still alive, but now there is only <b>one card</b> to come.
                 <b>Rule of 2</b> (one card to come): outs × 2 ≈ 18% (exact: 9 ÷ 46 = 19.6%).` },
        actTurn: { n: 6, highlight: 'odds', odds: { mode: 'draw', outs: 9 }, title: 'The price changed',
          text: `Rex bets again, and the pot is bigger now. Check the panel: the price is still a bit lower than your chance, so calling is still (barely) profitable.
                 Notice how <b>bet size</b> matters: a much bigger bet would give you a bad price, and then folding is right.` },
        river: { n: 7, next: true, title: 'The river: you hit!',
          text: `River: <b>3♥</b>, a heart! You made an Ace-high <b>flush</b> (A♥ K♥ 9♥ 7♥ 3♥). You hit a shot you only had about 1 time in 3.
                 Rex acts first. If he checks, <b>bet</b> (about half the pot is a good size) to get paid.` },
        showdown: { n: 8, next: true, title: 'Showdown',
          text: `Your flush beats Rex's three Kings. You won this time, but you'd have missed about 2 times out of 3.
                 Calling was still right: when the price is lower than your chance, you win money <b>on average</b>. That's a <b>+EV</b> (positive expected value) decision.
                 Results vary; decisions are what you control.` },
        youFold: { n: 8, next: true, title: 'You folded',
          text: `Folding is fine when the price is wrong, but here the odds said <b>call</b>. Fold good draws too often and you lose money over time.
                 Press Next. You'll face the same kind of spot in real games.` },
        end: { n: 9, next: true, nextLabel: 'Lesson 2', title: 'Lesson 1 done',
          text: `Remember the chain: <b>count your outs → turn them into a chance (rule of 4 and 2) → compare with the price (pot odds)</b>.
                 Next up: how your winning chances swing as the cards come out.` },
      },
    },

    // ---- Lesson 2: equity and variance. Rex's cards are face-up so you can see the exact numbers.
    {
      deals: { you: ['8s', '8d'], rex: ['Ac', 'Kc'], board: ['Jd', '4c', '9h', 'As', '2d'] },
      bot: checkCall,
      reveal: true,
      total: 7,
      steps: {
        intro: { n: 1, next: true, title: 'Advanced 2 of 4: Equity 📊',
          text: `<b>Equity</b> is your share of the pot: your chance to win if all the remaining cards were dealt out. It changes with <b>every card</b>.
                 For this lesson Rex's cards are face-up (you never get that in real life) so you can watch the exact numbers move.` },
        hole: { n: 2, next: true, highlight: 'odds', odds: { mode: 'vs' }, title: 'A coin flip',
          text: `You hold <b>8♠ 8♦</b> (a pocket pair). Rex has <b>A♣ K♣</b> (two big cards). A pair against two bigger cards is the classic <b>coin flip</b>:
                 you're only a small favorite. No starting hand is safe. Rex limps in, so when it's your turn just <b>Check</b>.` },
        flop: { n: 3, next: true, highlight: 'odds', odds: { mode: 'vs' }, title: 'The flop: you jump ahead',
          text: `Flop: <b>J♦ 4♣ 9♥</b>. Nobody paired a big card, so your pair of 8s is ahead. Watch your equity jump.
                 Rex still has "outs": any Ace or King (6 cards) would give him a better pair.` },
        turn: { n: 4, next: true, highlight: 'odds', odds: { mode: 'vs' }, title: 'The turn: an Ace!',
          text: `Turn: <b>A♠</b>. Rex paired his Ace and is now ahead. Your equity collapses: only the two other 8s (making three of a kind) can save you.` },
        river: { n: 5, next: true, highlight: 'odds', odds: { mode: 'vs' }, title: 'The river: a blank',
          text: `River: <b>2♦</b>. Nothing changes, so your equity is now 0%: Rex's pair of Aces beats your pair of 8s.` },
        showdown: { n: 6, next: true, title: 'You were a favorite, and still lost',
          text: `You were roughly a <b>2-to-1 favorite</b> (about 70%) on the flop and still lost. That's <b>variance</b>: even great decisions lose a lot.
                 Judge your choices by the odds you had, not by the result. Poker players say: <i>don't be results-oriented</i>.` },
        youFold: { n: 6, next: true, title: 'You folded',
          text: `You can fold any time. Look at the equity numbers you saw: was folding right at that moment? Folding a hand that's a big favorite gives up money.` },
        end: { n: 7, next: true, nextLabel: 'Lesson 3', title: 'Lesson 2 done',
          text: `Equity swings every street, favorites lose sometimes, and one result proves nothing. Next: a bet can win two ways, and that's the key to bluffing.` },
      },
    },

    // ---- Lesson 3: bluffing and fold equity. You are the button again; Rex checks, then folds to a river bet.
    {
      deals: { you: ['9s', '8s'], rex: ['Ad', 'Qc'], board: ['Ks', '5s', '2d', '7c', '3d'] },
      // Rex checks and calls everything until the river, where he folds to any bet
      bot: ctx => (ctx.toCall > 0 && ctx.board.length === 5) ? { type: 'fold' } : checkCall(),
      total: 8,
      steps: {
        intro: { n: 1, next: true, title: 'Advanced 3 of 4: Bluffing 🃏',
          text: `A bet can win <b>two ways</b>: you have the best hand, <b>or</b> your opponent folds. The chance they fold is your <b>fold equity</b>.
                 Rex is the big blind, so he acts first after the flop, and what he does (or doesn't do) tells you something.` },
        hole: { n: 2, highlight: 'call', title: 'Suited connectors',
          text: `You hold <b>9♠ 8♠</b>: suited and next to each other, a fun hand that can make flushes and straights. Just <b>Call</b> to see the flop.` },
        flop: { n: 3, next: true, title: 'A semi-bluff chance',
          text: `Flop: <b>K♠ 5♠ 2♦</b>. You have 4 spades: a flush draw (9 outs). Rex acts first and will probably check.
                 You can <b>check</b> and take a free card, or <b>bet</b>. Betting with a draw is called a <b>semi-bluff</b>: if Rex folds you win now, and if he calls you can still hit. Either choice is fine.` },
        turn: { n: 4, next: true, title: 'More outs',
          text: `Turn: <b>7♣</b>, no spade. But now you also have a <b>gutshot</b>: any 6 makes a straight (5-6-7-8-9).
                 That's 9 spades + three non-spade 6s = <b>12 outs</b>, about 26% to hit on the river.` },
        river: { n: 5, next: true, title: 'The river: you missed',
          text: `River: <b>3♦</b>. You missed everything and have only King-high. Rex has checked the whole way, which looks weak, and he does have just Ace-high.
                 If you check, you lose at showdown. Your only way to win this pot is to make Rex fold.` },
        actRiver: { n: 6, highlight: 'odds', odds: { mode: 'bluff' }, title: 'The bluff math',
          text: `A bluff only has to work <b>some</b> of the time. If you bet B into a pot of P, you break even when Rex folds at least <b>B ÷ (P + B)</b> of the time.
                 Smaller bets need fewer folds. The panel shows the numbers. Try betting about half the pot!` },
        rexFolds: { n: 7, next: true, title: 'The bluff worked!',
          text: `Rex folded and you won with nothing. You didn't need to be right, you needed Rex to fold more often than the percentage in the panel.
                 Careful: bluffs work against players who fold (Rex is scripted to), but a Calling Station (see the bot list) almost never folds.` },
        showdown: { n: 7, next: true, title: 'Showdown',
          text: `Rex's Ace-high beats your King-high. Rex would have folded to a bet, so checking gave up a pot you could have won.` },
        end: { n: 8, next: true, nextLabel: 'Lesson 4', title: 'Lesson 3 done',
          text: `Bluff math: <b>fold chance needed = bet ÷ (pot + bet)</b>. Bluff the right opponents, with a sensible size, at the right time.` },
      },
    },

    // ---- Lesson 4: reading the bets. Rex checks twice, then makes a pot-sized bet on the river.
    {
      deals: { you: ['Qd', '10c'], rex: ['8s', '8c'], board: ['Qc', '8d', '3s', '5h', '2c'] },
      // Rex checks the flop and turn; on the river (after you check) he bets the size of the pot; otherwise he calls
      bot: ctx => (ctx.board.length === 5 && ctx.toCall === 0 && ctx.canRaise)
        ? { type: 'raise', amount: Math.max(ctx.minRaiseTo, ctx.pot) } : checkCall(),
      total: 8,
      steps: {
        intro: { n: 1, next: true, title: 'Advanced 4 of 4: What does the bet mean? 🔍',
          text: `Math tells you the price. But poker is also a story: ask <b>"what hands would my opponent bet like this?"</b>
                 In this lesson Rex is a <b>tight</b> player: he rarely bluffs, and he only bets big with a strong hand. Keep that in mind.` },
        hole: { n: 2, highlight: 'call', title: 'A good hand',
          text: `You hold <b>Q♦ 10♣</b>: a big card plus a decent kicker. Rex acts first and just limps in. When it's your turn, <b>Check</b> to see the flop.` },
        flop: { n: 3, next: true, title: 'Top pair',
          text: `Flop: <b>Q♣ 8♦ 3♠</b>. You paired the Queen: <b>top pair</b>. A nice hand! Checking is fine here, or a small bet. Checking lets you control how big the pot gets.` },
        turn: { n: 4, next: true, title: 'Nothing changes',
          text: `Turn: <b>5♥</b>. Still top pair, still a good hand. Rex has done nothing but check and call.` },
        river: { n: 5, next: true, title: 'A quiet board',
          text: `River: <b>2♣</b>. The board is dry and your top pair looks strong. <b>Check</b> and see what Rex does.` },
        actRiver: { n: 6, when: c => c.toCall > 0, highlight: 'odds', odds: { mode: 'random', note: "That number assumes Rex's hand is random. Is it?" }, title: 'Rex bets big',
          text: `Rex checked twice and now bets about the size of the pot. Look at the panel: against a <i>random</i> hand your Queens win most of the time and the price needs only about a third, so the math says <b>call</b>.
                 But is Rex's hand random? A tight player who checks twice and then bets this big usually has something strong. Think about his <b>range</b> before you pay.` },
        showdown: { n: 7, next: true, title: 'Rex had it',
          text: `Rex had <b>8♠ 8♣</b>, a <b>set of 8s</b>, and beat your Queens. You called because the math against a <i>random</i> hand looked great, but Rex wasn't random.
                 Pot odds are only half the story: also weigh <b>what the bet means</b>.` },
        youFold: { n: 7, next: true, title: 'Good fold!',
          text: `Rex was holding <b>8♠ 8♣</b>, a set of 8s. Against a random hand your Queens looked great, but a tight player's big bet after two checks meant a monster.
                 You combined the math with a read. That's thinking like a player.` },
        end: { n: 8, next: true, exit: true, nextLabel: 'Finish', href: 'tutorials.html', title: "You've finished the advanced tutorial 🎓",
          text: `Before every decision, ask: <b>1)</b> How strong is my hand (equity)? <b>2)</b> What's the price (pot odds)? <b>3)</b> What does their betting say they hold? <b>4)</b> Do I have position (do I act last)?
                 Try these ideas in <b>Practice</b>, then chase a high score in <b>Singleplayer</b>.` },
      },
    },
  ] },
};

// ---------- Cards and the rigged deck ----------
// "Ks" -> a card object like the ones makeDeck() builds ("10c" works too)
function cardFromCode(code) {
  const r = code.slice(0, -1);
  const rank = { J: 11, Q: 12, K: 13, A: 14 }[r] || Number(r);
  const s = SUIT_LETTERS.indexOf(code.slice(-1));
  return { r: rank, s, id: s * 13 + (rank - 2) };
}

// The game deals with deck.pop() (takes from the END), so the scripted cards go last, reversed.
// Cards are dealt starting with the small blind (the dealer, when heads-up), so the order depends on
// whose turn it is to be dealer. playHand() calls this just before it moves the dealer button.
function stackedDeck() {
  const d = currentLessonHand().deals;
  const nextDealer = (dealerIdx + 1) % seated.length;
  const youFirst = seated[nextDealer].isHuman;
  const holes = youFirst ? [d.you[0], d.rex[0], d.you[1], d.rex[1]] : [d.rex[0], d.you[0], d.rex[1], d.you[1]];
  const rigged = holes.concat(d.board).map(cardFromCode);
  const used = new Set(rigged.map(c => c.id));
  const rest = shuffle(makeDeck().filter(c => !used.has(c.id)));
  return rest.concat(rigged.reverse());
}

// ---------- Coach messages ----------
// Shows the coach card for `key`. Resolves when it's time to continue (immediately, or after Next).
function tutorialStep(key, ctx = null) {
  if (!tutorial) return Promise.resolve();
  const hand = currentLessonHand();
  const step = hand.steps[key];
  if (!step) return Promise.resolve();
  if (step.when && !(ctx && step.when(ctx))) return Promise.resolve();   // e.g. only show once you face a bet

  if (key === 'hole' && hand.reveal) roster[1].showCards = true;   // lessons that show Rex's cards (see update())
  $('coach').classList.remove('hidden');
  $('coachTitle').textContent = step.title;
  $('coachText').innerHTML = step.text;     // our own text above, never user input
  const many = lessonHands().length > 1;
  $('coachStep').textContent = (many ? `Lesson ${lessonIdx + 1} of ${lessonHands().length} · ` : '') + `Step ${step.n} of ${hand.total}`;
  document.body.dataset.tut = step.highlight || '';
  renderOdds(step.odds, ctx);
  update();

  const nextBtn = $('coachNext');
  if (!step.next) { nextBtn.classList.add('hidden'); return Promise.resolve(); }   // you act instead
  nextBtn.classList.remove('hidden');
  nextBtn.textContent = step.nextLabel || 'Next';
  return new Promise(resolve => {
    nextBtn.onclick = () => {
      nextBtn.classList.add('hidden');   // the step is done; the text stays until the next step replaces it
      if (step.exit) location.href = step.href || 'play.html';
      resolve();
    };
  });
}

// game.js calls this right before you act: show the "actFlop"-style step for this street, if the hand has one
function tutorialDecision(ctx) {
  const street = { 0: 'actPre', 3: 'actFlop', 4: 'actTurn', 5: 'actRiver' }[ctx.board.length];
  return tutorialStep(street, ctx);
}

// Which message to show when a hand ends because someone folded
function foldStepKey(winner) {
  if (!tutorial) return null;   // no lesson running (runs and practice call this too)
  const steps = currentLessonHand().steps;
  const key = winner.isHuman ? 'rexFolds' : 'youFold';
  return steps[key] ? key : 'fold';
}

// ---------- The odds panel ----------
// Equity of hand `a` against a known hand `b`, by dealing out the rest of the board many times
function equityVs(a, b, boardCards, sims) {
  const used = new Set(a.concat(b, boardCards).map(c => c.id));
  const pool = makeDeck().filter(c => !used.has(c.id));
  const need = 5 - boardCards.length;
  if (need === 0) sims = 1;   // nothing left to deal: the answer is exact
  let wins = 0;
  for (let s = 0; s < sims; s++) {
    for (let i = 0; i < need; i++) {   // partial shuffle, same trick as simEquity in bots.js
      const j = i + Math.floor(Math.random() * (pool.length - i));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const full = boardCards.concat(pool.slice(0, need));
    const mine = bestScore(a.concat(full)), theirs = bestScore(b.concat(full));
    wins += mine > theirs ? 1 : mine === theirs ? 0.5 : 0;
  }
  return wins / sims;
}

const pct = x => Math.round(x * 100) + '%';

// Chance of hitting at least one of `outs` cards with `toCome` cards still to deal (exact)
function hitChance(outs, unseen, toCome) {
  let miss = 1;
  for (let k = 0; k < toCome; k++) miss *= (unseen - outs - k) / (unseen - k);
  return 1 - miss;
}

// Fills the odds panel for a step's `odds` spec. `ctx` (the live decision) adds the price lines.
// Only our own text and numbers go in here, so innerHTML is safe.
function renderOdds(spec, ctx) {
  const box = $('odds');
  if (!spec) { box.classList.add('hidden'); return; }
  const me = roster[0], rex = roster[1];
  const lines = [];
  let chance = null;   // the chance we compare against the price (when facing a bet)

  if (spec.mode === 'draw') {
    const unseen = 52 - 2 - board.length, toCome = 5 - board.length;
    const next = hitChance(spec.outs, unseen, 1);
    lines.push(`<b>${spec.outs} outs</b> among ${unseen} unseen cards`);
    lines.push(`Hit on the next card: ${spec.outs} ÷ ${unseen} = <b>${pct(next)}</b>`);
    chance = next;
    if (toCome === 2) {
      const byRiver = hitChance(spec.outs, unseen, 2);
      lines.push(`Hit by the river: <b>${pct(byRiver)}</b> (rule of 4: ${spec.outs} × 4 = ${spec.outs * 4}%)`);
      chance = byRiver;
    }
  } else if (spec.mode === 'vs') {
    chance = equityVs(me.hole, rex.hole, board, 2000);
    lines.push(`Your equity against Rex's actual cards: <b>${pct(chance)}</b>`);
  } else if (spec.mode === 'random') {
    chance = simEquity(me.hole, board, 1, 2500);
    lines.push(`Your equity against a <i>random</i> hand: <b>${pct(chance)}</b>`);
  } else if (spec.mode === 'bluff' && ctx) {
    const P = ctx.pot;
    const half = Math.max(ctx.minRaiseTo, Math.round(P / 2 / 10) * 10), full = Math.min(P, ctx.maxRaiseTo);
    lines.push(`Pot: <b>${fmt(P)}</b>`);
    lines.push(`Bet ${fmt(half)} (about half the pot): Rex must fold <b>${pct(half / (P + half))}</b> of the time (${fmt(half)} ÷ ${fmt(P + half)})`);
    lines.push(`Bet ${fmt(full)} (the pot): Rex must fold <b>${pct(full / (P + full))}</b> of the time (${fmt(full)} ÷ ${fmt(P + full)})`);
  }

  // Price of calling a bet (pot odds), compared with the chance above
  if (ctx && ctx.toCall > 0 && chance !== null) {
    const need = ctx.toCall / (ctx.pot + ctx.toCall);
    lines.push(`Price: pay <b>${fmt(ctx.toCall)}</b> to win a pot of <b>${fmt(ctx.pot + ctx.toCall)}</b> → pot odds ${fmt(ctx.toCall)} ÷ ${fmt(ctx.pot + ctx.toCall)} = <b>${pct(need)}</b> needed`);
    lines.push(chance > need
      ? `✅ ${pct(chance)} is more than ${pct(need)} → calling is profitable over time.`
      : `❌ ${pct(chance)} is less than ${pct(need)} → this call loses money over time.`);
  } else if (ctx && ctx.toCall === 0 && spec.mode !== 'bluff') {
    lines.push('Nobody has bet: checking is free.');
  }
  if (spec.note) lines.push(`<i>${spec.note}</i>`);

  box.innerHTML = lines.map(l => `<div>${l}</div>`).join('');
  box.classList.remove('hidden');
}
