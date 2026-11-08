// room-net.js — everything an online room needs from the network, built on the small "store"
// interface (see store-memory.js). The game code (room-host.js, room-client.js) only talks to THIS,
// so moving to a different backend later means changing this file and the store, not the game.
//
// Where things live (paths in the store):
//   rooms/<code>/meta        who the host is, status (lobby | playing | finished) and the room's options
//   rooms/<code>/seats/<uid> a human who joined          rooms/<code>/bots/<id>   a bot the host added
//   rooms/<code>/state       the public table, written by the host after every action
//   rooms/<code>/presence/<uid>  exists while that player is connected
//   roomPrivate/<code>/<uid> that player's hole cards (only they and the host can read it)
//   roomActions/<code>/<uid> that player's latest move (only the host reads it)
//   roomHost/<code>          the host's saved table, so a refreshed host can carry on (host only)
//   lobby/<code>             the public list of open and arena tables (the host refreshes it every ~20s)
//   arenas/<id>/tables/<code>  one arena table's running scores (the host writes them)
//   tourneys/<code>/results  a finished tournament's final places (the host writes them)
//   tourneyPlayed/<uid>/<code>  tournaments this player sat down in (only they can read or write it)
//   arenaPlayed/<uid>/<id>   Arenas this player sat down in (only they can read or write it): so the site knows which to total up

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O or 1/I: easy to read out loud

// Strong randomness (the browser and Node both have crypto.getRandomValues)
function secureRandom() {
  return crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;
}

function makeRoomCode(length = 5) {
  let code = '';
  for (let i = 0; i < length; i++) code += ROOM_CODE_CHARS[Math.floor(secureRandom() * ROOM_CODE_CHARS.length)];
  return code;
}

const normalizeCode = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// ---------- Public tables (open tables and the arena) ----------
const TABLE_STALE_MS = 60000;   // a table whose host hasn't refreshed its line for this long is considered gone

// The open tables worth showing right now, fullest first (so new players fill tables up before starting new ones)
function liveTables(all, now = Date.now()) {
  return Object.values(all || {})
    .filter(e => e && now - (e.beat || 0) < TABLE_STALE_MS)
    .sort((a, b) => (b.seats || 0) - (a.seats || 0));
}

// The options for a new open table or arena table (kind is 'open' or 'arena'). Needs arena.js for arena tables.
function tableMeta(kind, hostName, extra = {}) {
  const base = { hostName, status: 'playing', startChips: 1000, sb: 10, turnSeconds: 30, maxSeats: 6, allowBots: false, rising: false, handsPerLevel: 10 };
  if (kind === 'arena') {
    const w = arenaWindow();
    return { ...base, mode: 'arena', arena: w.id, arenaEnd: w.end, roundHands: ARENA_ROUND_HANDS, fillBots: true, ...extra };   // bots keep a lone player company
  }
  return { ...base, mode: 'open', ...extra };
}

// The options for a tournament (needs tournament.js). kind is 'sng' (starts when full) or 'scheduled' (starts at `startAt`).
function tournamentMeta(kind, hostName, extra = {}) {
  const base = {
    hostName, status: 'lobby', mode: 'freezeout', kind, startChips: TOURNEY_START_CHIPS, sb: TOURNEY_SB, turnSeconds: 30,
    rising: true, handsPerLevel: TOURNEY_HANDS_PER_LEVEL, allowBots: false,
  };
  if (kind === 'scheduled') return { ...base, size: TOURNEY_MAX_PLAYERS, maxSeats: TOURNEY_MAX_PLAYERS, minPlayers: TOURNEY_MIN_PLAYERS, ...extra };
  const size = extra.size || 4;
  return { ...base, size, maxSeats: size, ...extra };
}

// "Register" for the scheduled tournament starting at startMs: make its room if nobody has yet. Returns the room code.
async function registerScheduled(net, startMs, hostName) {
  const code = tourneyCode(startMs);
  await net.createRoomWithCode(code, tournamentMeta('scheduled', hostName, { startAt: startMs }));   // false if it already exists: fine
  return code;
}

// "Play now" for Sit & Go: join the fullest one that has room, or start a new one
async function quickSitAndGo(net, hostName) {
  const open = liveTables(await net.getLobby())
    .filter(e => e.kind === 'sng' && e.status === 'lobby' && (e.seats || 0) < (e.max || 4));
  return open.length ? open[0].code : net.createRoom(tournamentMeta('sng', hostName));
}

// "Play now": join the fullest table that has a free seat, or start a new one (you become its dealer). Returns the room code.
async function quickJoin(net, kind, hostName) {
  const wanted = kind === 'arena' ? arenaWindow().id : null;
  const open = liveTables(await net.getLobby())
    .filter(e => e.mode === kind && (e.seats || 0) < (e.max || 6) && (!wanted || e.arena === wanted));
  return open.length ? open[0].code : net.createRoom(tableMeta(kind, hostName));
}

// The line in the public list for a table or tournament. `humans`/`bots` are counts; `max` is the table size.
function makeListing({ code, meta, hostName, humans, bots = 0, sb, max, status }) {
  const kind = meta.kind || null;
  return {
    code, mode: meta.mode || 'freezeout', kind, status: status || meta.status || 'playing',
    host: meta.host, hostName: hostName || meta.hostName, name: meta.name || '',
    sb, startChips: meta.startChips, seats: humans + (kind ? bots : 0), bots, max,
    arena: meta.arena || null, arenaEnd: meta.arenaEnd || null, startAt: meta.startAt || null,
    beat: Date.now(),
  };
}

