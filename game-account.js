// game-account.js — connects your account to the table (play.html only).
// Loaded after game.js and account.js, so it can use the game's globals (roster, cfg, log, ...).

let authDirty = false;   // you signed in/out mid-hand: apply it when the next hand starts

// Put your saved name and season chips on your seat (or go back to "You" as a guest).
function syncProfileToGame() {
  if (handActive) { authDirty = true; return; }   // never change seats in the middle of a hand
  authDirty = false;
  const me = roster[0];
  if (currentUser && profile) {
    me.name = profile.displayName;
    me.chips = profile.chips > 0 ? profile.chips : SEASON_START_CHIPS;   // busted last time: startHand rebuys
  } else {
    me.name = 'You';
    me.chips = cfg.startChips;
  }
  buildTable(roster);
  renderRoster();
}

// game.js calls this at the start of every hand
function applyPendingProfile() {
  if (authDirty) syncProfileToGame();
}

// game.js calls this when you are out of chips. Signed in: the rebuy is always the season
// amount and is counted against your score. Guest: whatever "Starting chips" is set to.
function humanRebuyAmount() {
  if (!currentUser || !profile || tutorial) return cfg.startChips;
  profile.rebuys++;
  return SEASON_START_CHIPS;
}

// game.js calls this at the end of every hand: update stats and save them
function recordHandResult() {
  if (!currentUser || !profile || authDirty) return;
  const me = roster[0];
  profile.chips = me.chips;
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

// Whenever sign-in state is (re)loaded, update the seat. The tutorial table is separate: leave it alone.
onAuth(() => { if (!tutorial) syncProfileToGame(); });
