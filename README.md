# Broadcast Sim

Rebuilds NFL games in 3D from their play-by-play descriptions, as they happen.

Every play in a game reaches the world first as a line of text, the same
line a radio play-by-play voice reads:

> (Shotgun) P.Mahomes pass short left to C.Allen to SEA 49 for 18 yards (T.Okada).

This project pulls those lines from ESPN's public game feed. It parses each one
into what the ball did, choreographs all 22 players and the officials around
that, and plays the result on a broadcast-style field. A live game is followed
as its feed updates. A finished game replays either at its real pace (the gap
between snaps is the gap the stadium had) or condensed to about half an hour.

## Run it

```bash
npm start
```

Then open http://localhost:8060 (or double-click `start.bat`).

Without a `?game=` parameter, the page picks the live game if one is on,
otherwise the latest final. **Games** opens the week's slate. Pressing
**Tune in** starts the crowd and the announcer, because browsers need a
click before they will play sound.

| Key | |
|---|---|
| Space | pause / play |
| ← → | previous / next play |
| 1 2 3 4 | TV angle / All-22 / sky cam / free camera (mouse orbit) |
| V / M / F | announcer voice / stadium sound / play-by-play panel |

URL parameters: `?game=<espn id>`, `?pace=condensed|realtime|live`,
`?play=<n>`, `?cam=broadcast|all22|sky|free`, `?auto=1` (skip the Tune in
card), and `?aslive=N`. The last one replays a finished game through the
live code path, with its feed revealed N times faster than it happened. Use
it to test the live pipeline when no game is on.

Pull games for offline replay or for the test corpus:

```bash
node tools/fetch.mjs --week 7
node tools/fetch.mjs 401873022
```

## How it works

```
ESPN summary JSON ─► src/feed.js        normalize: plays, teams, roster (jersey numbers)
                   ► src/football/parse.js   description ─► legs (snap, hand, run, pass,
                                             kick, fumble, recover, dead) + penalties, tries
                   ► src/football/cast.js    which body each named player is, kept play to play
                   ► src/football/choreo.js  legs ─► 30 fps clip: 26 bodies + ball + events
                   ► src/football/call.js    the announcer's call, timed to the clip's events
                   ► src/director.js         clips on a timeline (realtime / condensed / live),
                                             walking/huddling between plays, clock, score
                   ► src/render/*            three.js field, stadium, players, ball, TV lines
                   ► src/audio.js            synthesized crowd/whistle/hits + speech synthesis
```

* **The description is the source of truth.** The parser reads the words
  alone, and the feed's own end spot is used only to check it. In
  `test/parse.test.mjs` the parser's spot agrees with the feed on 99.98% of
  ~7,800 plays across 42 games, and it reads 99.99% of lines completely.
* **Named players follow exact paths, everyone else plays their position.**
  The passer, the target, the runner and the tacklers named in the sentence
  have to be where the words put them at the moment they say. Linemen block,
  rushers rush, corners mirror and the rest pursue.
* **Live** schedules each play when it arrives and never earlier. If the
  feed delivers a batch, the director plays slightly faster until it catches
  up.

## Tests

The tests run against saved games, which are not in the repo. Pull some first:

```bash
node tools/fetch.mjs --week 7
```
```bash
npm test
```

* `parse`: every saved play is parsed, and its spot is checked against the
  feed.
* `choreo`: every play is choreographed and checked for NaN, for the ball
  ending on its spot, and for no sustained superhuman speed.
* `director`: real-time gaps follow the wallclock, live plays never start in
  the past, and a whole game is sampled second by second.

## Not done yet / next

* **Actual radio audio.** The input today is the text feed. A radio stream
  run through speech-to-text produces freer language ("Mahomes fires over the
  middle, Kelce has it at the 40!"). A model could turn each call into the
  structured line this parser already reads, and the rest of the pipeline
  stays the same.
* **Other sports.** `src/feed.js` and the director are mostly
  sport-agnostic, but the parser, choreographer and field are football.
* Teams keep the same end of the field all game (no switching sides each
  quarter). Player positions are generic 11-personnel, not real formations.
