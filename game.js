// game.js — the single-player game loop (runs, practice and tutorials). Drawing the table lives in table-ui.js.
// Uses poker.js (cards, hand scoring), bots.js (bot AI) and table-ui.js (table drawing and your controls).

// ---------- Settings & state ----------
// Settings are chosen on settings.html and read here from localStorage (see common.js).
// ($ and fmt also come from common.js, which loads first.)
const cfg = loadSettings();
const MAX_SEATS = 8;

// play.html has three modes, chosen by the link you came from:
//   play.html                  -> a high-score RUN (no rebuys, ends when anyone goes bankrupt)
//   play.html?mode=practice    -> PRACTICE (rebuys, any bots, nothing counts)
//   play.html?lesson=basic     -> a scripted TUTORIAL (also ?lesson=advanced; ?tutorial is the old link)
const params = new URLSearchParams(location.search);
const lessonName = params.get('lesson') in LESSONS ? params.get('lesson') : (params.has('tutorial') ? 'basic' : null);   // LESSONS: lessons.js
const tutorial = lessonName !== null;
const practice = !tutorial && params.get('mode') === 'practice';
const runMode = !tutorial && !practice;
// Fixed rules so every run (and every lesson) is comparable
if (runMode) Object.assign(cfg, { sb: runSmallBlind(1), startChips: RUN_START_CHIPS, botRebuy: false });
if (tutorial) Object.assign(cfg, { sb: 10, startChips: 1000 });

let roster = [];       // everyone at the table (including players waiting to join next hand)
let seated = [];       // the players dealt into the CURRENT hand
let deck = [];
let dealerIdx = -1;    // index into `seated`
let handNo = 0;
let currentBet = 0;    // the highest bet this betting round
let minRaise = 0;      // smallest legal raise increment
let humanWinAmount = 0;   // what you won this hand (0 if nothing); used for profile stats
let humanStartChips = 0;  // your chips before the blinds went in; used to work out bb won this hand
let runBb = 0;            // net big blinds you have won this run (for the game-over summary)
let runOver = false;      // true once someone went bankrupt in a run
let nextId = 1;

const sleep = ms => new Promise(r => setTimeout(r, ms * cfg.speed));   // scaled by the speed setting
const winVerb = p => (p.isHuman ? "win" : "wins");   // "You win" vs "Rex wins"
const bigBlind = () => cfg.sb * 2;
const live = () => seated.filter(p => !p.folded);                    // still in the hand
const canAct = () => seated.filter(p => !p.folded && !p.allIn);      // still able to bet

// ---------- Players ----------
function makePlayer({ name, avatar, color, isHuman = false, profile = null, label = '' }) {
  return {
    id: nextId++, name, avatar, color, isHuman, profile, label,
    chips: cfg.startChips, hole: [], bet: 0, totalBet: 0,
    folded: false, allIn: false, acted: false, status: '', statusClass: '',
    showCards: false, score: 0, pending: false, leaving: false,
  };
}

function addBot(profileKey) {
  if (roster.length >= MAX_SEATS) return;
  const profile = BOT_PROFILES[profileKey];
  const taken = new Set(roster.map(p => p.name));
  const name = profile.names.find(n => !taken.has(n)) || profile.label + ' ' + (nextId);
  const bot = makePlayer({ name, avatar: profile.avatar, color: profile.color, profile, label: profile.label });
  bot.pending = handActive;   // joins at the start of the next hand if one is running
  roster.push(bot);
  log(`${name} (${profile.label}) sat down.`);
  if (!handActive) buildTable(roster);
  renderRoster();
}

function removeBot(id) {
  const p = roster.find(x => x.id === id);
  if (!p || p.isHuman) return;
  if (handActive && !p.pending) {
    p.leaving = true;   // can't leave mid-hand; leaves once it ends
    log(`${p.name} will leave after this hand.`);
  } else {
    roster = roster.filter(x => x !== p);
    log(`${p.name} left the table.`);
    if (!handActive) buildTable(roster);
  }
  renderRoster();
}

