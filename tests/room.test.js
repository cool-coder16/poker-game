// tests/room.test.js — run with:  node tests/room.test.js
// Runs whole online rooms (host + simulated players + bots) on the in-memory store. No network needed.
const assert = require('assert');
const { load, seeded } = require('./helpers');
if (!globalThis.crypto) globalThis.crypto = require('crypto').webcrypto;
load('poker.js', 'engine.js', 'bots.js', 'store-memory.js', 'room-net.js', 'room-host.js', 'room-view.js', 'arena.js', 'arena-rating.js');

let passed = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL  ' + name + '\n' + e.stack); process.exitCode = 1; }
}
async function until(fn, ms = 20000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await sleep(5); }
  throw new Error('timed out waiting for ' + what);
}

const FAST = { botDelayMs: [0, 0], resultPauseMs: 0, absentGraceMs: 400 };

// A room with some human players (the first is the host) and some bots
async function setupRoom({ humans, bots = [], meta = {}, timing = {} }) {
  const hub = createMemoryHub();
  const nets = Object.fromEntries(humans.map(u => [u, createRoomNet(hub.store(u))]));
  const hostNet = nets[humans[0]];
  const code = await hostNet.createRoom({ hostName: humans[0], startChips: 150, sb: 10, turnSeconds: 5, rising: false, ...meta });
  for (const [i, u] of humans.entries()) await nets[u].joinSeat(code, { name: u, avatar: '😎', color: '#2f8f5b', joinedAt: i });
  const botObj = {};
  bots.forEach((key, i) => { botObj['b' + i] = { key, name: BOT_PROFILES[key].names[0] }; });
  await hostNet.setBots(code, botObj);
  return { hub, nets, hostNet, code, timing: { ...FAST, ...timing } };
}

async function startHost(room, resume = null) {
  const r = await room.hostNet.getRoom(room.code);
  await room.hostNet.updateMeta(room.code, { status: 'playing' });
  const host = createRoomHost({ net: room.hostNet, code: room.code, meta: r.meta, seats: r.seats, bots: r.bots, resume, timing: room.timing });
  host.promise = host.run();
  return host;
}

// A simulated human: watches the room and answers when it is their turn
function simPlayer(room, uid, { seed = 1, respond = true, passive = false, onState = null } = {}) {
  const net = room.nets[uid];
  const rng = seeded(seed);
  const me = { uid, hole: [], states: 0, actions: 0, stop: null };
  net.watchPrivate(room.code, p => { me.hole = (p && p.hole) || []; });
  net.announcePresence(room.code);
  let lastSeq = -1;
  me.stop = net.watchRoom(room.code, r => {
    const st = r && r.state;
    if (!st) return;
    me.states++;
    if (onState) onState(st, me);
    if (!respond || st.view.toAct !== uid || st.seq === lastSeq) return;
    lastSeq = st.seq;
    const L = legalFromView(st.view, uid);
    const roll = rng();
    let a;
    if (passive) a = { type: 'call' };            // only ever checks or calls
    else if (roll < 0.15 && L.toCall > 0) a = { type: 'fold' };
    else if (roll < 0.4 && L.canRaise) a = { type: 'raise', amount: L.minRaiseTo + Math.floor(rng() * (L.maxRaiseTo - L.minRaiseTo + 1)) };
    else a = { type: 'call' };
    me.actions++;
    net.sendAction(room.code, { seq: st.seq, ...a });
  });
  return me;
}

const finished = room => until(() => room.hub.peek(`rooms/${room.code}/meta/status`) === 'finished', 30000, 'game to finish');
const chipsOf = room => room.hub.peek(`rooms/${room.code}/state`).view.seats.reduce((s, x) => s + x.chips, 0);

