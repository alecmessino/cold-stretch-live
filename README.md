# Cold Stretch Live

A live board for one question about college basketball totals: **when a team goes cold, does the book's live number drop further than it should?**

**Open it:** https://alecmessino.github.io/cold-stretch-live/

Every in-progress Division I game is shown with DraftKings' live total next to a fair final-score estimate for the game as it stands. Open a game to see how the book's number, the fair number and the raw pace have moved minute by minute, above the score flow for both teams. A recorder saves every game's live line as it happens, and a ledger settles each signal against the final score.

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
| `js/charts.js` | The gap bar, the sparkline and the two-pane game chart. |
| `js/app.js` | State, polling, routing and rendering. |
| `model.json` | Coefficients by game minute, and the distribution used for chances. |
| `recorder/record.py` | The recorder. Standard library only. |
| `tests/` | Model parity between JavaScript and Python, parsers against real ESPN responses, recorder behaviour. |

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
node --test tests/model.test.mjs tests/espn.test.mjs
python3 -m unittest discover -s tests
python3 recorder/record.py --out store --minutes 5     # record five minutes of live games into ./store
```

After changing `model.json` or the model arithmetic, regenerate the parity fixture with `python3 tests/make_parity.py`. The JavaScript model must match the Python recorder on every case.

## Limits

- DraftKings only, through ESPN's unofficial feeds. They can lag, change or disappear.
- No posted team totals, no other books, no history of live lines before the recorder started on November 17, 2026.
- The model knows nothing about injuries, foul trouble or who is on the floor. A large gap can mean the book knows something.
- Information, not betting advice.