function renderRoster() {
  const ul = $('roster');
  ul.innerHTML = '';
  roster.forEach(p => {
    const li = document.createElement('li');
    const sub = p.leaving ? 'leaving after this hand' : p.pending ? 'joins next hand' : p.label || 'You';
    li.innerHTML = `<div class="avatar"></div><div class="rname"></div><span class="chips"></span>`;
    li.querySelector('.avatar').textContent = p.avatar;
    li.querySelector('.avatar').style.setProperty('--c', p.color);
    // Names can come from user accounts, so add them as plain text (never as HTML)
    const rname = li.querySelector('.rname');
    rname.append(p.name);
    const small = document.createElement('small');
    small.textContent = sub;
    rname.appendChild(small);
    li.querySelector('.chips').textContent = fmt(p.chips);
    if (!p.isHuman) {
      const x = document.createElement('button');
      x.className = 'x'; x.textContent = '✕'; x.title = 'Remove ' + p.name;
      x.onclick = () => removeBot(p.id);
      li.appendChild(x);
    }
    ul.appendChild(li);
  });
  $('btnAddBot').disabled = roster.length >= MAX_SEATS;
}

// ---------- Hand flow ----------
async function startHand() {
  if (handActive) return;
  winnerIds = new Set();
  applyPendingProfile();   // game-account.js: apply a sign-in/out that happened mid-hand
  if (tutorial) roster.forEach(p => { p.chips = cfg.startChips; });   // every lesson hand starts from equal stacks

  // Apply seat changes that were waiting for the hand boundary
  roster.filter(p => p.leaving).forEach(p => log(`${p.name} left the table.`));
  roster = roster.filter(p => !p.leaving);
  roster.forEach(p => { p.pending = false; });
  const me = roster[0];
  if (me.chips <= 0) {   // only Practice gets here: a run ends the moment you go bankrupt
    me.chips = cfg.startChips;
    log(`You rebought for ${fmt(me.chips)}.`);
  }
  roster.filter(p => !p.isHuman && p.chips <= 0).forEach(p => {
    if (cfg.botRebuy) { p.chips = cfg.startChips; log(`${p.name} rebought.`); }
    else { log(`${p.name} is out of chips.`); }
  });
  roster = roster.filter(p => p.isHuman || p.chips > 0);

  seated = roster.slice();
  renderRoster();
  if (seated.length < 2) {
    buildTable(roster);
    setMessage('Add a bot to start playing.');
    return;
  }

  handActive = true;
  $('btnDeal').disabled = true;
  try { await playHand(); }
  catch (err) { console.error(err); log('Something went wrong: ' + err.message); }
  endHand();
}

// Runs only: raise the blinds when a new level starts, and tell the player what they are now
function setRunBlinds() {
  const sb = runSmallBlind(handNo);
  if (sb !== cfg.sb) { cfg.sb = sb; log(`Blinds go up to ${fmt(sb)}/${fmt(sb * 2)}!`, 'hand'); }
  const toNext = RUN_HANDS_PER_LEVEL - ((handNo - 1) % RUN_HANDS_PER_LEVEL);
  const atTop = sb === RUN_BLINDS[RUN_BLINDS.length - 1];
  $('modeNote').textContent = MODE_NOTES.run + ` Blinds now ${fmt(sb)}/${fmt(sb * 2)}`
    + (atTop ? ' (the highest level).' : `, going up in ${toNext} hand${toNext === 1 ? '' : 's'}.`);
}

async function playHand() {
  handNo++;
  if (runMode) setRunBlinds();
  humanWinAmount = 0;
  humanStartChips = roster[0].chips;
  const n = seated.length;
  seated.forEach(p => Object.assign(p, {
    hole: [], bet: 0, totalBet: 0, folded: false, allIn: false, acted: false,
    status: '', statusClass: '', showCards: false,
  }));
  board = [];
  deck = tutorial ? stackedDeck() : shuffle(makeDeck());   // tutorial uses a fixed, known deal
  dealerIdx = (dealerIdx + 1) % n;

  // Heads-up (2 players): the dealer is the small blind. Otherwise blinds are the next two seats.
  const sbIdx = n === 2 ? dealerIdx : (dealerIdx + 1) % n;
  const bbIdx = (sbIdx + 1) % n;
  markers = { dealer: seated[dealerIdx].id, sb: seated[sbIdx].id, bb: seated[bbIdx].id };
  const firstPre = (bbIdx + 1) % n;                       // first to act before the flop
  const firstPost = n === 2 ? bbIdx : sbIdx;               // first to act after the flop

  buildTable(seated);
  log(`— Hand #${handNo} —`, 'hand');
  setMessage(`Hand #${handNo}`);
  await tutorialStep('intro');
  currentBet = 0; minRaise = bigBlind();
  postBlind(seated[sbIdx], cfg.sb, 'small blind');
  postBlind(seated[bbIdx], bigBlind(), 'big blind');
  currentBet = bigBlind();
  update();

  // Deal two hole cards to everyone, one at a time
  for (let round = 0; round < 2; round++) {
    for (let k = 0; k < n; k++) {
      seated[(sbIdx + k) % n].hole.push(deck.pop());
      update();
      await sleep(80);
    }
  }
  await sleep(300);
  await tutorialStep('hole');

  const stages = ['Pre-flop', 'Flop', 'Turn', 'River'];
  for (let s = 0; s < 4; s++) {
    if (s > 0) {
      collectBets();
      const count = s === 1 ? 3 : 1;
      for (let k = 0; k < count; k++) { board.push(deck.pop()); update(); await sleep(150); }
      setMessage(stages[s]);
      await sleep(250);
      await tutorialStep(stages[s].toLowerCase());   // 'flop', 'turn' or 'river'
    } else {
      setMessage('Pre-flop');
    }
    if (live().length <= 1) break;
    const needsAction = canAct().length >= 2 || canAct().some(p => p.bet < currentBet);
    if (needsAction) await bettingRound(s === 0 ? firstPre : firstPost);
    if (live().length <= 1) break;
  }
  collectBets();

  if (live().length === 1) await awardUncontested();
  else await showdown();
}

