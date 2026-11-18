# Cold Stretch Live

Live college basketball board for one question: when a team goes cold, does the book's live total drop further than it should?

- **`index.html`**: the terminal. It reads ESPN's scoreboard and play-by-play straight from the browser every 20 seconds, along with DraftKings' live total and spread as ESPN publishes them, and compares each to a fair final-score estimate.
- **`model.json`**: the fair-total model. Rest-of-game scoring by minute, fitted on 16,086 Division I games (2022-23 through December 2025) with closing lines.
- **`recorder/record.py`** and **`.github/workflows/recorder.yml`**: a GitHub Action that records every live game's score and DraftKings line every 30 seconds and commits the tracks to the `data` branch. ESPN drops the live line at the final whistle, so recording it as it happens is the only way to keep it.
- **`data` branch**: `tracks/<date>.json` (one file per slate), `ledger.json` (signals and results) and `index.json` (daily summary).

## Signals

A signal is the first moment a market sits 2.5+ points from fair with a 62%+ chance on two readings in a row, between minute 4 and minute 34, excluding 15+ point leads and 20+ point spreads. Game totals use DraftKings' live price. Team totals are implied from the live total and spread and priced at an assumed -115.

## Limits

The model knows nothing about injuries, foul trouble or who is on the floor. ESPN's endpoints are unofficial and can change or lag. Lines shown are DraftKings only. This is information, not betting advice.
