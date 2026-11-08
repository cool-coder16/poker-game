# Online play: how it works (and how to change it later)

Three ways to play with other people. All chips are play money, and all of it is **free**: it uses
Firebase's Realtime Database on the free plan, and **one player's browser acts as the dealer** for each table.

| | What it is | Bots |
|---|---|---|
| **Private room** (`rooms.html`) | Make a room, share a 5-letter code. A lobby, then a freezeout: no rebuys, last player with chips wins. | The host can add them |
| **Open table** (`tables.html`) | A public table anyone can join. Sit down or leave any time, rebuy if you bust, plays on while 2+ people are there. | No |
| **Arena** (`arena.html`) | A 30-minute window every :00 and :30 UTC. Tables play 10-hand rounds with equal stacks; your place in each round earns points; standings add up across all tables. | Fill empty seats up to 3 players; never score |
| **Tournaments** (`tournaments.html`) | **Sit & Go**: starts when the table is full. **Scheduled**: one every 2 hours (even UTC hours), register in the hour before; runs if 3+ people are there. Single-table freezeouts with rising blinds. | Optional for Sit & Go; never earn points |

## The layers

```
rooms.html, tables.html,        the pages
  arena.html, room.html
  room-client.js, rooms.js,     what you see and click
  tables.js, arena-page.js, tournaments.js
  room-view.js                  turns the published table into what table-ui.js draws (pure, tested)
  table-ui.js                   draws the table (shared with the single-player game)

room-host.js                    the DEALER: runs a table, waits for moves, publishes the state
  engine.js                     the poker rules as a pure state machine (no screen, no network, tested)
  chat.js                       chat rules: cleaning text, cooldown, who may talk (pure, tested)
  arena.js                      the Arena rules: windows, points, standings (pure, tested)
  tournament.js                 tournament rules: schedule, points, places, when to start (pure, tested)
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
  when the dealer's presence is really gone (`meta/host` rule in `database.rules.json`). This works in a lobby
  (private rooms and tournaments) as well as in a running game.
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

## Tournaments

- **Sit & Go** (`kind: 'sng'`): a freezeout room that is also listed publicly while it gathers players. The dealer's
  page starts it the moment the table is full (`tourneyAction` in `tournament.js`).
- **Scheduled** (`kind: 'scheduled'`): the room code is the same for everyone (`tourneyCode`, like `TN2026110714`),
  so "Register" just creates that room if nobody has yet, and sits you down in it. At the start time the dealer
  removes people who registered and left, then starts if at least 3 are there, or cancels.
- Both use rising blinds (every 5 hands). The dealer records the order players are knocked out
  (`finalPlaces`, `knockoutOrder`) and, for a tournament, publishes `tourneys/<code>/results`.
- **Rating:** sitting down marks the tournament (`tourneyPlayed/<uid>/<code>`); the next time you open the site
  `tourney-rating.js` reads the results and adds 5 / 3 / 1 points for 1st / 2nd / 3rd (3 / 1 / 0 if exactly 3
  humans played; nothing under 3 humans; bots never earn points). Each tournament counts once.
- **Single table only** (up to 8). Multi-table tournaments need something to move players between tables,
  which means a server.

## Spectators and chat

- **Watching:** anyone signed in can watch any table without a seat (`room.html?code=XXXXX&watch=1`, the "Watch"
  links, or "Watch instead" on the join form). A full table, or a private game already under way, becomes a
  watch automatically. Spectators never read anyone's hole cards (they are only readable by their owner), and they
  can't move (the rules require a seat). Watchers show as "👁 N watching" (`rooms/<code>/watchers`, removed when
  they disconnect). At an open or arena table a watcher can click "Sit down".
- **Chat:** `chat/<code>/<id>`, shown in a panel in the corner of the room page, for players and spectators alike.
  The database rules enforce: a message is 1 to 200 characters, from you (not someone else), stamped with the
  server's clock, with at least 1.5 seconds since your last one (`chatLast/<code>/<uid>` is written in the same
  update); nobody can edit a message; and the host can mute people (`rooms/<code>/muted`), switch chat off
  (`meta.chat = false`), delete messages, or clear the lot. The page waits 2 seconds between messages so network
  delays never trip the rule. Anyone can also hide a person for themselves (kept in this browser only).
- **What chat does NOT have:** an automatic profanity/abuse filter. That would need a server or a paid
  moderation service. For now moderation is the host's mute / delete / clear / off, plus personal hiding. If chat
  gets rowdy, "Turn chat off" at your own tables is one click.
- Messages are text only (the page never puts chat into HTML), so a message can't run code.

## Arena bots

An arena table created from the Arena page has `fillBots`: when fewer than 3 humans are at the table, the dealer
adds bots to make 3 (so a lone player can still play a round). They play, but never appear in the standings, and
because rating needs 3 *human* qualifiers, a bot-filled Arena earns no rating points. They step aside at the next
round when humans arrive.

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
- Not built yet: multi-table tournaments, automatic chat filtering, bots at open tables (by design).
- A scheduled tournament's room can be created by anyone who knows its code before the real first registrant, so
  on the honor system the creator becomes its dealer.

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
node tests/tournament.test.js the tournament rules (schedule, points, places, start/cancel)
node tests/chat.test.js       the chat rules (cleaning, cooldown, mute/off, hiding people)
node tests/room.test.js       whole tables on the in-memory store (27 tests: privacy, timeouts, disconnects,
                              dealer handoff, open tables, rebuys, arena rounds/ratings/bots, tournament places and ratings, chat, spectators, the public list)
```

Try the table UI with no network or friends:
`room.html?local` (private room), `room.html?local=open` (open table), `room.html?local=arena&rounds=3` (Arena,
with 3-hand rounds so you see scoring quickly), `room.html?local=sng` (a 3-player Sit & Go), `room.html?local=open&watch` (you
watch a table that a pretend "Host" deals, and can chat with them). Each has two bots for company.
