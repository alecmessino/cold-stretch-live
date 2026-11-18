#!/usr/bin/env python3
"""Records live college basketball scores and DraftKings live lines (as published by ESPN) every 30 seconds,
writes one track file per slate date, and keeps a ledger of model signals with their results.

  python recorder/record.py --out store --minutes 335          # live recorder (used by the GitHub Action)
  python recorder/record.py --out store --import-jsonl f.jsonl  # convert an older raw capture
  python recorder/record.py --out store --rebuild               # re-judge every stored slate with the current rules

Standard library only. ESPN's endpoints are unofficial and can change without notice.
"""
import argparse, bisect, datetime, json, os, subprocess, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SB = "https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard?dates=%s&groups=50&limit=400&_=%d"
OD = "https://sports.core.api.espn.com/v2/sports/basketball/leagues/mens-college-basketball/events/%s/competitions/%s/odds?limit=20&_=%d"
# Thresholds are in deviations: (fair minus book) / (yardstick x the model's rest-of-game standard deviation at that minute).
# The signal: the three-minute rolling average of (fair minus book) is BUY_DEV deviations from zero, at a price the chance clears.
# One deviation is the standard deviation of that average, in points, measured on completed slates (about 1.2 for a game total).
# It does not shrink as the game runs out; what a point is worth does, and the chance test covers that.
# Readings from minute A0 feed the average; signals fire between minutes T0 and T1.
BUY_DEV, MARGIN, A0, T0, T1, BLOW_LEAD, BLOW_SPREAD = 2.0, 0.05, 2, 4, 38, 15, 20
WINDOW, COVER, CARRY = 180, 150, 420   # seconds averaged; seconds of history needed before an average exists; how old the reading before the window may be
M0, M1, MIN_YARD_READINGS = 4, 38, 300
# Every rule is run on every slate so the choice can be judged on results:
# (id, deviations, seconds averaged (0 = a single reading), deviations the previous reading must already show (None = not needed)).
VARIANTS = (('signal', BUY_DEV, WINDOW, None), ('avg3-1.5', 1.5, WINDOW, None), ('avg3-2.5', 2.5, WINDOW, None), ('avg3-3', 3.0, WINDOW, None),
            ('avg2-2', 2.0, 120, None), ('avg5-2', 2.0, 300, None), ('one-2', 2.0, 0, None), ('one-3', 3.0, 0, None), ('one-2-after-1.5', 2.0, 0, 1.5))
STAGES = (('all', 0, 41), ('4 to 20', 0, 20), ('20 to 34', 20, 34), ('34 to 38', 34, 41))
RULES_VERSION = '2026-11-18.3'   # change this whenever a rule, window or variant changes: the recorder then re-judges every stored slate when it next starts
MODEL = json.load(open(os.path.join(ROOT, 'model.json')))
ROWS = {r['minute']: r for r in MODEL['rows']}; CDF = MODEL['cdf']; YARD = {k: MODEL['yardstick'][k] for k in ('total', 'team')}

def get(u):
    with urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0'}), timeout=15) as r:
        return json.load(r)
def num(x):
    try: return float(x)
    except Exception: return None
def coef(t):
    t = min(38, max(2, t)); lo = min(37, int(t)); w = t - lo; a, b = ROWS[lo], ROWS[lo + 1]
    return {k: a[k] + (b[k] - a[k]) * w for k in a}
def rest(c, tt0, ott0, p, o):
    e = tt0 * c['share']; short = e - p; osh = ott0 * c['share'] - o; lead = p - o
    r = (c['b0'] + c['b_erem'] * (tt0 - e) + c['b_short'] * short + c['b_oshort'] * osh + c['b_lead'] * max(lead, 0)
         + c['b_trail'] * max(-lead, 0) + c['b_lead12'] * max(lead - 12, 0) + c['b_trail12'] * max(-lead - 12, 0))
    return max(0, r), short
def fair(total, hsp, t, a, h):
    """total, hsp = closing total and home spread (negative = home favoured); a, h = away and home points at elapsed minute t."""
    ht0 = total / 2 - hsp / 2; at0 = total / 2 + hsp / 2; c = coef(t); k = 1.0 if t <= 38 else max(0, (40 - t) / 2)
    hr, hshort = rest(c, ht0, at0, h, a); ar, ashort = rest(c, at0, ht0, a, h)
    return dict(fh=h + hr * k, fa=a + ar * k, hshort=hshort, ashort=ashort, sd_team=c['sd_team'], sd_total=c['sd_total'])
