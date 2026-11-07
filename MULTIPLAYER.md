# Online rooms: how it works (and how to change it later)

Players make a room, share a 5-letter code, and play. Chips are play money. This first version is
**free**: it uses Firebase's Realtime Database on the free plan, and **the host's browser acts as the dealer**.

## The layers

```
room.html / rooms.html          the pages
  room-client.js, rooms.js      what you see and click
  room-view.js                  turns the published table into what table-ui.js draws (pure, tested)
  table-ui.js                   draws the table (shared with the single-player game)

room-host.js                    the DEALER: runs a game, waits for moves, publishes the table
  engine.js                     the poker rules as a pure state machine (no screen, no network, tested)
  bots.js                       bot decisions

room-net.js                     every room operation (create, join, publish, send a move...)
  store-firebase.js             the "store" for the real Realtime Database      <- swap this...
  store-memory.js               a fake in-memory store (tests, and room.html?local)
```

Only `room-net.js` knows what the rooms look like in the database, and only a *store* knows which
database it is. The engine and the host don't know about either.

## Changing the backend later

- **Different database, same idea** (e.g. another realtime service): write a new store file with the same
  small interface as `store-memory.js` (`get`, `set`, `update`, `remove`, `create`, `watch`, `keepPresent`).
  Nothing else changes.
- **A real server that deals the cards** (cheat-proof, and runs scheduled tournaments): run
  `createRoomHost(...)` from `room-host.js` on the server instead of in the host's browser. It needs
  `poker.js`, `engine.js`, `bots.js` and `room-net.js` (they are plain scripts with no browser code in
  them, and the tests load them in Node). Players' pages stay the same.

## Honest limits of the free version

- **The host's browser does the shuffling**, so a host could peek at cards. Fine for friends, not for
  anything competitive. Other players cannot see your cards: they are stored where only you (and the
  host) can read them (`roomPrivate/`, see `database.rules.json`).
- **If the host closes the tab**, the game pauses. Opening the room again as host resumes it
  (the host saves its table to `roomHost/<code>`, readable only by the host).
- Free-plan limits (about 100 players connected at once) are plenty for friends.
- No spectators, chat or rebuys yet.

## Security rules

`database.rules.json` is the copy of the rules published in the Firebase console
(Realtime Database -> Rules). Keep them in sync if you edit either one. The key ideas: only the host can
write the table; each player can only write their own move and presence; private cards are readable
only by their owner; rooms are only readable by signed-in people who know the code.

## Tests (no network needed)

```
node tests/engine.test.js     the poker rules (12 tests, including 3,000 random hands)
node tests/room.test.js       whole rooms on the in-memory store (10 tests: privacy, timeouts,
                              disconnects, host refresh, game over, rising blinds)
```

`room.html?local` opens a one-tab demo room with two bots, handy for trying the table UI.
