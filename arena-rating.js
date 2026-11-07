// arena-rating.js — adds your Arena results to your rating.
//
// When you sit down at an Arena table, the room page marks that Arena as played (arenaPlayed/<you>/<id>).
// Later, once an Arena has finished (and its scores are final), this totals up that Arena's standings,
// works out your place (arenaResult in arena.js) and adds any rating points to your profile.
// It runs when you open the site; each Arena is only ever counted once (profile.arenaDone remembers).
// Like the weekly season, this is worked out in your own browser, so it runs on the honor system for now.

// The core: look at the Arenas `uid` played, and count the finished ones that haven't been counted yet.
// Changes `profile` and returns true if anything changed. `net` is a room-net.js object.
async function settleArenaRatings(net, uid, profile, now = Date.now()) {
  const played = Object.keys((await net.getArenaPlayed()) || {}).sort();   // ids sort in time order
  let changed = false, handled = 0;
  for (const id of played) {
    if (id <= (profile.arenaDone || '')) continue;         // already counted
    if (!arenaSettled(id, now)) break;                      // too recent, and every later one is newer still
    if (handled++ >= 30) break;                             // don't do too much in one visit; the rest next time
    const r = arenaResult(await net.getArena(id), uid);
    if (r.counted) {
      profile.arenas += 1;
      profile.arenaPoints += r.points;
      profile.points += r.points;                           // Arena points count toward your rating
      profile.arenaBest = profile.arenaBest ? Math.min(profile.arenaBest, r.rank) : r.rank;
      profile.arenaLog = [{ id, rank: r.rank, of: r.of, points: r.points }, ...(profile.arenaLog || [])].slice(0, 8);
    }
    profile.arenaDone = id;
    changed = true;
  }
  return changed;
}

// The browser side: runs after sign-in (account.js calls it). Returns true if your rating changed.
let settlingArenas = false;
async function settleArenas() {
  if (settlingArenas || !currentUser || !profile) return false;
  settlingArenas = true;
  try {
    if (!window.pokerRooms) await new Promise(r => window.addEventListener('pokerrooms-ready', r, { once: true }));
    if (!window.pokerRooms.configured) return false;
    const changed = await settleArenaRatings(window.pokerRooms.makeNet(), currentUser.uid, profile);
    if (changed) await window.pokerAuth.saveProfile(profile, true);   // true: also updates your public rating line
    return changed;
  } finally { settlingArenas = false; }
}