def cdf(z):
    zs = [r[0] for r in CDF]
    if z <= zs[0]: return CDF[0][1]
    if z >= zs[-1]: return CDF[-1][1]
    i = bisect.bisect_right(zs, z); a, b = CDF[i - 1], CDF[i]
    return a[1] + (b[1] - a[1]) * (z - a[0]) / (b[0] - a[0])
def break_even(price):
    """The win rate an American price needs to break even: -110 needs 52.4%."""
    return -price / (-price + 100) if price < 0 else 100 / (price + 100)
def units(price): return 100 / -price if price < 0 else price / 100
def rolled(g, window=WINDOW):
    """Every reading with a line from minute A0 on, with each market's gap (fair minus book) averaged over the last
    `window` seconds: the readings inside the window plus the one just before it, carried forward. `avg` is None until
    the line has been followed for long enough. window=0 gives the single reading. Markets are total, away, home."""
    out = []; hist = []; tot, hsp = g['pre']; cover = max(0, window - 30)
    for ts, t, a, h, bt, bs, op, up in g['r']:
        if bt is None or bs is None or t < A0: continue
        f = fair(tot, hsp, t, a, h)
        gaps = (f['fa'] + f['fh'] - bt, f['fa'] - (bt / 2 + bs / 2), f['fh'] - (bt / 2 - bs / 2))
        hist.append((ts, gaps))
        first = next(i for i, x in enumerate(hist) if ts - x[0] <= window)
        carried = window > 0 and first > 0 and (ts - window) - hist[first - 1][0] <= CARRY
        use = hist[first - 1 if carried else first:]
        hist = hist[max(0, first - 1):]
        ready = window == 0 or carried or ts - use[0][0] >= cover
        avg = tuple(sum(x[1][i] for x in use) / len(use) for i in range(3)) if ready else None
        out.append(dict(ts=ts, t=t, a=a, h=h, bt=bt, bs=bs, op=op, up=up, f=f, gaps=gaps, avg=avg))
    return out
def devs_of(g):
    """For every reading in the measuring window that has a three-minute average: the averaged total, away and home gaps
    in points, and the single-reading total gap."""
    if not g.get('pre'): return []
    return [(r['avg'][0], r['avg'][1], r['avg'][2], r['gaps'][0])
            for r in rolled(g) if r['avg'] is not None and M0 <= r['t'] <= M1]
def sd(xs):
    m = sum(xs) / len(xs); return (sum((x - m) ** 2 for x in xs) / len(xs)) ** 0.5
def yardstick(out, before):
    """One deviation: the standard deviation, in points, of the three-minute average gap, from every slate recorded
    before `before` (so a slate is never judged with its own data). Falls back to model.json until enough readings exist."""
    tot, team, slates = [], [], []
    tdir = os.path.join(out, 'tracks')
    for name in sorted(os.listdir(tdir)) if os.path.isdir(tdir) else []:
        if not name.endswith('.json') or name[:-5] >= before: continue
        try: games = json.load(open(os.path.join(tdir, name)))['games']
        except Exception: continue
        rows = [d for g in games for d in devs_of(g)]
        if rows: slates.append(name[:-5]); tot += [d[0] for d in rows]; team += [d[1] for d in rows] + [d[2] for d in rows]
    if len(tot) < MIN_YARD_READINGS: return dict(YARD, unit='points', source='model.json')
    return dict(total=round(sd(tot), 3), team=round(sd(team), 3), unit='points', readings=len(tot), slates=len(slates), through=slates[-1], source='recorded')
def elapsed(period, clock):
    try:
        mm, ss = str(clock).split(':'); left = int(mm) + float(ss) / 60
    except Exception:
        left = (num(clock) or 0) / 60
    return 40.0 if (period or 0) >= 3 else ((period or 1) - 1) * 20 + (20 - left)
def slate_date(now=None):
    """ESPN files late tips under the US Eastern date they started on; a slate rolls over at 5 AM Eastern."""
    now = now or datetime.datetime.now(datetime.timezone.utc)
    return (now - datetime.timedelta(hours=10)).strftime('%Y%m%d')