(async () => {
  console.log('room tests');

  await test('a full game: 3 humans + 2 bots play to a winner, chips conserved, hole cards stay private', async () => {
    const room = await setupRoom({ humans: ['ann', 'ben', 'cat'], bots: ['shark', 'fox'] });
    const leaks = [];
    const players = ['ann', 'ben', 'cat'].map((u, i) => simPlayer(room, u, {
      seed: 10 + i,
      onState: (st, me) => st.view.seats.forEach(s => {
        // The public table may only show someone's cards when they are at a showdown
        if ((s.hole || []).length && !s.showCards) leaks.push(`${me.uid} saw ${s.id}'s cards`);
      }),
    }));
    const host = await startHost(room);
    await finished(room);
    await host.promise;
    const st = room.hub.peek(`rooms/${room.code}/state`);
    assert.strictEqual(st.status, 'finished');
    assert(st.winner, 'there should be a winner');
    // Random play can end two ways; whichever happened must be consistent with the final chips
    const withChips = st.view.seats.filter(s => s.chips > 0);
    if (st.endReason === 'last-standing') assert.strictEqual(withChips.length, 1, 'one player has everything');
    else {
      assert.strictEqual(st.endReason, 'humans-out');
      assert(withChips.every(s => s.isBot), 'only bots have chips left');
      assert.strictEqual(st.winner, withChips.sort((a, b) => b.chips - a.chips)[0].id, 'the chip leader is named');
    }
    assert.strictEqual(chipsOf(room), 5 * 150, 'chips changed');
    assert.deepStrictEqual(leaks, []);
    assert(players.every(p => p.actions > 0), 'every human got to act');
    // each human's private cards are only readable under their own path
    assert(room.hub.peek(`roomPrivate/${room.code}/ann`));
    players.forEach(p => p.stop());
  });

  await test('every published state can be drawn (room-view), with the cards each player may see', async () => {
    const room = await setupRoom({ humans: ['ann', 'ben'], bots: ['station'] });
    const problems = [];
    let drawn = 0;
    const check = (uid, privateRef) => st => {
      try {
        const shown = tableFromState(st.view, uid, privateRef.v);
        drawn++;
        assert.strictEqual(shown.list[0].id, uid, 'my seat is first');
        shown.list.slice(1).forEach(p => p.hole.forEach(c => { if (!p.showCards) assert.strictEqual(c.id, -1, 'saw a real card'); }));
        assert.strictEqual(shown.board.length, st.view.board ? st.view.board.length : 0);
        if (privateRef.v && privateRef.v.handNo === st.view.handNo && st.view.seats.find(s => s.id === uid).inHand) {
          assert.strictEqual(shown.list[0].hole.length, 2, 'I should see my own two cards');
        }
      } catch (e) { problems.push(uid + ': ' + e.message); }
    };
    const refs = { ann: { v: null }, ben: { v: null } };
    room.nets.ann.watchPrivate(room.code, p => { refs.ann.v = p; });
    room.nets.ben.watchPrivate(room.code, p => { refs.ben.v = p; });
    simPlayer(room, 'ann', { seed: 51, onState: check('ann', refs.ann) });
    simPlayer(room, 'ben', { seed: 52, onState: check('ben', refs.ben) });
    await startHost(room);
    await finished(room);
    assert(drawn > 20, 'should have drawn many states, drew ' + drawn);
    assert.deepStrictEqual(problems.slice(0, 3), []);
  });

  await test('moves that are out of turn or name an old state are ignored', async () => {
    const room = await setupRoom({ humans: ['ann', 'ben'], timing: { absentGraceMs: 9999 } });
    const ann = simPlayer(room, 'ann', { respond: false });
    const ben = simPlayer(room, 'ben', { respond: false });
    const host = await startHost(room);
    await until(() => (room.hub.peek(`rooms/${room.code}/state`) || {}).view, 2000, 'first state');
    const who = () => room.hub.peek(`rooms/${room.code}/state`).view.toAct;
    const other = who() === 'ann' ? 'ben' : 'ann';
    const seq = () => room.hub.peek(`rooms/${room.code}/state`).seq;
    // the player whose turn it is NOT tries to raise, naming the current seq
    const s0 = seq();
    await room.nets[other].sendAction(room.code, { seq: s0, type: 'raise', amount: 100 });
    await sleep(50);
    assert.strictEqual(seq(), s0, 'out-of-turn move must not advance the game');
    // the right player sends a move naming an OLD seq: ignored too
    await room.nets[who()].sendAction(room.code, { seq: s0 - 1, type: 'fold' });
    await sleep(50);
    assert.strictEqual(seq(), s0, 'stale move must not advance the game');
    // the right move works
    const actor = who();
    await room.nets[actor].sendAction(room.code, { seq: s0, type: 'call' });
    await until(() => seq() > s0, 2000, 'valid move to be applied');
    const log = room.hub.peek(`rooms/${room.code}/state`).log.map(l => l.text).join('\n');
    assert(!log.includes(`${other} raises`), 'the out-of-turn raise was applied');
    host.stop(); ann.stop(); ben.stop();
  });

  await test('a player who does not answer is checked or folded when the clock runs out', async () => {
    const room = await setupRoom({ humans: ['ann', 'ben'], meta: { turnSeconds: 5 }, timing: { turnMs: 150, absentGraceMs: 9999 } });
    simPlayer(room, 'ben', { seed: 3 });        // ben plays; ann never answers
    simPlayer(room, 'ann', { respond: false });
    const host = await startHost(room);
    await until(() => {
      const st = room.hub.peek(`rooms/${room.code}/state`);
      return st && st.log.some(l => /^ann (folds|checks)/.test(l.text));
    }, 5000, 'ann to be timed out');
    host.stop();
  });

  await test('a player whose connection drops is auto-folded quickly (before the turn clock)', async () => {
    const room = await setupRoom({ humans: ['ann', 'ben'], meta: { turnSeconds: 30 }, timing: { turnMs: 30000, absentGraceMs: 300 } });
    simPlayer(room, 'ben', { seed: 4 });
    simPlayer(room, 'ann', { respond: false });
    const host = await startHost(room);
    await sleep(100);
    room.hub.disconnect('ann');                 // ann closes the tab
    const t0 = Date.now();
    await until(() => {
      const st = room.hub.peek(`rooms/${room.code}/state`);
      return st && st.log.some(l => /^ann (folds|checks)/.test(l.text));
    }, 5000, 'ann to be auto-folded');
    assert(Date.now() - t0 < 3000, 'should not wait for the 30s turn clock');
    host.stop();
  });

  await test('the host can refresh and resume the same game', async () => {
    const room = await setupRoom({ humans: ['ann', 'ben', 'cat'], bots: ['rock'] });
    ['ann', 'ben', 'cat'].forEach((u, i) => simPlayer(room, u, { seed: 20 + i }));
    const host = await startHost(room);
    await until(() => (room.hub.peek(`rooms/${room.code}/state`) || {}).view?.handNo >= 2, 10000, 'two hands');
    host.stop();                                 // host closes the tab mid-game
    await host.promise;
    const saved = await room.hostNet.loadHostState(room.code);
    assert(saved && saved.table, 'host state was saved');
    const beforeHand = saved.table.handNo;
    // ...and opens it again
    const host2 = await startHost(room, saved);
    await finished(room);
    await host2.promise;
    const st = room.hub.peek(`rooms/${room.code}/state`);
    assert(st.view.handNo >= beforeHand, 'game continued from where it was');
    assert.strictEqual(chipsOf(room), 4 * 150, 'chips changed across the resume');
  });

  await test('a player who leaves is folded and sits out; the rest play on', async () => {
    const room = await setupRoom({ humans: ['ann', 'ben', 'cat'] });
    simPlayer(room, 'ann', { seed: 31 });
    simPlayer(room, 'ben', { seed: 32 });
    simPlayer(room, 'cat', { respond: false });
    const host = await startHost(room);
    await sleep(60);
    await room.nets.cat.sendAction(room.code, { seq: -1, type: 'leave' });
    await finished(room);
    const st = room.hub.peek(`rooms/${room.code}/state`);
    assert(st.winner === 'ann' || st.winner === 'ben', 'one of the remaining two wins');
    const cat = st.view.seats.find(s => s.id === 'cat');
    assert.strictEqual(cat.chips, 0, 'cat took their chips and left');
  });

  await test('when every human is out, the game ends and names the chip leader', async () => {
    const room = await setupRoom({ humans: ['ann'], bots: ['shark', 'fox'] });
    // A saved table where ann (the only human) is already out of chips and two bots remain
    const table = createTable({ sb: 10, seats: [
      newSeat({ id: 'ann', name: 'ann', chips: 0 }),
      newSeat({ id: 'bot-b0', name: 'Sophie', isBot: true, botKey: 'shark', chips: 100 }),
      newSeat({ id: 'bot-b1', name: 'Foxy', isBot: true, botKey: 'fox', chips: 200 }),
    ] });
    table.phase = 'hand-over';
    table.handNo = 3;
    await startHost(room, { table, seq: 5, left: [] });
    await finished(room);
    const st = room.hub.peek(`rooms/${room.code}/state`);
    assert.strictEqual(st.endReason, 'humans-out');
    assert.strictEqual(st.winner, 'bot-b1', 'the chip leader is named');
  });

  await test('a game that ends with one player holding everything says last-standing', async () => {
    const room = await setupRoom({ humans: ['ann', 'ben'] });
    const table = createTable({ sb: 10, seats: [
      newSeat({ id: 'ann', name: 'ann', chips: 300 }),
      newSeat({ id: 'ben', name: 'ben', chips: 0 }),
    ] });
    table.phase = 'hand-over';
    table.handNo = 9;
    await startHost(room, { table, seq: 1, left: [] });
    await finished(room);
    const st = room.hub.peek(`rooms/${room.code}/state`);
    // Random play can end two ways; whichever happened must be consistent with the final chips
    const withChips = st.view.seats.filter(s => s.chips > 0);
    if (st.endReason === 'last-standing') assert.strictEqual(withChips.length, 1, 'one player has everything');
    else {
      assert.strictEqual(st.endReason, 'humans-out');
      assert(withChips.every(s => s.isBot), 'only bots have chips left');
      assert.strictEqual(st.winner, withChips.sort((a, b) => b.chips - a.chips)[0].id, 'the chip leader is named');
    }
    assert.strictEqual(st.winner, 'ann');
  });

  await test('rising blinds step up with the hand number', async () => {
    const room = await setupRoom({ humans: ['ann', 'ben'], meta: { rising: true, handsPerLevel: 2, startChips: 5000 } });
    const seen = new Set();
    const record = st => seen.add(st.view.handNo + ':' + st.view.sb);   // every published state, not a sample
    simPlayer(room, 'ann', { seed: 40, passive: true, onState: record });
    simPlayer(room, 'ben', { seed: 41, passive: true });
    const host = await startHost(room);
    await until(() => [...seen].some(k => Number(k.split(':')[0]) >= 5), 15000, 'five hands');
    host.stop();
    assert(seen.has('1:10') && seen.has('2:10'), 'hands 1-2 at the starting blind: ' + [...seen]);
    assert(seen.has('3:15') && seen.has('4:15'), 'hands 3-4 at the next level: ' + [...seen]);
    assert(seen.has('5:25'), 'hand 5 at the level after: ' + [...seen]);
  });


  // ---------------------------------------------------------------- open tables
  const stateOf = room => room.hub.peek(`rooms/${room.code}/state`);
  const seatIds = room => ((stateOf(room) || {}).view || { seats: [] }).seats.map(x => x.id);
  async function addPlayer(room, uid, opts = {}) {
    room.nets[uid] = createRoomNet(room.hub.store(uid));
    await room.nets[uid].joinSeat(room.code, { name: uid, avatar: '😎', color: '#2f8f5b', joinedAt: Date.now() });
    return simPlayer(room, uid, opts);
  }
  const openMeta = { mode: 'open', status: 'playing', maxSeats: 4, startChips: 150 };

  await test('open table: waits alone, then people sit down mid-game, leave, and rebuy', async () => {
    const room = await setupRoom({ humans: ['ann'], meta: openMeta });
    simPlayer(room, 'ann', { seed: 61, passive: true });
    const host = await startHost(room);
    await until(() => (stateOf(room) || {}).status === 'waiting', 3000, 'a lone player to wait');
    assert.notStrictEqual(room.hub.peek(`rooms/${room.code}/meta/status`), 'finished', 'an open table never finishes');
    assert(room.hub.peek(`lobby/${room.code}`), 'the table is in the public list');
    // ben sits down: play starts
    await addPlayer(room, 'ben', { seed: 62, passive: true });
    await until(() => (stateOf(room) || {}).status === 'playing' && seatIds(room).includes('ben'), 5000, 'ben to be dealt in');
    // cat sits down while hands are being played
    await addPlayer(room, 'cat', { seed: 63, passive: true });
    await until(() => seatIds(room).includes('cat'), 5000, 'cat to appear at the table');
    // ben leaves
    await room.nets.ben.sendAction(room.code, { seq: -1, type: 'leave' });
    await room.nets.ben.leaveSeat(room.code);
    await until(() => !seatIds(room).includes('ben'), 5000, 'ben to leave');
    assert(seatIds(room).includes('ann') && seatIds(room).includes('cat'));
    host.stop();
  });

  await test('open table: a busted player can rebuy and is dealt back in', async () => {
    const room = await setupRoom({ humans: ['ann', 'ben'], meta: openMeta });
    const table = createTable({ sb: 10, seats: [newSeat({ id: 'ann', name: 'ann', chips: 300 }), newSeat({ id: 'ben', name: 'ben', chips: 0 })] });
    table.phase = 'hand-over'; table.handNo = 5;
    simPlayer(room, 'ann', { seed: 64, passive: true });
    simPlayer(room, 'ben', { seed: 65, passive: true });
    const host = await startHost(room, { table, seq: 1, left: [] });
    await until(() => (stateOf(room) || {}).status === 'waiting', 3000, 'waiting (only ann has chips)');
    await room.nets.ben.sendAction(room.code, { seq: -1, type: 'rebuy' });
    await until(() => (stateOf(room) || {}).status === 'playing', 5000, 'play to resume after the rebuy');
    const ben = stateOf(room).view.seats.find(x => x.id === 'ben');
    assert(ben.chips + ben.totalBet >= 100, 'ben has chips again: ' + JSON.stringify(ben));
    host.stop();
  });

  await test('open table: a full table turns extra players away', async () => {
    const room = await setupRoom({ humans: ['ann', 'ben'], meta: { ...openMeta, maxSeats: 3 } });
    simPlayer(room, 'ann', { seed: 66, passive: true });
    simPlayer(room, 'ben', { seed: 67, passive: true });
    const host = await startHost(room);
    await until(() => (stateOf(room) || {}).status === 'playing', 3000, 'play');
    await addPlayer(room, 'cat', { seed: 68, passive: true });
    await addPlayer(room, 'dan', { seed: 69, passive: true });   // the 4th player at a 3-seat table
    await until(() => seatIds(room).length === 3 && !room.hub.peek(`rooms/${room.code}/seats/dan`), 6000, 'the extra player to be turned away');
    assert(seatIds(room).includes('cat'), 'the first newcomer got the free seat');
    host.stop();
  });

  await test('open table: someone who stays disconnected is dropped from the table', async () => {
    const room = await setupRoom({ humans: ['ann', 'ben', 'cat'], meta: openMeta, timing: { awayMs: 500, absentGraceMs: 200 } });
    simPlayer(room, 'ann', { seed: 70, passive: true });
    simPlayer(room, 'ben', { seed: 71, passive: true });
    simPlayer(room, 'cat', { respond: false });
    const host = await startHost(room);
    await sleep(100);
    room.hub.disconnect('cat');
    await until(() => !seatIds(room).includes('cat') && !room.hub.peek(`rooms/${room.code}/seats/cat`), 8000, 'cat to be dropped');
    host.stop();
  });

  await test('dealing can be handed to another player: the saved table carries on', async () => {
    const room = await setupRoom({ humans: ['ann', 'ben', 'cat'], meta: openMeta });
    ['ann', 'ben', 'cat'].forEach((u, i) => simPlayer(room, u, { seed: 80 + i, passive: true }));
    const host1 = await startHost(room);
    await until(() => (stateOf(room) || {}).view?.handNo >= 2, 8000, 'two hands');
    host1.stop();
    await host1.promise;
    // ann is gone; ben takes over from what ann saved
    await room.nets.ann.updateMeta(room.code, { host: 'ben' });
    const saved = await room.nets.ben.loadHostState(room.code);
    const r = await room.nets.ben.getRoom(room.code);
    const handBefore = stateOf(room).view.handNo;
    const host2 = createRoomHost({ net: room.nets.ben, code: room.code, meta: r.meta, seats: r.seats, bots: r.bots, resume: saved, timing: room.timing });
    host2.promise = host2.run();
    await until(() => stateOf(room).view.handNo >= handBefore + 2, 8000, 'the new dealer to keep dealing');
    assert.strictEqual(room.hub.peek(`lobby/${room.code}`).host, 'ben', 'the public list now names the new host');
    host2.stop();
  });

  await test('the public list hides stale tables, and quickJoin picks the fullest table with room (or makes one)', async () => {
    const hub = createMemoryHub();
    const net = createRoomNet(hub.store('zed'));
    const now = Date.now();
    await net.publishLobby('AAAAA', { code: 'AAAAA', mode: 'open', seats: 2, max: 6, beat: now });
    await net.publishLobby('BBBBB', { code: 'BBBBB', mode: 'open', seats: 4, max: 6, beat: now });
    await net.publishLobby('CCCCC', { code: 'CCCCC', mode: 'open', seats: 6, max: 6, beat: now });      // full
    await net.publishLobby('DDDDD', { code: 'DDDDD', mode: 'open', seats: 5, max: 6, beat: now - 120000 }); // stale
    assert.deepStrictEqual(liveTables(await net.getLobby(), now).map(e => e.code), ['CCCCC', 'BBBBB', 'AAAAA']);
    assert.strictEqual(await quickJoin(net, 'open', 'Zed'), 'BBBBB', 'fullest table that still has a free seat');
    await net.removeLobby('BBBBB'); await net.removeLobby('AAAAA');
    const code = await quickJoin(net, 'open', 'Zed');          // only a full table left: make a new one
    const made = await net.getRoom(code);
    assert.strictEqual(made.meta.mode, 'open');
    assert.strictEqual(made.meta.host, 'zed');
    assert.strictEqual(made.meta.status, 'playing');
    const arenaCode = await quickJoin(net, 'arena', 'Zed');
    const a = await net.getRoom(arenaCode);
    assert.strictEqual(a.meta.mode, 'arena');
    assert.strictEqual(a.meta.arena, arenaWindow().id);
    assert(a.meta.arenaEnd > Date.now());
  });

  // ---------------------------------------------------------------- arena
  await test('arena ratings: finished arenas are totalled once, recent ones wait, and points are added to the rating', async () => {
    const hub = createMemoryHub();
    const me = createRoomNet(hub.store('me'));
    const other = createRoomNet(hub.store('other'));
    const score = (points, rounds) => ({ name: 'x', points, rounds, wins: 0 });
    // Arena 1 (long ago): I won, 3 qualified players -> 3 points. Arena 2: I was 3rd of 4 -> 1 point.
    // Arena 3: only two qualified players -> counted but 0 points. Arena 4: just finished (too recent). Arena 5: I never played.
    await other.publishArenaTable('20260101-1000', 'T1', { host: 'h', updated: 1, scores: { me: score(30, 3), p2: score(20, 3), p3: score(10, 3) } });
    await other.publishArenaTable('20260101-1030', 'T1', { host: 'h', updated: 1, scores: { a: score(30, 3), b: score(20, 3), me: score(10, 3), d: score(4, 3) } });
    await other.publishArenaTable('20260101-1100', 'T1', { host: 'h', updated: 1, scores: { me: score(30, 3), b: score(20, 3) } });
    await other.publishArenaTable('20260101-1130', 'T1', { host: 'h', updated: 1, scores: { me: score(30, 3), b: score(20, 3), c: score(10, 3) } });
    for (const id of ['20260101-1000', '20260101-1030', '20260101-1100', '20260101-1130']) await me.markArenaPlayed(id);
    const profile = { points: 100, arenaPoints: 0, arenas: 0, arenaBest: 0, arenaDone: '', arenaLog: [] };
    const now = arenaEndOf('20260101-1130') + 60000;          // 1 minute after the last one ended: not settled yet
    assert.strictEqual(await settleArenaRatings(me, 'me', profile, now), true);
    assert.deepStrictEqual({ p: profile.points, ap: profile.arenaPoints, n: profile.arenas, best: profile.arenaBest, done: profile.arenaDone },
      { p: 104, ap: 4, n: 3, best: 1, done: '20260101-1100' });   // the 11:30 arena is still too recent
    assert.deepStrictEqual(profile.arenaLog.map(l => [l.id, l.rank, l.of, l.points]),
      [['20260101-1100', 1, 2, 0], ['20260101-1030', 3, 4, 1], ['20260101-1000', 1, 3, 3]]);
    // Running it again changes nothing (each Arena counts once)
    assert.strictEqual(await settleArenaRatings(me, 'me', profile, now), false);
    // Later, the last arena is final and gets counted: 1st of 3 -> 3 points
    assert.strictEqual(await settleArenaRatings(me, 'me', profile, now + 10 * 60000), true);
    assert.strictEqual(profile.points, 107);
    assert.strictEqual(profile.arenaDone, '20260101-1130');
  });

  await test('arena: rounds are scored, points add up, and the arena ends at its end time', async () => {
    const room = await setupRoom({ humans: ['ann', 'ben', 'cat'], meta: { mode: 'arena', status: 'playing', arena: 'T-1', roundHands: 3, startChips: 1000, maxSeats: 6, arenaEnd: Date.now() + 6000 }, timing: { roundPauseMs: 0 } });
    ['ann', 'ben', 'cat'].forEach((u, i) => simPlayer(room, u, { seed: 90 + i }));
    const rounds = new Map();
    room.nets.ann.watchRoom(room.code, r => { const rr = r && r.state && r.state.roundResult; if (rr) rounds.set(rr.n, rr); });
    const host = await startHost(room);
    await finished(room);
    await host.promise;
    const st = stateOf(room);
    assert.strictEqual(st.endReason, 'arena-over');
    assert(rounds.size >= 2, 'at least two rounds were played: ' + rounds.size);
    // each round's points follow the rules, and the published table scores are the sum of them
    const expected = {};
    rounds.forEach(rr => {
      assert.strictEqual(rr.rows.length, 3);
      rr.rows.forEach(row => { expected[row.id] = (expected[row.id] || 0) + row.points; assert.strictEqual(row.points, arenaPoints(row.rank, 3)); });
      assert.strictEqual(rr.rows.filter(row => row.rank === 1).length >= 1, true);
    });
    const published = room.hub.peek(`arenas/T-1/tables/${room.code}`).scores;
    ['ann', 'ben', 'cat'].forEach(u => {
      assert(published[u].rounds >= rounds.size, u + ' rounds');
      assert(published[u].points >= expected[u], u + ' points');
    });
    const standings = aggregateArena(room.hub.peek('arenas/T-1/tables'));
    assert.strictEqual(standings.length, 3);
    assert(!room.hub.peek(`lobby/${room.code}`), 'the table left the public list when the arena ended');
  });

  await test('arena: a late arrival waits for the next round, then plays', async () => {
    const room = await setupRoom({ humans: ['ann', 'ben'], meta: { mode: 'arena', status: 'playing', arena: 'T-2', roundHands: 4, startChips: 1000, maxSeats: 6, arenaEnd: Date.now() + 60000 }, timing: { roundPauseMs: 0 } });
    ['ann', 'ben'].forEach((u, i) => simPlayer(room, u, { seed: 95 + i, passive: true }));
    const host = await startHost(room);
    await until(() => (stateOf(room) || {}).round, 3000, 'round 1');
    await addPlayer(room, 'cat', { seed: 97, passive: true });
    await until(() => seatIds(room).includes('cat'), 4000, 'cat to appear');
    // cat appears in the middle of round 1, so is waiting (no chips in this round)
    const waitingSeen = stateOf(room).view.seats.find(x => x.id === 'cat');
    assert.strictEqual(waitingSeen.waiting, true, 'cat waits for the next round');
    await until(() => { const rr = stateOf(room).roundResult; return rr && rr.rows.some(row => row.id === 'cat'); }, 15000, 'cat to be scored in a later round');
    host.stop();
  });

  console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}`);
  setTimeout(() => process.exit(process.exitCode || 0), 100);
})();