function postBlind(p, amount, label) {
  const pay = Math.min(amount, p.chips);
  commit(p, pay);
  if (p.chips === 0) { p.allIn = true; p.status = 'All-in'; p.statusClass = 's-allin'; }
  log(`${p.name} posts the ${label} (${fmt(pay)}).`);
}

function commit(p, amount) {
  p.chips -= amount;
  p.bet += amount;
  p.totalBet += amount;
}

// New betting round: forget this round's bets (they stay counted in the pot via totalBet)
function collectBets() {
  seated.forEach(p => { p.bet = 0; p.acted = false; if (!p.folded && !p.allIn) { p.status = ''; p.statusClass = ''; } });
  currentBet = 0;
  minRaise = bigBlind();
  update();
}

// Go around the table until everyone still in has acted and matched the highest bet.
async function bettingRound(startIdx) {
  const n = seated.length;
  let i = startIdx % n;
  while (true) {
    if (live().length <= 1) return;
    const actable = canAct();
    if (actable.length === 0) return;
    if (actable.every(p => p.acted && p.bet === currentBet)) return;
    if (actable.length === 1 && actable[0].bet >= currentBet) return;   // nobody left to bet against

    const p = seated[i];
    if (!p.folded && !p.allIn && !(p.acted && p.bet === currentBet)) await takeTurn(p);
    i = (i + 1) % n;
  }
}

async function takeTurn(p) {
  activeId = p.id;
  update();

  const toCall = Math.min(currentBet - p.bet, p.chips);
  const maxRaiseTo = p.bet + p.chips;
  const othersCanRespond = canAct().some(q => q !== p);
  const ctx = {
    hole: p.hole, board: board.slice(),
    pot: seated.reduce((s, q) => s + q.totalBet, 0),
    toCall, currentBet, maxRaiseTo,
    minRaiseTo: Math.min(currentBet + minRaise, maxRaiseTo),
    canRaise: p.chips > toCall && othersCanRespond,
    chips: p.chips, sb: cfg.sb, numOpp: live().length - 1,
  };

  let action;
  if (p.isHuman) {
    if (tutorial) await tutorialDecision(ctx);   // lessons.js: coach message + odds before you act
    action = await getHumanAction(ctx);
  } else {
    await sleep(700 + Math.random() * 700);   // "thinking" time
    action = botDecide(p.profile, ctx);
  }
  if (action.type === 'raise' && !ctx.canRaise) action = { type: 'call' };   // safety net

  applyAction(p, action, ctx);
  activeId = null;
  update();
}

function applyAction(p, action, ctx) {
  if (action.type === 'fold') {
    p.folded = true;
    p.status = 'Fold'; p.statusClass = 's-fold';
    log(`${p.name} folds.`);
  } else if (action.type === 'call') {
    const pay = ctx.toCall;
    commit(p, pay);
    p.status = pay === 0 ? 'Check' : 'Call'; p.statusClass = '';
    log(pay === 0 ? `${p.name} checks.` : `${p.name} calls ${fmt(pay)}.`);
  } else {
    const raiseTo = Math.max(ctx.minRaiseTo, Math.min(ctx.maxRaiseTo, Math.round(action.amount)));
    const wasBet = currentBet === 0;
    commit(p, raiseTo - p.bet);
    const size = raiseTo - currentBet;
    if (size >= minRaise) minRaise = size;      // a full raise raises the minimum for the next one
    currentBet = raiseTo;
    seated.forEach(q => { if (q !== p) q.acted = false; });   // everyone must respond to a raise
    p.status = wasBet ? 'Bet' : 'Raise'; p.statusClass = 's-raise';
    log(`${p.name} ${wasBet ? 'bets' : 'raises to'} ${fmt(raiseTo)}.`);
  }
  p.acted = true;
  if (p.chips === 0 && !p.folded) {
    p.allIn = true; p.status = 'All-in'; p.statusClass = 's-allin';
    log(`${p.name} is all-in!`);
  }
}

