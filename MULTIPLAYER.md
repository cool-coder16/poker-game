# Online play: how it works (and how to change it later)

Three ways to play with other people. All chips are play money, and all of it is **free**: it uses
Firebase's Realtime Database on the free plan, and **one player's browser acts as the dealer** for each table.

| | What it is | Bots |
|---|---|---|
| **Private room** (`rooms.html`) | Make a room, share a 5-letter code. A lobby, then a freezeout: no rebuys, last player with chips wins. | The host can add them |
| **Open table** (`tables.html`) | A public table anyone can join. Sit down or leave any time, rebuy if you bust, plays on while 2+ people are there. | No |
| **Arena** (`arena.html`) | A 30-minute window every :00 and :30 UTC. Tables play 10-hand rounds with equal stacks; your place in each round earns points; standings add up across all tables. | No |

## The layers

```
rooms.html, tables.html,        the pages
  arena.html, room.html
  room-client.js, rooms.js,     what you see and click
  tables.js, arena-page.js
  room-view.js                  turns the published table into what table-ui.js draws (pure, tested)
  table-ui.js                   draws the table (shared with the single-player game)

room-host.js                    the DEALER: runs a table, waits for moves, publishes the state
  engine.js                     the poker rules as a pure state machine (no screen, no network, tested)
  arena.js                      the Arena rules: windows, points, standings (pure, tested)
  bots.js                       bot decisions

room-net.js                     every room operation (create, join, publish, public list, arena scores...)
  store-firebase.js             the "store" for the real Realtime Database      <- swap this...
  store-memory.js               a fake in-memory store (tests, and room.html?local)
```

Only `room-net.js` knows what the data looks like, and only a *store* knows which database it is.
The engine and the dealer know about neither.

## The dealer can change hands

The dealer saves its whole table to `roomHost/<code>` after every move (readable only by the current dealer).
So when the dealer leaves, or disappears, another player can carry on from that saved table:
- **Leaving politely:** the dealer hands the job to a connected player (`setHost`).
- **Vanishing:** after about 12 seconds a seated player claims the job. The database rules only allow that
  when the dealer's presence is really gone (`meta/host` rule in `database.rules.json`).
- A refreshed dealer simply resumes. If a dealer who lost the job is still running, it stops itself.

## Public list and Arena scores

- `lobby/<code>`: one line per open/arena table, refreshed by the dealer every ~20 seconds. Lines older than
  a minute are hidden (the dealer is gone).
- `arenas/<window id>/tables/<code>`: each arena table's own running scores. The Arena page adds them up
  (`aggregateArena` in `arena.js`).

## Arena results and your rating

- When you sit down at an arena table, the room page marks that Arena as played (`arenaPlayed/<uid>/<id>`,
  readable only by you).
- After an Arena ends (plus a 5-minute grace period), the next time you open the site `arena-rating.js` totals
  that Arena's standings, works out your place (`arenaResult` in `arena.js`) and adds the points to your
  profile and rating. Each Arena is counted once (`profile.arenaDone`).
- Top 3 earn 3 / 2 / 1 rating points, but only if you played at least 2 rounds and at least 3 players did.
- Like the weekly season, this is worked out in your own browser: honor system until a server does it.

## Changing the backend later

- **Different database, same idea:** write a new store file with the small interface in `store-memory.js`
  (`get`, `set`, `update`, `remove`, `create`, `watch`, `keepPresent`). Nothing else changes.
- **A real server that deals the cards** (cheat-proof; also the right place for scheduled tournaments):
  run `createRoomHost(...)` from `room-host.js` on the server instead of in a player's browser. It needs
  `poker.js`, `engine.js`, `bots.js`, `arena.js` and `room-net.js` (plain scripts with no browser code; the
  tests load them in Node). Players' pages stay the same.

## Honest limits of the free version

- **The dealer's browser does the shuffling**, so its owner could peek, and could in principle report false
  Arena scores. Other players cannot see your cards: they are stored where only you (and the dealer) can
  read them (`roomPrivate/`). Arena standings run on the honor system until a server deals.
- If the dealer vanishes and nobody else is at the table, the table is gone.
- The free database allows about 100 players connected at once. Plenty for friends.
- Not built yet: spectators, chat, bots at open/arena tables.

## Security rules

`database.rules.json` is the copy of the rules published in the Firebase console
(Realtime Database -> Rules). Keep them in sync if you edit either one. Key ideas: only the dealer can write the
table, the public list line and the Arena scores for its room; each player can only write their own move and
presence; private cards are readable only by their owner; rooms are only readable by signed-in people who know
the code; a seated player may take over a dealer who is truly disconnected.

## Tests (no network needed)

```
node tests/engine.test.js     the poker rules (13 tests, including 3,000 random hands)
node tests/arena.test.js      the Arena rules (windows, points, ties, standings, rating points)
node tests/room.test.js       whole tables on the in-memory store (19 tests: privacy, timeouts, disconnects,
                              dealer handoff, open tables, rebuys, arena rounds, arena ratings, the public list)
```

Try the table UI with no network or friends:
`room.html?local` (private room), `room.html?local=open` (open table), `room.html?local=arena&rounds=3` (Arena,
with 3-hand rounds so you see scoring quickly). Each has two bots for company.
