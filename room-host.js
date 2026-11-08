// room-host.js — the "dealer" for one online room. It runs the engine (engine.js), asks bots what to
// do (bots.js), waits for human players' moves, and publishes the table through room-net.js.
//
// For now this runs in a PLAYER'S browser (free, no server). That has one honest limit: that browser does
// the shuffling, so its owner could peek. Fine for friends. This file does not know where it runs: later
// the same code can run on a server and nothing else has to change. If the dealer's browser goes away,
// another seated player takes over from the saved table (see room-client.js).
//
// Three kinds of table (meta.mode):
//   freezeout (default)  a private room. Fixed players, no rebuys, ends when one player has all the chips.
//   open                 an open table. People sit down and leave any time, a busted player can rebuy,
//                        and it plays on for as long as 2 people are there.
//   arena                part of an Arena (arena.js): short rounds with equal stacks, points per round.
//
// Uses: poker.js, engine.js, bots.js (BOT_PROFILES, botDecide), arena.js, and secureRandom from room-net.js.

// Rising blinds: the small blind is the starting small blind times these steps
const BLIND_STEPS = [1, 1.5, 2.5, 5, 7.5, 10, 15, 20, 30, 40, 60, 80, 100];
const stepSmallBlind = (startSb, level) => Math.max(1, Math.round(startSb * BLIND_STEPS[Math.min(level, BLIND_STEPS.length - 1)]));

const sleepMs = ms => new Promise(r => setTimeout(r, ms));
const isBotId = id => String(id).startsWith('bot-');

// The database drops empty arrays, so a saved table comes back missing them. Put them back.
function reviveTable(saved) {
  const t = { ...saved };
  t.board = t.board || [];
  t.deck = t.deck || [];
  t.log = t.log || [];
  t.result = t.result || null;
  t.seats = (t.seats || []).map(s => ({ ...s, hole: s.hole || [], status: s.status || '', statusClass: s.statusClass || '' }));
  return t;
}