function createRoomNet(store) {
  const room = code => `rooms/${code}`;
  let actionCounter = 0;

  return {
    uid: store.uid,

    // Make a room with a code everyone already knows (scheduled tournaments). Returns true if we created it,
    // false if someone else already had.
    async createRoomWithCode(code, meta) {
      return store.create(`${room(code)}/meta`, { status: 'lobby', ...meta, host: store.uid, createdAt: Date.now() });
    },

    // Make a new room. Tries new codes until one is free; returns the code.
    async createRoom(meta) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const code = makeRoomCode();
        const fullMeta = { status: 'lobby', ...meta, host: store.uid, createdAt: Date.now() };   // open tables start as 'playing'
        if (await store.create(`${room(code)}/meta`, fullMeta)) return code;
      }
      throw new Error('Could not find a free room code. Try again.');
    },

    async getRoom(code) { return store.get(room(code)); },
    watchRoom(code, cb) { return store.watch(room(code), cb); },   // cb(everything public about the room)

    updateMeta: (code, patch) => store.update(`${room(code)}/meta`, patch),
    // Hand the dealing to someone, or take it when the dealer has gone (the rules decide whether it's allowed)
    setHost: (code, uid) => store.set(`${room(code)}/meta/host`, uid),
    joinSeat: (code, info) => store.set(`${room(code)}/seats/${store.uid}`, info),
    leaveSeat: (code, uid = store.uid) => store.remove(`${room(code)}/seats/${uid}`),
    setBots: (code, bots) => (Object.keys(bots).length ? store.set(`${room(code)}/bots`, bots) : store.remove(`${room(code)}/bots`)),

    // I am here (and, if my connection drops, I am not)
    announcePresence: code => store.keepPresent(`${room(code)}/presence/${store.uid}`),

    // Host side
    publishState: (code, state) => store.set(`${room(code)}/state`, state),
    publishPrivate: (code, uid, data) => store.set(`roomPrivate/${code}/${uid}`, data),
    saveHostState: (code, data) => store.set(`roomHost/${code}`, data),
    loadHostState: code => store.get(`roomHost/${code}`),

    // The host hears about every new move. cb(uid, action). Each move carries a unique `n`, so
    // the same move is never delivered twice even if the database reports the same value again.
    watchActions(code, cb) {
      const seen = {};
      return store.watch(`roomActions/${code}`, all => {
        Object.entries(all || {}).forEach(([uid, a]) => {
          if (a && seen[uid] !== a.n) { seen[uid] = a.n; cb(uid, a); }
        });
      });
    },

    // Player side
    watchPrivate: (code, cb) => store.watch(`roomPrivate/${code}/${store.uid}`, cb),
    // Every move carries a tag `n` that is never reused (a counter plus randomness, as text), so the dealer can tell a
    // new move from the same one reported twice. (A number like Date.now() + Math.random() is NOT safe: it is too
    // big to keep much of the fraction, so two quick moves in the same millisecond could get the same tag.)
    sendAction(code, action) {
      const n = `${Date.now()}-${++actionCounter}-${Math.random().toString(36).slice(2, 8)}`;
      return store.set(`roomActions/${code}/${store.uid}`, { ...action, n });
    },

    // Public list of open tables. Each entry carries `beat` (when the host last refreshed it); stale ones are hidden.
    publishLobby: (code, entry) => store.set(`lobby/${code}`, entry),
    removeLobby: code => store.remove(`lobby/${code}`),
    watchLobby: cb => store.watch('lobby', all => cb(all || {})),
    getLobby: () => store.get('lobby'),

    // Tournaments: the host publishes final places; players mark the ones they sat in, and the site counts them later
    publishTourneyResults: (code, data) => store.set(`tourneys/${code}/results`, data),
    getTourney: code => store.get(`tourneys/${code}/results`),
    markTourneyPlayed: code => store.set(`tourneyPlayed/${store.uid}/${code}`, Date.now()),
    getTourneyPlayed: () => store.get(`tourneyPlayed/${store.uid}`),

    // Arena scores: every table publishes its own, and the standings add them up (see arena.js)
    publishArenaTable: (arenaId, code, data) => store.set(`arenas/${arenaId}/tables/${code}`, data),
    markArenaPlayed: arenaId => store.set(`arenaPlayed/${store.uid}/${arenaId}`, true),
    getArenaPlayed: () => store.get(`arenaPlayed/${store.uid}`),
    getArena: arenaId => store.get(`arenas/${arenaId}/tables`),
    watchArena: (arenaId, cb) => store.watch(`arenas/${arenaId}/tables`, all => cb(all || {})),

    // After a game: back to the lobby, with the old table thrown away (host only)
    async resetRoom(code) {
      await Promise.all([`${room(code)}/state`, `roomHost/${code}`, `roomActions/${code}`].map(p => store.remove(p)));
      await store.update(`${room(code)}/meta`, { status: 'lobby' });
    },

    async deleteRoom(code) {
      await Promise.all([room(code), `roomPrivate/${code}`, `roomActions/${code}`, `roomHost/${code}`].map(p => store.remove(p)));
    },
  };
}
