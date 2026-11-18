#!/usr/bin/env python3
"""Writes tests/fixtures/parity.json: model outputs from the Python recorder for a fixed set of game states.
The JavaScript model must reproduce them (tests/model.test.mjs). Re-run after changing model.json or the arithmetic."""
import json, os, random, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'recorder'))
import record  # noqa: E402

random.seed(20261117)
cases = []
for _ in range(240):
    total = random.choice([128.5, 136.5, 143.0, 149.5, 158.5, 171.5])
    spread = random.choice([-24.5, -15.5, -9.5, -3.5, -1.5, 0, 2.5, 7.5, 12.5])
    t = round(random.uniform(0.5, 40), 2)
    pace = total / 2 * record.coef(t)['share'] if t >= 2 else total / 2 * t / 40
    a = max(0, int(round(pace + random.gauss(0, 6)))); h = max(0, int(round(pace + random.gauss(0, 6))))
    bt = round((a + h + (total - (a + h)) * random.uniform(0.6, 1.2)) * 2) / 2
    bs = round((spread * (40 - t) / 40 + (a - h)) * 2) / 2
    f = record.fair(total, spread, t, a, h); ft = f['fa'] + f['fh']
    cases.append(dict(pre=[total, spread], t=t, away=a, home=h, book_total=bt, book_spread=bs,
                      fair_away=f['fa'], fair_home=f['fh'], away_short=f['ashort'], home_short=f['hshort'],
                      dev_total=(ft - bt) / (record.YARD['total'] * f['sd_total']), dev_away=(f['fa'] - (bt / 2 + bs / 2)) / (record.YARD['team'] * f['sd_team']),
                      dev_home=(f['fh'] - (bt / 2 - bs / 2)) / (record.YARD['team'] * f['sd_team']),
                      over_total=1 - record.cdf((bt - ft) / f['sd_total']),
                      over_away=1 - record.cdf((bt / 2 + bs / 2 - f['fa']) / f['sd_team']),
                      over_home=1 - record.cdf((bt / 2 - bs / 2 - f['fh']) / f['sd_team'])))
clocks = [dict(period=p, clock=c, minute=record.elapsed(p, c)) for p, c in [(1, '20:00'), (1, '7:30'), (1, '0:00'), (2, '20:00'), (2, '12:14'), (2, '0:42.5'), (2, '0:00'), (3, '4:10')]]
prices = [dict(price=p, break_even=record.break_even(p)) for p in (-150, -125, -115, -110, -105, 100, 120)]
json.dump({'cases': cases, 'clocks': clocks, 'prices': prices}, open(os.path.join(ROOT, 'tests', 'fixtures', 'parity.json'), 'w'), indent=0)
print(len(cases), 'cases')