def signals_for(g, yard=None, k=BUY_DEV, window=WINDOW, arm=None):
    """First reading per market and side whose averaged gap sits k deviations from zero, at a price the chance clears.
    arm: if given, the reading before it must already have been that many deviations out on the same side.
    Team totals are implied from the live total and spread."""
    yard = yard or YARD
    if not g.get('pre'): return []
    tot, hsp = g['pre']; out = []; fired = set(); fin = g.get('final'); prev_ok = {}
    if abs(hsp) >= BLOW_SPREAD: return []
    for r in rolled(g, window):
        t, a, h, f, bt, bs = r['t'], r['a'], r['h'], r['f'], r['bt'], r['bs']
        if r['avg'] is None or not (T0 <= t <= T1) or abs(a - h) >= BLOW_LEAD: prev_ok = {}; continue
        now_ok = {}
        mk = [('total', 'Game total', f['fa'] + f['fh'], bt, f['sd_total'], yard['total'], (f['ashort'] + f['hshort']) >= 5, r['op'], r['up'], None if not fin else fin[0] + fin[1]),
              ('away', g['away'] + ' team total', f['fa'], bt / 2 + bs / 2, f['sd_team'], yard['team'], f['ashort'] >= 3, None, None, None if not fin else fin[0]),
              ('home', g['home'] + ' team total', f['fh'], bt / 2 - bs / 2, f['sd_team'], yard['team'], f['hshort'] >= 3, None, None, None if not fin else fin[1])]
        for i, (key, market, fv, line, sd_rest, y, cold, o_price, u_price, final) in enumerate(mk):
            gap = r['avg'][i]; sigma = y; dev = gap / sigma; p_over = 1 - cdf(-gap / sd_rest)
            side, p, price = ('Over', p_over, o_price) if gap >= 0 else ('Under', 1 - p_over, u_price)
            paid = price if price is not None else -115; size = abs(dev)
            if size <= 0 or p < break_even(paid) + MARGIN: continue
            now_ok[(key, side)] = size
            if size >= k and (arm is None or prev_ok.get((key, side), 0) >= arm) and (key, side) not in fired:
                fired.add((key, side))
                res = 'Pending' if final is None else 'Push' if final == line else 'Won' if (final > line) == (side == 'Over') else 'Lost'
                out.append(dict(id=f"{g['id']}|{key}|{side}", date=g['date'], game=g['id'], matchup=f"{g['away']} at {g['home']}", mkt=key, market=market, side=side,
                                spot='Cold spot' if (cold and side == 'Over') else 'Book below fair' if side == 'Over' else 'Book above fair',
                                ts=r['ts'], t=round(t, 1), score=f'{a}-{h}', line=line, price=paid, priced='DraftKings' if price is not None else 'Assumed',
                                fair=round(fv, 1), edge=round(gap, 1), dev=round(dev, 2), sigma=round(sigma, 2), chance=round(100 * p), final=final, result=res))
        prev_ok = now_ok
    return out

