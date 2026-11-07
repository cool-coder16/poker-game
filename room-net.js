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

function createRoomNet(store) {
  const room = code => `rooms/${code}`;

  return {
    uid: store.uid,

    // Make a new room. Tries new codes until one is free; returns the code.
    async createRoom(meta) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const code = makeRoomCode();
        const fullMeta = { ...meta, host: store.uid, status: 'lobby', createdAt: Date.now() };
        if (await store.create(`${room(code)}/meta`, fullMeta)) return code;
      }
      throw new Error('Could not find a free room code. Try again.');
    },

    async getRoom(code) { return store.get(room(code)); },
    watchRoom(code, cb) { return store.watch(room(code), cb); },   // cb(everything public about the room)

    updateMeta: (code, patch) => store.update(`${room(code)}/meta`, patch),
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
    sendAction: (code, action) => store.set(`roomActions/${code}/${store.uid}`, { ...action, n: Date.now() + Math.random() }),

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
