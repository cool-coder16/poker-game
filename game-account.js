// game-account.js — connects your account to the table (play.html only).
// Loaded before game.js (see the comment in play.html), so everything here that touches the game's
// globals (roster, cfg, log, ...) only does so inside functions that run later.

let authDirty = false;   // you signed in/out mid-hand: apply it when the next hand starts

// Put your saved name on your seat (or go back to "You" as a guest). Chips are never touched:
// every run starts fresh with 1,000, and Practice chips are just for fun.
function syncProfileToGame() {
  if (handActive) { authDirty = true; return; }   // never change seats in the middle of a hand
  authDirty = false;
  roster[0].name = currentUser && profile ? profile.displayName : 'You';
  buildTable(roster);
  renderRoster();
}

// game.js calls this at the start of every hand
function applyPendingProfile() {
  if (authDirty) syncProfileToGame();
}

// game.js calls this at the end of every hand of a run: update season stats and save them
function recordHandResult() {
  if (!currentUser || !profile || authDirty) return;
  const me = roster[0];
  profile.handsPlayed++;
  profile.sHands++;
  // Net big blinds won this hand (can be negative); rounded so the saved number stays tidy
  profile.sBb = Math.round((profile.sBb + (me.chips - humanStartChips) / bigBlind()) * 100) / 100;
  if (humanWinAmount > 0) {
    profile.handsWon++;
    profile.sWins++;
    profile.biggestPot = Math.max(profile.biggestPot, humanWinAmount);
  }
  window.pokerAuth.saveProfile(profile).catch(err => log('Could not save your progress: ' + err.message));
}

// game.js calls this when a run ends. Returns what to tell the player:
// { saved: false } for guests, or { saved: true, best, high, newHigh } when signed in.
function recordRunResult(score) {
  if (!currentUser || !profile) return { saved: false };
  const newHigh = score > profile.high;
  profile.runs++;
  profile.best = Math.max(profile.best, score);
  profile.high = Math.max(profile.high, score);
  window.pokerAuth.saveProfile(profile, true).catch(err => log('Could not save your score: ' + err.message));
  return { saved: true, best: profile.best, high: profile.high, newHigh };
}

// Whenever sign-in state is (re)loaded, update the seat. The tutorial table is separate: leave it alone.
onAuth(() => { if (!tutorial) syncProfileToGame(); });