class Store:
    def __init__(self, out):
        self.out = out; os.makedirs(os.path.join(out, 'tracks'), exist_ok=True); self.days = {}; self.yards = {}
    def path(self, date): return os.path.join(self.out, 'tracks', date + '.json')
    def day(self, date):
        if date not in self.days:
            try: d = json.load(open(self.path(date)))
            except Exception: d = {'date': date, 'games': []}
            self.days[date] = {g['id']: g for g in d['games']}
            if d.get('yardstick'): self.yards[date] = d['yardstick']
        return self.days[date]
    def add(self, date, ev_id, away, home, ar, hr, pre, status, final, reading):
        g = self.day(date).setdefault(ev_id, dict(id=ev_id, date=date, away=away, home=home, ar=ar, hr=hr, pre=None, status='', final=None, r=[]))
        if pre and pre[0] is not None and pre[1] is not None: g['pre'] = pre
        g['status'] = status
        if final: g['final'] = final
        if reading:
            last = g['r'][-1] if g['r'] else None
            if last is not None and ((reading[1] - last[1]) * 60 > (reading[0] - last[0]) + 15 or reading[1] < last[1] - 0.05): return   # game clock cannot outrun the wall clock: ESPN glitch
            if last is None or (reading[1:] != last[1:] and reading[0] - last[0] >= 45) or reading[0] - last[0] >= 300: g['r'].append(reading)
    def save(self):
        ledger_path = os.path.join(self.out, 'ledger.json'); index_path = os.path.join(self.out, 'index.json'); ladder_path = os.path.join(self.out, 'ladder.json')
        try: ledger = json.load(open(ledger_path))
        except Exception: ledger = []
        try: index = {d['date']: d for d in json.load(open(index_path))}
        except Exception: index = {}
        try: ladder = json.load(open(ladder_path))
        except Exception: ladder = []
        for date, games in self.days.items():
            gl = sorted(games.values(), key=lambda g: g['id'])
            if (self.yards.get(date) or {}).get('unit') != 'points': self.yards[date] = yardstick(self.out, date)   # fixed the first time a slate is saved
            yard = self.yards[date]
            json.dump({'date': date, 'updated': int(time.time()), 'yardstick': yard, 'games': gl}, open(self.path(date), 'w'), separators=(',', ':'))
            ledger = [s for s in ledger if s['date'] != date] + [s for g in gl for s in signals_for(g, yard)]
            ladder = [r for r in ladder if r['date'] != date]
            for rule, k, window, arm in VARIANTS:   # what each rule would have done, overall and by stage of the game
                every = [s for g in gl for s in signals_for(g, yard, k, window, arm)]
                for stage, lo, hi in STAGES:
                    sig = [s for s in every if lo <= s['t'] < hi]; res = [s['result'] for s in sig]
                    ladder.append(dict(date=date, rule=rule, stage=stage, n=len(sig), won=res.count('Won'), lost=res.count('Lost'), push=res.count('Push'), open=res.count('Pending'),
                                       units=round(sum(units(s['price']) if s['result'] == 'Won' else -1 if s['result'] == 'Lost' else 0 for s in sig), 2)))
            rows = [d for g in gl for d in devs_of(g)]; n = len(rows)
            index[date] = dict(date=date, games=sum(1 for g in gl if g['r']), readings=sum(len(g['r']) for g in gl), total_readings=n,
                               gap_abs=round(sum(abs(d[3]) for d in rows) / n, 2) if n else None, gap_mean=round(sum(d[3] for d in rows) / n, 2) if n else None,
                               dev_low=round(100 * sum(d[0] / yard['total'] >= BUY_DEV for d in rows) / n, 1) if n else None,
                               dev_high=round(100 * sum(d[0] / yard['total'] <= -BUY_DEV for d in rows) / n, 1) if n else None, yard_total=yard['total'])
        json.dump(sorted(ladder, key=lambda r: r['date']), open(ladder_path, 'w'), separators=(',', ':'))
        json.dump(sorted(ledger, key=lambda s: (s['date'], s['ts'])), open(ledger_path, 'w'), separators=(',', ':'))
        json.dump(sorted(index.values(), key=lambda d: d['date']), open(index_path, 'w'), separators=(',', ':'))

def migrate(out):
    """If the stored results were judged under other rules, judge every stored slate again from its readings.
    Readings are never changed; yardsticks, ledger, ladder and daily summaries are rebuilt. Returns True if it ran."""
    path = os.path.join(out, 'rules.json')
    try: current = json.load(open(path)).get('version')
    except Exception: current = None
    if current == RULES_VERSION: return False
    store = Store(out); tdir = os.path.join(out, 'tracks')
    for name in sorted(os.listdir(tdir)):
        if name.endswith('.json'): store.day(name[:-5])
    store.yards.clear()
    for stale in ('ladder.json', 'ledger.json', 'index.json'):
        try: os.remove(os.path.join(out, stale))
        except OSError: pass
    store.save()
    json.dump({'version': RULES_VERSION, 'signal': {'deviations': BUY_DEV, 'average_seconds': WINDOW, 'margin': MARGIN, 'minutes': [T0, T1]}}, open(path, 'w'))
    return True

def odds_for(ev_id):
    pre = live = None
    try:
        for it in get(OD % (ev_id, ev_id, int(time.time()))).get('items', []):
            pid = str((it.get('provider') or {}).get('id')); ou, sp = num(it.get('overUnder')), num(it.get('spread'))
            if pid == '100' and ou is not None and sp is not None: pre = [ou, sp]
            if pid == '200' and ou is not None and sp is not None:
                cur = it.get('current') or {}
                live = [ou, sp, num((cur.get('over') or {}).get('american')), num((cur.get('under') or {}).get('american'))]
    except Exception as e:
        print('odds error', ev_id, str(e)[:80], flush=True)
    return pre, live

