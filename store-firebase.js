// store-firebase.js — the real database: Firebase Realtime Database behind the small "store"
// interface (see store-memory.js for what each method means). This is the ONLY file that talks to
// the Realtime Database. To use a different backend later, write another store like this one.
//
// auth.js (the file that talks to Firebase Auth) loads first and starts the Firebase app; we reuse it.
import { getApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  getDatabase, ref, get, set, update, remove, onValue, onDisconnect, runTransaction,
  push, serverTimestamp, query, limitToLast,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js';

const app = getApp();
const auth = getAuth(app);

// Is the Realtime Database set up? (firebase-config.js needs a databaseURL.) If not, pages say so nicely.
const configured = Boolean(firebaseConfig.databaseURL);
const db = configured ? getDatabase(app) : null;

// The database rejects `undefined`, so send plain JSON (this drops undefined fields)
const plain = v => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

function makeStore(uid) {
  const at = path => ref(db, path);
  return {
    uid,
    async get(path) { return (await get(at(path))).val(); },
    set: (path, value) => set(at(path), plain(value)),
    update: (path, patch) => update(at(path), plain(patch)),
    remove: path => remove(at(path)),
    // Write only if nothing is there yet (a "transaction"); true if we wrote it
    async create(path, value) {
      const result = await runTransaction(at(path), current => (current === null ? plain(value) : undefined));
      return result.committed;
    },
    watch(path, cb) { return onValue(at(path), snap => cb(snap.val())); },
    // Mark this path as "here", and un-mark it if the connection drops. Done again after every
    // reconnect, because the server forgets our "on disconnect" instructions when the connection ends.
    async keepPresent(path, value = true) {
      const r = at(path);
      onValue(ref(db, '.info/connected'), snap => {
        if (snap.val() === true) onDisconnect(r).remove().then(() => set(r, plain(value)));
      });
    },
    // Several writes in one go (paths are from the top of the database): all of them happen, or none
    multiSet: updates => update(ref(db), plain(updates)),
    newKey: path => push(ref(db, path)).key,     // a unique id that sorts by creation time
    serverTime: () => serverTimestamp(),         // becomes the server's clock when written
    // The last `limit` children of a path as [{ id, ...fields }], oldest first, kept up to date
    watchList(path, limit, cb) {
      return onValue(query(at(path), limitToLast(limit)), snap => {
        const list = [];
        snap.forEach(child => { list.push({ id: child.key, ...child.val() }); });
        cb(list);
      });
    },
  };
}

// Pages call window.pokerRooms.makeNet() once someone is signed in
window.pokerRooms = {
  configured,
  makeNet() {
    if (!configured) throw new Error('The online database is not set up yet.');
    if (!auth.currentUser) throw new Error('Sign in first.');
    return createRoomNet(makeStore(auth.currentUser.uid));   // createRoomNet is in room-net.js (a plain script)
  },
};
window.dispatchEvent(new Event('pokerrooms-ready'));
