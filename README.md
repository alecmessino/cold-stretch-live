# Cold Stretch Live

A live board for one question about college basketball totals: **when a team goes cold, does the book's live number drop further than it should?**

**Open it:** https://alecmessino.github.io/cold-stretch-live/

The board opens with the slate in one sentence: how far DraftKings' live total has run from a fair final-score estimate, and which way it missed. Under it, every game with a line sits on one scale, fair minus book, with a dot for the latest reading and a bar for the range so far. Open a game to see the book's number and the fair number minute by minute, above the score flow for both teams. A recorder saves every game's live line as it happens, and a ledger settles each signal against the final score.

## How it works

```
ESPN scoreboard, play-by-play          every 20 s, from the browser
ESPN odds feed (DraftKings pregame, DraftKings live)
        │
        ▼
index.html + js/      the board, the game view, the record
model.json            fair-total model, one row per game minute
        ▲
        │  recorded tracks, ledger, daily summary (raw files on the `data` branch)
        │
recorder/record.py    GitHub Action, every 30 s while games are on
```

There is no server. The page reads ESPN directly; the only stored data is what the recorder commits to the `data` branch. ESPN drops the live line at the final whistle and keeps no history, so recording it as it happens is the only way to keep it.

| Path | What it is |
| --- | --- |
| `index.html`, `css/app.css` | The page. |
| `js/model.js` | The model and the signal rules. Pure functions, shared with the tests. |
| `js/espn.js` | Fetching and parsing ESPN's feeds. |
| `js/charts.js` | The range plot, the histogram and the two-pane game chart. |
| `js/app.js` | State, polling, routing and rendering. |
| `model.json` | Coefficients by game minute, and the distribution used for chances. |
| `recorder/record.py` | The recorder. Standard library only. |
| `fonts/`, `vendor/` | IBM Plex Sans, Newsreader and d3, served from this site. No third-party requests except ESPN and the recorded data. |
| `tests/` | Model parity between JavaScript and Python, parsers against real ESPN responses, recorder behaviour, palette contrast. |

## The fair number

Fair is the current score plus a rest-of-game estimate. For each minute of the game the estimate uses:

- the pace the closing total and spread implied for the time left,
- how far each team is ahead of or behind that pace,
- the lead.

It was fitted on 16,086 Division I games with closing lines, 2022–23 through December 2025. The headline from that history: teams that fall behind their pace go back to scoring at about their normal rate, and almost none of the lost points come back. So a fair live total sits close to *current score + normal pace for the time left*, well above what the cold stretch alone would project.

The chance of an over comes from how far real games landed from the estimate, not from a bell curve.

## Signals

A signal is the first time a market sits **2.5 or more points from fair**, with **at least a 62% chance**, on **two readings in a row**. Only between minute 4 and minute 34, never at a 15-point lead, never on a 20-point pregame spread. Both sides are logged:

- **Over**: the book is under fair. This is the cold-stretch case.
- **Under**: the book is over fair, usually a hot pace carried too far.

Game totals are settled at DraftKings' live price. Team totals are implied from the live total and spread, (total ± spread) / 2, and priced at an estimated -115, because the feed carries no posted team-total market.

Readings where the game clock runs faster than the wall clock, or backwards, are dropped. ESPN's clock does that occasionally.

## Design

Two colours carry meaning and nothing else does. Orange is the sportsbook's number, blue is the fair number.

- **Colour.** Orange against blue stays far apart for red-green colour blindness, where red against green nearly collapses. Every text colour clears 4.5 to 1 against every surface, and body text clears 7 to 1. `tests/tokens.test.mjs` checks all of it against `css/app.css`, so a colour change that breaks legibility fails the build.
- **Type.** IBM Plex Sans for text and figures: its numerals are tabular by default, so columns align without a feature flag, and its width axis tightens number rows on a phone. Newsreader for headlines, with its optical-size axis so large sizes get the display cut.
- **Marks.** The book is always a stepped line (a posted number that jumps), fair is always a continuous one, so the two read apart without colour.

## Keys

| Where | Key | Does |
| --- | --- | --- |
| Board | `j` / `k` | Move down / up |
| Board | `Enter` | Open the game |
| Board | `[` / `]` / `t` | Previous day / next day / today |
| Board | `s` | Signals only |
| Game | `1` / `2` / `3` | Game total / away team / home team |
| Game | `Esc` | Back to the board |

Every view has its own link, so a game and market can be shared directly.

## Run it locally

```sh
python3 -m http.server 8000
# http://localhost:8000/?data=https://raw.githubusercontent.com/alecmessino/cold-stretch-live/data/
```

```sh
node --test tests/model.test.mjs tests/espn.test.mjs tests/tokens.test.mjs tests/release.test.mjs
python3 -m unittest discover -s tests
python3 recorder/record.py --out store --minutes 5     # record five minutes of live games into ./store
```

After changing `model.json` or the model arithmetic, regenerate the parity fixture with `python3 tests/make_parity.py`. The JavaScript model must match the Python recorder on every case.

## Limits

- DraftKings only, through ESPN's unofficial feeds. They can lag, change or disappear.
- No posted team totals, no other books, no history of live lines before the recorder started on November 17, 2026.
- The model knows nothing about injuries, foul trouble or who is on the floor. A large gap can mean the book knows something.
- Information, not betting advice.