// ---------- Winning ----------
// Split the money into the main pot and side pots (needed when someone is all-in for less).
function buildPots() {
  const levels = [...new Set(seated.filter(p => p.totalBet > 0).map(p => p.totalBet))].sort((a, b) => a - b);
  const pots = [];
  let prev = 0;
  for (const level of levels) {
    let amount = 0;
    seated.forEach(p => { amount += Math.max(0, Math.min(p.totalBet, level) - prev); });
    pots.push({ amount, eligible: seated.filter(p => !p.folded && p.totalBet >= level) });
    prev = level;
  }
  return pots;
}

async function awardUncontested() {
  const winner = live()[0];
  const amount = seated.reduce((s, p) => s + p.totalBet, 0);
  winner.chips += amount;
  winner.status = `Wins ${fmt(amount)}`; winner.statusClass = 's-win';
  winnerIds.add(winner.id);
  if (winner.isHuman) humanWinAmount = amount;
  seated.forEach(p => { p.totalBet = 0; p.bet = 0; });
  setMessage(`${winner.name} ${winVerb(winner)} ${fmt(amount)}`);
  log(`${winner.name} ${winVerb(winner)} ${fmt(amount)} (everyone else folded).`, 'win');
  update();
  await tutorialStep(foldStepKey(winner));   // lessons.js: who folded decides the message
}

async function showdown() {
  // Run out any remaining board cards (happens when players are all-in)
  while (board.length < 5) { board.push(deck.pop()); update(); await sleep(400); }

  const contenders = live();
  contenders.forEach(p => { p.showCards = true; p.score = bestScore(p.hole.concat(board)); });
  setMessage('Showdown');
  update();
  await sleep(900);

  const won = new Map();
  for (const pot of buildPots()) {
    const pool = pot.eligible.length ? pot.eligible : contenders;
    const top = Math.max(...pool.map(p => p.score));
    // Odd leftover chips go to the winner closest to the left of the dealer
    const winners = pool.filter(p => p.score === top)
      .sort((a, b) => ((seated.indexOf(a) - dealerIdx - 1 + seated.length) % seated.length) - ((seated.indexOf(b) - dealerIdx - 1 + seated.length) % seated.length));   // the dealer is last in line
    const share = Math.floor(pot.amount / winners.length);
    let leftover = pot.amount - share * winners.length;
    winners.forEach(w => {
      const amt = share + (leftover-- > 0 ? 1 : 0);
      w.chips += amt;
      won.set(w, (won.get(w) || 0) + amt);
    });
  }

  const summary = [];
  won.forEach((amt, p) => {
    winnerIds.add(p.id);
    if (p.isHuman) humanWinAmount = amt;
    p.status = `Wins ${fmt(amt)}`; p.statusClass = 's-win';
    summary.push(`${p.name} ${winVerb(p)} ${fmt(amt)} with ${handName(p.score)}`);
    log(`${p.name} ${winVerb(p)} ${fmt(amt)} with ${handName(p.score)}.`, 'win');
  });
  seated.forEach(p => { p.totalBet = 0; p.bet = 0; });
  setMessage(summary.join(' · '));
  update();
  await tutorialStep('showdown');
}

