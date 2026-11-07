// room-host.js — the "dealer" for one online room. It runs the engine (engine.js), asks bots what to
// do (bots.js), waits for human players' moves, and publishes the table through room-net.js.
//
// For now this runs in the HOST PLAYER'S browser (free, no server). That has one honest limit: the
// host's browser does the shuffling, so a host could peek. Fine for friends. This file does not know
// where it runs: later the same code can run on a server and nothing else has to change.
//
// Uses: poker.js, engine.js, bots.js (BOT_PROFILES, botDecide) and secureRandom from room-net.js.

// Rising blinds (optional): the small blind is the room's starting small blind times these steps
const BLIND_STEPS = [1, 1.5, 2.5, 5, 7.5, 10, 15, 20, 30, 40, 60, 80, 100];

const sleepMs = ms => new Promise(r => setTimeout(r, ms));

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

// meta: the room's options (startChips, sb, turnSeconds, rising, handsPerLevel).
// seats / bots: who is playing (copied from the lobby). resume: a saved table to carry on from.
// timing: shorter delays for tests.
function createRoomHost({ net, code, meta, seats, bots, resume = null, timing = {} }) {
  const T = {
    botDelayMs: [700, 1400], resultPauseMs: 4500, absentGraceMs: 6000,
    turnMs: (meta.turnSeconds || 30) * 1000, ...timing,
  };
  let stopped = false;
  let present = null;                 // uids currently connected (null until the first report: assume everyone is here)
  let unwatch = [];
  const H = { seq: 0, deadline: null, waiter: null, inbox: {}, left: [], status: 'playing', winner: null, endReason: null };
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
      status: H.status, winner: H.winner, endReason: H.endReason,
      view: publicView(t), log: t.log.slice(-25),
    });
    await net.saveHostState(code, { table: t, seq: H.seq, left: H.left, status: H.status });
  }

  // Each human's two cards, readable only by that human (and us)
  const publishHoles = () => Promise.all(
    t.seats.filter(s => !s.isBot).map(s => net.publishPrivate(code, s.id, { handNo: t.handNo, hole: s.hole.map(c => c.id) })));

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
    else H.inbox[uid] = a;
    if (H.waiter) H.waiter.check();
  }

  // ---------- The game loop ----------
  const alive = () => t.seats.filter(s => s.chips > 0);
  const gameIsOver = () => alive().length < 2 || alive().every(s => s.isBot);

  function raiseBlinds() {
    if (!meta.rising) return;
    const level = Math.floor(t.handNo / (meta.handsPerLevel || 10));
    t.sb = Math.max(1, Math.round(meta.sb * BLIND_STEPS[Math.min(level, BLIND_STEPS.length - 1)]));
    t.bb = t.sb * 2;
  }

  // Why the game ended: one player has everything, or every human is out (then the chip leader is named)
  async function finishGame() {
    H.status = 'finished';
    const standing = alive().sort((a, b) => b.chips - a.chips);
    H.winner = standing.length ? standing[0].id : null;
    H.endReason = standing.length === 1 ? 'last-standing' : 'humans-out';
    await publish();
    await net.updateMeta(code, { status: 'finished' });
    stop();
  }

  async function loop() {
    while (!stopped) {
      if (t.phase === 'waiting' || t.phase === 'hand-over') {
        if (t.phase === 'hand-over') {
          await sleepMs(T.resultPauseMs);          // let everyone look at the showdown
          if (stopped) return;
          t.seats.forEach(s => { if (H.left.includes(s.id)) s.chips = 0; });   // people who left take their chips with them
          if (gameIsOver()) return finishGame();
          raiseBlinds();
        }
        if (!startHand(t, { rng: secureRandom })) return finishGame();
        await publishHoles();                      // cards first, so they are there when the table appears
        await publish();
      }
      while (t.phase !== 'hand-over' && !stopped) {
        const idx = t.toAct;
        const move = t.seats[idx].isBot ? await botMove(idx) : await humanMove(idx);
        if (stopped || !move) return;
        act(t, idx, move);
        await publish();
      }
    }
  }

  // ---------- Start / stop ----------
  function stop() {
    stopped = true;
    if (H.waiter) H.waiter.cancel();
    unwatch.forEach(fn => fn());
    unwatch = [];
  }

  async function run() {
    if (resume) {
      t = reviveTable(resume.table);
      H.seq = resume.seq || 0;
      H.left = resume.left || [];
    } else {
      t = buildTable();
    }
    unwatch.push(net.watchActions(code, onAction));
    unwatch.push(net.watchRoom(code, r => { present = new Set(Object.keys((r && r.presence) || {})); }));
    if (resume) await publish();                   // show the restored table straight away
    await loop();
  }

  return { run, stop, table: () => t };
}
