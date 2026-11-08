// tourney-rating.js — adds your Sit & Go / scheduled tournament results to your rating.
//
// When you sit down in a tournament, the room page marks it (tourneyPlayed/<you>/<code>). When it finishes, the host
// publishes the final places (tourneys/<code>/results). The next time you open the site, this reads the results,
// works out your points (tournamentPoints in tournament.js) and adds them to your profile, once per tournament.
// Like the other results, this is worked out in your own browser, so it runs on the honor system for now.

async function settleTourneyRatings(net, uid, profile, now = Date.now()) {
  const played = (await net.getTourneyPlayed()) || {};            // { code: when you sat down }
  const done = new Set(profile.tourneyDone || []);
  let changed = false, handled = 0;
  const pending = Object.entries(played).filter(([code]) => !done.has(code)).sort((a, b) => a[1] - b[1]);
  for (const [code, joinedAt] of pending) {
    if (handled++ >= 30) break;                                    // don't do too much in one visit
    const results = await net.getTourney(code);
    if (!results) {                                                // not finished (or never started)
      if (now - joinedAt > TOURNEY_SETTLE_WAIT_MS) { done.add(code); changed = true; }   // give up waiting after a while
      continue;
    }
    done.add(code);
    changed = true;
    const mine = results.places && results.places[uid];
    if (!mine || results.n < TOURNEY_MIN_PLAYERS) continue;        // you didn't finish, or too few humans to count
    const points = tournamentPoints(mine.place, results.n);
    profile.tourneys += 1;
    profile.tourneyPoints += points;
    profile.points += points;                                      // tournament points count toward your rating
    profile.tourneyBest = profile.tourneyBest ? Math.min(profile.tourneyBest, mine.place) : mine.place;
    profile.tourneyLog = [{ code, kind: results.kind, place: mine.place, of: results.n, points }, ...(profile.tourneyLog || [])].slice(0, 8);
  }
  profile.tourneyDone = [...done].slice(-80);
  return changed;
}

// The browser side: account.js calls this after sign-in. Returns true if your rating changed.
let settlingTourneys = false;
async function settleTourneys() {
  if (settlingTourneys || !currentUser || !profile) return false;
  settlingTourneys = true;
  try {
    if (!window.pokerRooms) await new Promise(r => window.addEventListener('pokerrooms-ready', r, { once: true }));
    if (!window.pokerRooms.configured) return false;
    const changed = await settleTourneyRatings(window.pokerRooms.makeNet(), currentUser.uid, profile);
    if (changed) await window.pokerAuth.saveProfile(profile, true);
    return changed;
  } finally { settlingTourneys = false; }
}