// meta: the room's options. seats / bots: who is playing right now (copied from the room).
// resume: a saved host state to carry on from. timing: shorter delays for tests.
function createRoomHost({ net, code, meta, seats, bots, resume = null, timing = {} }) {
  const T = {
    botDelayMs: [700, 1400], resultPauseMs: 4500, absentGraceMs: 6000, waitPollMs: 500,
    roundPauseMs: 8000, awayMs: 90000, beatMs: 20000,
    turnMs: (meta.turnSeconds || 30) * 1000, ...timing,
  };
  const mode = meta.mode || 'freezeout';
  const continuous = mode === 'open' || mode === 'arena';
  const maxSeats = meta.maxSeats || (continuous ? 6 : 8);
  const roundHands = meta.roundHands || ARENA_ROUND_HANDS;

  let stopped = false;
  let present = null;                 // uids currently connected (null until the first report: assume everyone is here)
  let latest = null;                  // the newest public room data (seats, presence, ...)
  let unwatch = [];
  let beatTimer = null;
  const H = {
    seq: 0, deadline: null, waiter: null, inbox: {}, left: [], status: 'playing', winner: null, endReason: null,
    rebuy: [], away: {}, lastWaitKey: '',
    eliminated: [], places: null, botSeq: 0,   // elimination order (first out first) and the final standings
    scores: {}, names: {}, roundNo: 0, round: null, roundResult: null,   // arena
  };
  let t;                              // the engine table

  // ---------- Setting up ----------
  function buildTable() {
    const humans = Object.entries(seats || {})
      .sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0))
      .map(([uid, s]) => newSeat({ id: uid, name: s.name, avatar: s.avatar || '😎', color: s.color || '#2f8f5b', chips: meta.startChips }));
    const botSeats = Object.entries(bots || {}).map(([id, b]) => {
      const p = BOT_PROFILES[b.key];
      return newSeat({ id: 'bot-' + id, name: b.name, avatar: p.avatar, color: p.color, isBot: true, botKey: b.key, chips: meta.startChips });
    });
    return createTable({ seats: humans.concat(botSeats), sb: meta.sb });
  }

  // ---------- Publishing ----------
  // Whose turn it is decides whether there is a countdown (bots have none)
  function armDeadline() {
    H.deadline = null;
    if (t.phase === 'hand-over' || t.phase === 'waiting' || t.toAct < 0) return;
    const s = t.seats[t.toAct];
    if (!s.isBot && !H.left.includes(s.id)) H.deadline = Date.now() + T.turnMs;
  }

  // Everyone can read this. `seq` goes up every time; a move only counts if it names the current seq.
  async function publish() {
    armDeadline();
    H.seq++;
    await net.publishState(code, {
      seq: H.seq, now: Date.now(),
      turnMs: H.deadline ? Math.max(0, H.deadline - Date.now()) : null,   // time left, so players' clocks needn't match ours
      status: H.status, winner: H.winner, endReason: H.endReason, mode, kind: meta.kind || null, places: H.places,
      round: H.round ? { n: H.round.n, hands: H.round.hands, of: roundHands } : null,
      roundResult: H.roundResult,
      view: publicView(t), log: t.log.slice(-25),
    });
    await net.saveHostState(code, {
      table: t, seq: H.seq, left: H.left, status: H.status,
      scores: H.scores, names: H.names, roundNo: H.roundNo, round: H.round, roundResult: H.roundResult,
      eliminated: H.eliminated, places: H.places,
    });
  }

  // Each human's two cards, readable only by that human (and us)
  const publishHoles = () => Promise.all(
    t.seats.filter(s => !s.isBot).map(s => net.publishPrivate(code, s.id, { handNo: t.handNo, hole: s.hole.map(c => c.id) })));

  // The line in the public list of tables and tournaments (it also tells everyone we are still here)
  function listing() {
    const me = t.seats.find(s => s.id === net.uid);
    return makeListing({
      code, meta, hostName: me ? me.name : meta.hostName, status: H.status === 'finished' ? 'finished' : 'playing',
      humans: t.seats.filter(s => !s.isBot).length, bots: t.seats.filter(s => s.isBot).length,
      sb: t.sb, max: meta.size || maxSeats,
    });
  }
  const listed = continuous || Boolean(meta.kind);
  const publishListing = () => (listed ? net.publishLobby(code, listing()).catch(() => {}) : Promise.resolve());

  // ---------- Moves ----------
  async function botMove(idx) {
    const [lo, hi] = T.botDelayMs;
    await sleepMs(lo + Math.random() * (hi - lo));
    return botDecide(BOT_PROFILES[t.seats[idx].botKey], botContext(t, idx));
  }

  // Wait for a human's move. A timeout or a dropped connection folds them (or checks, if that's free).
  function humanMove(idx) {
    const seat = t.seats[idx];
    if (H.left.includes(seat.id)) return Promise.resolve({ type: 'fold' });
    const auto = legal(t, idx).toCall === 0 ? { type: 'call' } : { type: 'fold' };
    return new Promise(resolve => {
      let absent = 0;
      const finish = a => { clearInterval(tick); clearTimeout(turnTimer); H.waiter = null; resolve(a); };
      // Look for a move that names the current seq (it may have arrived before we started waiting)
      const check = () => {
        if (H.left.includes(seat.id)) return finish({ type: 'fold' });
        const a = H.inbox[seat.id];
        if (a && a.seq === H.seq) { delete H.inbox[seat.id]; finish({ type: a.type, amount: a.amount }); }
      };
      const turnTimer = setTimeout(() => finish(auto), Math.max(0, (H.deadline || Date.now()) - Date.now()));
      const tick = setInterval(() => {
        if (present && !present.has(seat.id)) { absent += 250; if (absent >= T.absentGraceMs) finish(auto); } else absent = 0;
      }, 250);
      H.waiter = { check, cancel: () => finish(null) };
      check();
    });
  }

  function onAction(uid, a) {
    if (a.type === 'leave') { if (!H.left.includes(uid)) H.left.push(uid); }
    else if (a.type === 'rebuy') { if (!H.rebuy.includes(uid)) H.rebuy.push(uid); }
    else H.inbox[uid] = a;
    if (H.waiter) H.waiter.check();
  }

  // ---------- Between hands ----------
  const alive = () => t.seats.filter(s => s.chips > 0);
  const here = s => s.isBot || !present || present.has(s.id);   // connected (bots always are)

  // Open tables and the arena: let people come and go. Only ever called between hands.
  function syncSeats() {
    const wanted = (latest && latest.seats) || {};
    const now = Date.now();
    // 1. People who left: took their seat away, said "leave", or stayed disconnected too long
    const gone = t.seats.filter(s => !s.isBot
      && (!wanted[s.id] || H.left.includes(s.id) || (H.away[s.id] && now - H.away[s.id] > T.awayMs))).map(s => s.id);
    if (gone.length) {
      if (H.round) gone.forEach(id => { if (H.round.ids.includes(id)) H.round.chips[id] = 0; });   // leaving mid-round: you finish last
      removeSeats(t, gone);
      gone.forEach(id => net.leaveSeat(code, id).catch(() => {}));
      H.left = H.left.filter(id => !gone.includes(id));
    }
    // 2. Newcomers sit down (the arena makes them wait for the next round). A full table turns the rest away.
    Object.entries(wanted).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0)).forEach(([uid, info]) => {
      if (t.seats.some(s => s.id === uid) || H.left.includes(uid)) return;
      if (t.seats.filter(s => !s.isBot).length >= maxSeats) { net.leaveSeat(code, uid).catch(() => {}); return; }
      const seat = newSeat({ id: uid, name: info.name, avatar: info.avatar || '😎', color: info.color || '#2f8f5b', chips: mode === 'arena' ? 0 : meta.startChips });
      seat.waiting = mode === 'arena';
      addSeat(t, seat);
    });
    // 3. Rebuys (open tables): a busted player asked for fresh chips
    if (mode === 'open') H.rebuy.forEach(uid => { const s = t.seats.find(x => x.id === uid); if (s && s.chips === 0) s.chips = meta.startChips; });
    H.rebuy = [];
  }

  // Arena tables with `fillBots`: bots keep a lone player company (up to ARENA_MIN_TABLE players) and step aside
  // as humans arrive. They play like any bot but never appear in the standings or earn rating points.
  function balanceBots() {
    if (!meta.fillBots) return;
    const humansHere = t.seats.filter(s => !s.isBot && here(s)).length;
    const want = humansHere === 0 ? 0 : Math.max(0, ARENA_MIN_TABLE - humansHere);
    const bots = t.seats.filter(s => s.isBot);
    if (bots.length > want) removeSeats(t, bots.slice(want).map(b => b.id));
    const keys = Object.keys(BOT_PROFILES);
    for (let i = t.seats.filter(s => s.isBot).length; i < want; i++) {
      const used = new Set(t.seats.map(s => s.botKey || s.name));
      const key = keys.find(k => !used.has(k)) || keys[i % keys.length];
      const profile = BOT_PROFILES[key];
      const taken = new Set(t.seats.map(s => s.name));
      const name = profile.names.find(n => !taken.has(n)) || `${profile.label} ${++H.botSeq}`;
      addSeat(t, newSeat({ id: 'bot-f' + (++H.botSeq), name, avatar: profile.avatar, color: profile.color, isBot: true, botKey: key, chips: meta.startChips }));
    }
  }

  // Each mode answers "what happens before the next hand?" with 'deal', 'wait' (not enough players) or 'end'
  const prepare = {
    // Private room: when a hand ends, leavers cash out, the game may be over, and the blinds may rise
    async freezeout() {
      if (t.phase === 'hand-over') {
        t.seats.forEach(s => { if (H.left.includes(s.id)) s.chips = 0; });   // people who left take their chips with them
        // Whoever has just run out of chips is knocked out; several in one hand: the smaller starting stack places lower
        const busted = t.seats.filter(s => s.chips === 0 && s.handStartChips > 0 && !H.eliminated.includes(s.id));
        H.eliminated.push(...knockoutOrder(busted.map(s => ({ id: s.id, startChips: s.handStartChips }))));
        if (alive().length < 2 || alive().every(s => s.isBot)) return 'end';
        if (meta.rising) { t.sb = stepSmallBlind(meta.sb, Math.floor(t.handNo / (meta.handsPerLevel || 10))); t.bb = t.sb * 2; }
      }
      return 'deal';
    },

    async open() {
      syncSeats();
      return alive().length >= 2 ? 'deal' : 'wait';
    },

    // Arena table: rounds of equal stacks. Returns 'deal' while a round is running.
    async arena(handJustEnded) {
      syncSeats();
      if (H.round) {
        if (handJustEnded) H.round.hands++;
        t.seats.forEach(s => { if (H.round.ids.includes(s.id)) H.round.chips[s.id] = s.chips; });
        const stillIn = H.round.ids.filter(id => t.seats.some(s => s.id === id && s.chips > 0));
        if (H.round.hands < roundHands && stillIn.length >= 2) {
          t.sb = stepSmallBlind(meta.sb, Math.floor(H.round.hands / ARENA_HANDS_PER_LEVEL));   // blinds climb inside a round
          t.bb = t.sb * 2;
          return 'deal';
        }
        await endRound();
        await sleepMs(T.roundPauseMs);
        if (stopped) return 'end';
        syncSeats();
      }
      if (Date.now() >= meta.arenaEnd) return 'end';
      balanceBots();
      const players = t.seats.filter(here);
      if (players.length < 2) return 'wait';
      startRound(players);
      return 'deal';
    },
  };

  // ---------- Arena rounds ----------
  function startRound(players) {
    H.roundNo++;
    H.round = { n: H.roundNo, hands: 0, ids: players.map(s => s.id), chips: {} };
    H.roundResult = null;
    t.seats.forEach(s => {
      if (players.includes(s)) { s.chips = meta.startChips; s.waiting = false; H.round.chips[s.id] = s.chips; H.names[s.id] = s.name; }
      else { s.chips = 0; s.waiting = true; }   // not here: sits this round out
    });
    t.sb = meta.sb; t.bb = t.sb * 2;
    say(t, `— Round ${H.roundNo}: everyone starts with ${meta.startChips.toLocaleString()} chips, ${roundHands} hands —`, 'hand');
  }

  // Rank the players by chips, award points, and publish this table's running scores
  async function endRound() {
    const rows = scoreRound(H.round.ids.map(id => ({ id, chips: H.round.chips[id] || 0 })));
    rows.forEach(r => {
      r.name = H.names[r.id] || r.id;
      if (isBotId(r.id)) return;                                   // bots don't appear in the standings
      const s = H.scores[r.id] || (H.scores[r.id] = { name: r.name, points: 0, rounds: 0, wins: 0 });
      s.name = r.name; s.points += r.points; s.rounds += 1; if (r.rank === 1) s.wins += 1;
    });
    H.roundResult = { n: H.round.n, rows: rows.map(r => ({ id: r.id, name: r.name, chips: r.chips, rank: r.rank, points: r.points })) };
    say(t, `Round ${H.round.n} over: ` + rows.map(r => `${r.name} #${r.rank} (+${r.points})`).join(', '), 'win');
    H.round = null;
    if (meta.arena) await net.publishArenaTable(meta.arena, code, { host: net.uid, updated: Date.now(), scores: H.scores }).catch(() => {});
    await publish();
  }

  // Final standings for a freezeout. A tournament (meta.kind) also publishes them so that rating points can be counted later.
  async function recordPlaces(standing) {
    const byId = id => t.seats.find(s => s.id === id);
    const ranked = finalPlaces(standing.map(s => s.id), H.eliminated);
    H.places = ranked.map(p => ({ id: p.id, name: (byId(p.id) || {}).name || p.id, place: p.place, isBot: Boolean(byId(p.id) && byId(p.id).isBot) }));
    if (!meta.kind) return;
    const humans = H.places.filter(p => !p.isBot);
    const results = { code, kind: meta.kind, finished: Date.now(), n: humans.length, places: {} };
    humans.forEach((p, i) => { results.places[p.id] = { name: p.name, place: i + 1 }; });   // places among the humans
    await net.publishTourneyResults(code, results).catch(() => {});
  }

  async function finishGame() {
    H.status = 'finished';
    const standing = alive().sort((a, b) => b.chips - a.chips);
    H.winner = mode === 'arena' ? null : (standing.length ? standing[0].id : null);
    H.endReason = mode === 'arena' ? 'arena-over' : (standing.length === 1 ? 'last-standing' : 'humans-out');
    if (mode === 'freezeout') await recordPlaces(standing);
    await publish();
    await net.updateMeta(code, { status: 'finished' }).catch(() => {});
    await net.removeLobby(code).catch(() => {});
    stop();
  }

  // Publish "waiting for players" once (and again only when something changed)
  async function publishWaiting() {
    H.status = 'waiting';
    const key = t.seats.map(s => s.id + ':' + s.chips).join(',') + '|' + (H.roundResult ? H.roundResult.n : 0);
    if (key === H.lastWaitKey) return;
    H.lastWaitKey = key;
    await publish();
    await publishListing();
  }

  async function loop() {
    let needPause = t.phase === 'hand-over';   // after a hand, let everyone look at the result
    let handJustEnded = false;
    while (!stopped) {
      if (t.phase === 'waiting' || t.phase === 'hand-over') {
        if (needPause) { await sleepMs(T.resultPauseMs); needPause = false; if (stopped) return; }
        const next = await prepare[mode](handJustEnded);
        handJustEnded = false;
        if (stopped) return;
        if (next === 'end') return finishGame();
        if (next === 'wait' || !startHand(t, { rng: secureRandom })) {
          if (!continuous) return finishGame();    // a private room with fewer than 2 players with chips is over
          await publishWaiting();
          await sleepMs(T.waitPollMs);
          continue;
        }
        H.status = 'playing';
        H.lastWaitKey = '';
        await publishHoles();                      // cards first, so they are there when the table appears
        await publish();
        await publishListing();
      }
      while (t.phase !== 'hand-over' && !stopped) {
        const idx = t.toAct;
        const move = t.seats[idx].isBot ? await botMove(idx) : await humanMove(idx);
        if (stopped || !move) return;
        act(t, idx, move);
        await publish();
      }
      if (stopped) return;
      needPause = true;
      handJustEnded = true;
    }
  }

  // ---------- Start / stop ----------
  function stop() {
    stopped = true;
    if (H.waiter) H.waiter.cancel();
    clearInterval(beatTimer);
    unwatch.forEach(fn => fn());
    unwatch = [];
  }

  // Stop and take the table off the public list (the host is closing it for good)
  async function close() {
    stop();
    await net.removeLobby(code).catch(() => {});
  }

  async function run() {
    if (resume) {
      t = reviveTable(resume.table);
      H.seq = resume.seq || 0;
      H.left = resume.left || [];
      H.scores = resume.scores || {};
      H.names = resume.names || {};
      H.roundNo = resume.roundNo || 0;
      H.round = resume.round ? { ...resume.round, ids: resume.round.ids || [], chips: resume.round.chips || {} } : null;
      H.roundResult = resume.roundResult || null;
      H.status = resume.status === 'waiting' ? 'waiting' : 'playing';
    } else {
      t = buildTable();
    }
    unwatch.push(net.watchActions(code, onAction));
    unwatch.push(net.watchRoom(code, r => {
      latest = r;
      present = new Set(Object.keys((r && r.presence) || {}));
      const now = Date.now();
      t.seats.forEach(s => {   // remember how long each human has been away (open tables drop people who stay away)
        if (s.isBot) return;
        if (present.has(s.id)) delete H.away[s.id]; else if (!H.away[s.id]) H.away[s.id] = now;
      });
    }));
    if (listed) { await publishListing(); beatTimer = setInterval(publishListing, T.beatMs); }
    if (resume) await publish();                   // show the restored table straight away
    await loop();
  }

  return { run, stop, close, table: () => t };
}
