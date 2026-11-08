// store-memory.js — a fake database that lives in memory. Used by the tests, and by room.html?local
// (a demo mode that runs a whole room inside one browser tab with no network).
//
// It copies the real database's habits on purpose, so bugs show up here instead of online:
//   - every value goes through JSON (functions and undefined disappear),
//   - empty arrays and nulls are not stored (reading them back gives nothing),
//   - watchers are called asynchronously, never in the middle of a write.
//
// The "store" interface (the only thing room-net.js knows about the database):
//   get(path) -> Promise<value|null>          set(path, value)       update(path, patch)
//   remove(path)                              create(path, value) -> Promise<boolean>  (only if empty)
//   watch(path, cb) -> unsubscribe            (cb gets the value at path now, and after every change under it)
//   keepPresent(path, value = true)           (set path now, and remove it if this user's connection drops)
//   multiSet({ path: value, ... })            (several writes at once: all happen or none do)
//   newKey(path)                              (a new unique child name that sorts by time, like a message id)
//   serverTime()                              (a value that means "the server's clock" when written)
//   watchList(path, limit, cb)                (cb gets the last `limit` children as [{ id, ...fields }], oldest first)
// A path looks like "rooms/ABCDE/state".

function createMemoryHub() {
  let root = {};
  const watchers = new Set();
  const dropOnDisconnect = new Map();   // uid -> [paths]
  let keyCounter = 0;

  // Mimic what the real database keeps: no nulls, no empty arrays/objects
  const prune = v => {
    if (Array.isArray(v)) {
      const out = v.map(prune);
      return out.length ? out : undefined;
    }
    if (v && typeof v === 'object') {
      const out = {};
      Object.keys(v).forEach(k => { const p = prune(v[k]); if (p !== undefined && p !== null) out[k] = p; });
      return Object.keys(out).length ? out : undefined;
    }
    return v === null ? undefined : v;
  };
  const clone = v => (v === undefined || v === null ? null : prune(JSON.parse(JSON.stringify(v))) ?? null);

  const parts = path => path.split('/').filter(Boolean);
  const getAt = path => parts(path).reduce((node, k) => (node && typeof node === 'object' ? node[k] : undefined), root);

  function setAt(path, value) {
    const keys = parts(path);
    if (keys.length === 0) { root = value ?? {}; return; }
    let node = root;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!node[keys[i]] || typeof node[keys[i]] !== 'object') node[keys[i]] = {};
      node = node[keys[i]];
    }
    const last = keys[keys.length - 1];
    if (value === null || value === undefined) delete node[last]; else node[last] = value;
    root = prune(root) || {};   // tidy up empty parents
  }

  // Tell every watcher whose path overlaps the one that changed
  function notify(changed) {
    const c = parts(changed).join('/');
    watchers.forEach(w => {
      const p = parts(w.path).join('/');
      if (c.startsWith(p) || p.startsWith(c)) {
        const snapshot = clone(getAt(w.path));
        Promise.resolve().then(() => { if (watchers.has(w)) w.cb(snapshot); });
      }
    });
  }

  function storeFor(uid) {
    return {
      uid,
      async get(path) { return clone(getAt(path)); },
      async set(path, value) { setAt(path, clone(value)); notify(path); },
      async update(path, patch) {
        const cur = getAt(path) || {};
        setAt(path, { ...cur, ...clone(patch) });
        notify(path);
      },
      async remove(path) { setAt(path, null); notify(path); },
      async create(path, value) {
        if (getAt(path) != null) return false;
        setAt(path, clone(value)); notify(path);
        return true;
      },
      watch(path, cb) {
        const w = { path, cb };
        watchers.add(w);
        const snapshot = clone(getAt(path));
        Promise.resolve().then(() => { if (watchers.has(w)) cb(snapshot); });
        return () => watchers.delete(w);
      },
      async keepPresent(path, value = true) {
        if (!dropOnDisconnect.has(uid)) dropOnDisconnect.set(uid, []);
        dropOnDisconnect.get(uid).push(path);
        setAt(path, clone(value)); notify(path);
      },
      async multiSet(updates) {
        Object.entries(updates).forEach(([path, value]) => setAt(path, clone(value)));
        Object.keys(updates).forEach(notify);
      },
      newKey() {   // 9 digits of time + a counter, so keys sort in the order they were made
        return Date.now().toString(36).padStart(9, '0') + (++keyCounter).toString(36).padStart(4, '0');
      },
      serverTime: () => Date.now(),
      watchList(path, limit, cb) {
        return this.watch(path, all => {
          cb(Object.entries(all || {}).sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-limit).map(([id, v]) => ({ id, ...v })));
        });
      },
    };
  }

  return {
    store: storeFor,
    // Pretend this user closed their tab: run their "on disconnect" removals
    disconnect(uid) {
      (dropOnDisconnect.get(uid) || []).forEach(path => { setAt(path, null); notify(path); });
      dropOnDisconnect.delete(uid);
    },
    // For tests: peek at the raw data
    peek: path => clone(getAt(path)),
  };
}