async function endHand() {
  handActive = false;
  activeId = null;
  humanResolve = null;
  setControlsEnabled(false);
  $('btnCall').textContent = 'Check';
  renderRoster();
  update();

  if (runMode) {
    runBb += (roster[0].chips - humanStartChips) / bigBlind();
    recordHandResult();   // game-account.js: update + save season stats when signed in
    const broke = roster.find(p => p.chips <= 0);
    if (broke) { endRun(broke); return; }   // first bankruptcy ends the run
  }

  const me = roster[0];
  const btn = $('btnDeal');
  btn.disabled = false;
  btn.textContent = me.chips <= 0 ? 'Rebuy & deal' : 'Deal next hand';
  if (me.chips <= 0) setMessage('You are out of chips! Rebuy to keep playing.');

  if (tutorial) {
    await tutorialStep('end');   // lessons.js: after the last hand this leaves the page
    if (lessonIdx < lessonHands().length - 1) { lessonIdx++; startHand(); }   // otherwise deal the next lesson hand
    return;
  }

  if (cfg.autoDeal && me.chips > 0) {
    await sleep(3000);
    if (cfg.autoDeal && !handActive) startHand();
  }
}

// A run is over: someone is out of chips. Your score is what you have left (0 if it was you).
function endRun(broke) {
  runOver = true;
  const score = roster[0].chips;
  const saved = recordRunResult(score);   // game-account.js
  const hands = handNo;

  $('runReason').textContent = broke.isHuman ? 'You went bankrupt.' : `${broke.name} went bankrupt.`;
  $('runScore').textContent = fmt(score);
  $('runStats').textContent = `${fmt(hands)} hands · ${signed(bbPer100(runBb, hands))} bb/100`;
  const result = $('runResult');
  result.textContent = '';
  if (saved.saved) {
    result.textContent = `Saved to your account. Best this week: ${fmt(saved.best)} · All-time best: ${fmt(saved.high)}`
      + (saved.newHigh ? ' 🎉 New personal best!' : '');
  } else {
    result.textContent = 'Sign in to save your score to the leaderboard. ';
    const btn = document.createElement('button');
    btn.className = 'linkbtn';
    btn.textContent = 'Sign in';
    btn.onclick = () => { $('runOver').close(); openAuthDialog(); };
    result.appendChild(btn);
  }

  setMessage(`Game over: ${broke.isHuman ? 'you' : broke.name} went bankrupt. Final score ${fmt(score)}.`);
  const deal = $('btnDeal');
  deal.disabled = false;
  deal.textContent = 'New game';
  deal.onclick = () => location.reload();   // a fresh page = a fresh run
  $('runOver').showModal();
}

// ---------- Sidebar wiring ----------
$('btnDeal').onclick = startHand;
$('tutLink').onclick = () => !handActive || confirm('Leave this game and open the tutorials?');
$('btnAddBot').onclick = () => addBot($('botSelect').value);

Object.entries(BOT_PROFILES).forEach(([key, p]) => {
  const opt = document.createElement('option');
  opt.value = key;
  opt.textContent = `${p.avatar} ${p.label}`;
  $('botSelect').appendChild(opt);
});
const showBotDesc = () => { $('botDesc').textContent = BOT_PROFILES[$('botSelect').value].desc; };
$('botSelect').onchange = showBotDesc;

// ---------- Start-up ----------
renderRankings();
// Five empty slots for the community cards
for (let i = 0; i < 5; i++) {
  const slot = document.createElement('div');
  slot.className = 'card';
  $('board').appendChild(slot);
}
roster.push(makePlayer({ name: 'You', avatar: '😎', color: '#2f8f5b', isHuman: true }));
showBotDesc();

// The note under the header explains the rules of whichever mode you're in
const MODE_NOTES = {
  run: '🏆 High-score run: you start with 1,000 chips and there are no rebuys. The game ends the moment anyone goes bankrupt, and your score is the chips you have left (0 if it was you). Blinds start at 10/20 and rise every 10 hands.',
  practice: '🎈 Practice: rebuy any time, add any bots, change any setting. Nothing here counts toward your score.',
};

$('pageSub').textContent = tutorial ? 'Tutorial' : runMode ? 'Singleplayer · high-score run' : 'Practice';
if (tutorial) {
  document.body.classList.add('tutorial');
  const rex = makePlayer({ name: 'Rex', avatar: '🤖', color: '#6b7a90', profile: LESSON_BOT, label: 'Practice opponent' });
  roster.push(rex);
  buildTable(roster);
  $('btnDeal').classList.add('hidden');   // the lesson deals itself
  startHand();
} else {
  document.body.classList.add(runMode ? 'run' : 'practice');
  $('modeNote').textContent = MODE_NOTES[runMode ? 'run' : 'practice'];
  $('modeNote').classList.remove('hidden');
  addBot('shark');
  addBot('fox');
  addBot('station');
  log(runMode
    ? 'High-score run! Press Deal to start. The first bankruptcy ends the game.'
    : 'Practice table: press Deal to start. Add or remove bots any time.');
}