def poll(store, pre_cache):
    now = int(time.time()); date = slate_date(); evs = get(SB % (date, now)).get('events', [])
    live_games = [e for e in evs if e['status']['type']['state'] == 'in']
    with ThreadPoolExecutor(8) as ex: odds = dict(zip([e['id'] for e in live_games], ex.map(odds_for, [e['id'] for e in live_games])))
    n_in = n_pre = 0
    for e in evs:
        st = e['status']; state = st['type']['state']; c = e['competitions'][0]; cs = {x['homeAway']: x for x in c['competitors']}
        n_pre += state == 'pre'
        if e['id'] not in store.day(date) and state != 'in': continue
        name = lambda s: cs[s]['team'].get('shortDisplayName') or cs[s]['team'].get('location') or cs[s]['team'].get('abbreviation')
        rank = lambda s: (lambda r: r if r and r <= 25 else None)((cs[s].get('curatedRank') or {}).get('current'))
        a, h = int(num(cs['away'].get('score')) or 0), int(num(cs['home'].get('score')) or 0)
        if state == 'in':
            n_in += 1; pre, live = odds.get(e['id'], (None, None))
            if pre: pre_cache[e['id']] = pre
            t = round(elapsed(st.get('period'), st.get('displayClock')), 2)
            reading = [now, t, a, h] + (live if live else [None, None, None, None]) if (st.get('period') or 0) <= 2 else None
            store.add(date, e['id'], name('away'), name('home'), rank('away'), rank('home'), pre_cache.get(e['id']), st['type'].get('shortDetail') or 'Live', None, reading)
        elif state == 'post':
            store.add(date, e['id'], name('away'), name('home'), rank('away'), rank('home'), pre_cache.get(e['id']), 'Final', [a, h], None)
    return n_in, n_pre

def git(out, *args): return subprocess.run(['git', '-C', out] + list(args), capture_output=True, text=True)
def push(out):
    git(out, 'add', '-A')
    if git(out, 'diff', '--cached', '--quiet').returncode == 0: return
    git(out, 'commit', '-q', '-m', 'recorder: ' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d %H:%M UTC'))
    r = git(out, 'push', '-q'); print('push', r.returncode, r.stderr.strip()[:120], flush=True)

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--out', default='store'); ap.add_argument('--minutes', type=float, default=335)
    ap.add_argument('--push', action='store_true'); ap.add_argument('--import-jsonl'); ap.add_argument('--rebuild', action='store_true'); ap.add_argument('--reyard', default='')
    a = ap.parse_args(); store = Store(a.out)
    if a.rebuild:   # recompute the ledger, ladder and summaries of every stored slate with the current rules
        for name in sorted(os.listdir(os.path.join(a.out, 'tracks'))):
            if name.endswith('.json'): store.day(name[:-5])
        for date in a.reyard.split(','): store.yards.pop(date, None)   # --reyard DATE,DATE: measure those slates' yardsticks again
        store.save(); return
    if not a.import_jsonl and migrate(a.out): print('stored slates judged again under rules', RULES_VERSION, flush=True)
    if a.import_jsonl:
        for line in open(a.import_jsonl):
            s = json.loads(line); date = slate_date(datetime.datetime.fromtimestamp(s['ts'], datetime.timezone.utc))
            pre = next(([b['ou'], b['spread']] for b in s['books'] if str(b['pid']) == '100' and b.get('ou') is not None), None)
            lv = next(([b['ou'], b['spread'], b.get('over'), b.get('under')] for b in s['books'] if str(b['pid']) == '200' and b.get('ou') is not None and b.get('spread') is not None), [None] * 4)
            if (s.get('period') or 0) > 2: continue
            store.add(date, s['id'], s['away'], s['home'], None, None, pre, s.get('detail') or 'Live', None, [s['ts'], round(elapsed(s['period'], s['clock']), 2), int(s['as']), int(s['hs'])] + lv)
        store.save(); return
    end = time.time() + a.minutes * 60; last_save = last_push = 0; idle_since = None; pre_cache = {}; finished = False
    while time.time() < end:
        t0 = time.time()
        try:
            n_in, n_pre = poll(store, pre_cache)
            print(datetime.datetime.now(datetime.timezone.utc).strftime('%H:%M:%S'), 'live', n_in, 'to come', n_pre, flush=True)
            idle_since = None if n_in else (idle_since or t0)
            if n_in == 0 and n_pre == 0 and idle_since and t0 - idle_since > 900: finished = True
        except Exception as e:
            print('poll error', str(e)[:120], flush=True); n_in = 1
        if t0 - last_save >= 60: store.save(); last_save = t0
        if a.push and t0 - last_push >= 300: push(a.out); last_push = t0
        if finished: break
        time.sleep(max(1, (30 if n_in else 120) - (time.time() - t0)))
    store.save()
    if a.push: push(a.out)
    print('SLATE_FINISHED' if finished else 'TIME_UP', flush=True)

if __name__ == '__main__': main()
