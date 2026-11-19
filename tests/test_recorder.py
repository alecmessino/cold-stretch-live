"""python -m unittest discover tests"""
import datetime, json, os, sys, tempfile, unittest
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'recorder'))
import record  # noqa: E402


class Clock(unittest.TestCase):
    def test_elapsed(self):
        self.assertEqual(record.elapsed(1, '20:00'), 0)
        self.assertAlmostEqual(record.elapsed(1, '7:30'), 12.5)
        self.assertEqual(record.elapsed(2, '20:00'), 20)
        self.assertEqual(record.elapsed(2, '0:00'), 40)
        self.assertEqual(record.elapsed(3, '4:10'), 40)

    def test_slate_rolls_over_at_5am_eastern(self):
        utc = datetime.timezone.utc
        self.assertEqual(record.slate_date(datetime.datetime(2026, 11, 18, 5, 0, tzinfo=utc)), '20261117')   # midnight Eastern tip
        self.assertEqual(record.slate_date(datetime.datetime(2026, 11, 18, 9, 59, tzinfo=utc)), '20261117')
        self.assertEqual(record.slate_date(datetime.datetime(2026, 11, 18, 10, 0, tzinfo=utc)), '20261118')


class Model(unittest.TestCase):
    def test_fair_lands_on_the_score_at_the_whistle(self):
        f = record.fair(149.5, -3.5, 40, 71, 78)
        self.assertEqual((f['fa'], f['fh']), (71, 78))

    def test_cold_team_resumes_pace_without_catching_up(self):
        f = record.fair(150, 0, 20, 22, 35)
        self.assertGreater(f['ashort'], 10)
        self.assertLess(f['fa'], 75 - 8)

    def test_cdf_is_monotone(self):
        zs = [x / 10 for x in range(-40, 41)]
        ps = [record.cdf(z) for z in zs]
        self.assertEqual(ps, sorted(ps))
        self.assertLess(ps[0], 0.01)
        self.assertGreater(ps[-1], 0.99)


class Recording(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.store = record.Store(self.dir.name)

    def tearDown(self):
        self.dir.cleanup()

    def add(self, ts, t, a, h, line, final=None, status='Live'):
        self.store.add('20261117', 'g1', 'Away U', 'Home St', None, None, [150, 0], status, final, None if line is None else [ts, t, a, h, line, 0, -110, -110])

    def test_clock_glitch_is_dropped(self):
        self.add(1000, 12.5, 20, 14, 140.5)
        self.add(1060, 14.88, 21, 14, 137.5)    # 2.4 game minutes in 60 seconds
        self.add(1120, 13.0, 23, 14, 141.5)
        self.assertEqual([r[1] for r in self.store.day('20261117')['g1']['r']], [12.5, 13.0])

    def game(self, gaps, start=20, price=-110, a0=30, h0=32, pre=(150, 0), every=60, final=None):
        """A game where the book sits gaps[i] points under fair at reading i."""
        g = dict(id='g', date='20261117', away='Away U', home='Home St', pre=list(pre), final=final, r=[])
        for i, gap in enumerate(gaps):
            t = start + i * every / 60; a, h = a0 + i, h0 + i
            f = record.fair(pre[0], pre[1], t, a, h)
            g['r'].append([i * every, t, a, h, f['fa'] + f['fh'] - gap, a - h, price, price])
        return g

    def total(self, g, **kw):
        return [s for s in record.signals_for(g, **kw) if s['mkt'] == 'total']

    def test_the_signal_is_judged_on_a_three_minute_average(self):
        rows = record.rolled(self.game([0, 0, 0, 6, 0, 0, 0]))
        self.assertIsNone(rows[1]['avg'], 'no average until the line has been followed for most of three minutes')
        self.assertAlmostEqual(rows[3]['avg'][0], 6 / 4)
        self.assertAlmostEqual(rows[6]['avg'][0], 6 / 5, msg='the reading just before the window is carried forward')
        self.assertEqual(self.total(self.game([0, 0, 0, 6, 0, 0, 0])), [], 'one six-point reading is not a signal')
        self.assertEqual(len(self.total(self.game([0, 3, 3, 3, 3, 3]))), 1, 'three points that stay are')

    def test_a_signal_fires_once_and_settles(self):
        sig = self.total(self.game([0, 3, 3, 3, 3, 3, 3]))
        self.assertEqual(len(sig), 1)
        self.assertEqual((sig[0]['side'], sig[0]['result'], sig[0]['priced']), ('Over', 'Pending', 'DraftKings'))
        self.assertGreaterEqual(sig[0]['dev'], record.BUY_DEV)
        self.assertEqual([s['result'] for s in self.total(self.game([0, 3, 3, 3, 3, 3, 3], final=[90, 90]))], ['Won'])
        self.assertEqual([s['result'] for s in self.total(self.game([0, 3, 3, 3, 3, 3, 3], final=[50, 50]))], ['Lost'])
        self.assertEqual(self.total(self.game([0, -3, -3, -3, -3, -3]))[0]['side'], 'Under')

    def test_price_thresholds_windows_and_yardsticks(self):
        held = [2.7] * 5
        self.assertEqual(len(self.total(self.game(held))), 1)
        self.assertEqual(self.total(self.game(held, price=-180)), [], 'a steep price cancels it')
        self.assertEqual(self.total(self.game(held), k=3.0), [])
        self.assertEqual(self.total(self.game(held), yard={'total': 2, 'team': 2}), [], 'a wider yardstick makes the same gap ordinary')
        self.assertEqual([s['t'] for s in self.total(self.game([0, 0, 0, 6, 0]), window=0)], [23], 'the single-reading comparison rule')
        self.assertEqual([s['t'] for s in self.total(self.game([0, 0, 2.5, 6, 0]), window=0, arm=1.5)], [23])
        self.assertEqual(self.total(self.game([0, 0, 0, 6, 0]), window=0, arm=1.5), [])

    def test_no_signals_in_blowouts_big_spreads_or_outside_the_window(self):
        held = [4] * 6
        self.assertEqual(len(self.total(self.game(held))), 1)
        self.assertEqual(self.total(self.game(held, h0=30 + record.BLOW_LEAD)), [])
        self.assertEqual(self.total(self.game(held, pre=(150, -record.BLOW_SPREAD))), [])
        self.assertEqual(self.total(self.game(held, start=record.T1 + 0.5, every=20)), [])
        self.assertTrue(all(s['t'] >= record.T0 for s in record.signals_for(self.game(held, start=0, a0=0, h0=0, every=30))))

    def test_a_run_hands_over_when_the_recorder_on_main_has_changed(self):
        import subprocess
        run = lambda cwd, *a: subprocess.run(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', *a], cwd=cwd, check=True, capture_output=True)
        origin, clone = os.path.join(self.dir.name, 'origin'), os.path.join(self.dir.name, 'clone')
        os.makedirs(os.path.join(origin, 'recorder')); run(origin, 'init', '-q', '-b', 'main')
        open(os.path.join(origin, 'recorder', 'record.py'), 'w').write('one'); open(os.path.join(origin, 'index.html'), 'w').write('site')
        run(origin, 'add', '-A'); run(origin, 'commit', '-q', '-m', 'start')
        run(self.dir.name, 'clone', '-q', 'file://' + origin, clone)
        self.assertFalse(record.superseded(clone), 'nothing has changed')
        open(os.path.join(origin, 'index.html'), 'w').write('site, restyled'); run(origin, 'commit', '-qam', 'site only')
        self.assertFalse(record.superseded(clone), 'a change to the site alone does not interrupt recording')
        open(os.path.join(origin, 'recorder', 'record.py'), 'w').write('two'); run(origin, 'commit', '-qam', 'new rule')
        self.assertTrue(record.superseded(clone), 'a change to the recorder does')
        self.assertFalse(record.superseded(os.path.join(self.dir.name, 'nowhere')), 'and a failure to check never stops a run')

    def test_the_quote_on_screen_must_still_carry_the_edge(self):
        self.assertEqual(self.total(self.game([5, 5, 5, 0.2])), [], 'the average is far out, but the book has just closed the gap: nothing to buy')
        s = self.total(self.game([5, 5, 5, 0.2, 5]))
        self.assertEqual(len(s), 1, 'it fires on the next reading that still offers the gap')
        self.assertEqual(s[0]['t'], 24.0)
        f = record.fair(150, 0, 24, 34, 36)
        self.assertEqual(s[0]['chance'], round(100 * (1 - record.cdf(-5 / f['sd_total']))), 'and the chance logged is the chance on that quote')

    def test_a_market_fires_once_a_game_unless_it_is_allowed_again_after_the_gap_closes(self):
        there_and_back = [4] * 6 + [0] * 6 + [4] * 6   # out, closed, out again
        once = self.total(self.game(there_and_back))
        twice = [s for s in record.signals_for(self.game(there_and_back), again=1.0) if s['mkt'] == 'total']
        self.assertEqual(len(once), 1)
        self.assertEqual(len(twice), 2)
        self.assertEqual(twice[0]['id'], once[0]['id'], 'the first signal is the same one')
        self.assertNotEqual(twice[1]['id'], twice[0]['id'], 'and the second has its own id')
        stays_out = [s for s in record.signals_for(self.game([4] * 18), again=1.0) if s['mkt'] == 'total']
        self.assertEqual(len(stays_out), 1, 'a gap that never closes is still one signal')

    def test_lopsided_spots_are_judged_apart_and_kept_out_of_the_yardstick(self):
        held = [4] * 6; shadow = lambda g: [s for s in record.signals_for(g, lopsided=True) if s['mkt'] == 'total']
        wide, led, close = self.game(held, pre=(150, -record.BLOW_SPREAD)), self.game(held, h0=30 + record.BLOW_LEAD), self.game(held)
        self.assertEqual(len(shadow(wide)), 1, 'a wide spread fires only in the comparison')
        self.assertEqual(len(shadow(led)), 1, 'and so does a big lead')
        self.assertEqual(shadow(close), [], 'a close game never appears in the comparison')
        self.assertEqual(shadow(wide)[0]['t'], self.total(close)[0]['t'], 'it is the same rule, applied where the signal is off')
        self.assertEqual(record.devs_of(wide), [])
        self.assertEqual(record.devs_of(led), [])
        self.assertGreater(len(record.devs_of(close)), 0)

    def test_save_writes_tracks_ledger_and_index(self):
        self.add(0, 10, 15, 15, 150.5)
        self.add(60, 11, 17, 15, 150.5)
        self.store.save()
        day = json.load(open(os.path.join(self.dir.name, 'tracks', '20261117.json')))
        self.assertEqual(len(day['games'][0]['r']), 2)
        self.assertEqual(json.load(open(os.path.join(self.dir.name, 'index.json')))[0]['readings'], 2)
        self.assertIsInstance(json.load(open(os.path.join(self.dir.name, 'ledger.json'))), list)
        self.assertEqual(day['yardstick']['source'], 'model.json', 'no earlier slate, so the shipped yardstick is used and stored with the day')
        ladder = json.load(open(os.path.join(self.dir.name, 'ladder.json')))
        self.assertEqual({r['rule'] for r in ladder}, {v[0] for v in record.VARIANTS} | {record.SHADOW[0]} | {i[0] for i in record.IDEAS})
        self.assertEqual(len(ladder), (len(record.VARIANTS) + 1 + len(record.IDEAS)) * len(record.STAGES))

    def test_stored_slates_are_judged_again_when_the_rules_change(self):
        self.add(0, 10, 15, 15, 150.5)
        self.add(60, 11, 17, 15, 150.5)
        self.store.save()
        json.dump([{'date': '20261117', 'k': 2.0, 'n': 9}], open(os.path.join(self.dir.name, 'ladder.json'), 'w'))   # a ladder from older rules
        self.assertTrue(record.migrate(self.dir.name))
        ladder = json.load(open(os.path.join(self.dir.name, 'ladder.json')))
        self.assertTrue(all('rule' in r for r in ladder))
        self.assertEqual(json.load(open(os.path.join(self.dir.name, 'rules.json')))['version'], record.RULES_VERSION)
        self.assertEqual(len(json.load(open(os.path.join(self.dir.name, 'tracks', '20261117.json')))['games'][0]['r']), 2, 'readings are untouched')
        self.assertFalse(record.migrate(self.dir.name), 'and it only runs once per rules version')

    def test_a_slate_keeps_its_yardstick_when_the_rules_change(self):
        self.add(0, 10, 15, 15, 150.5)
        self.store.save()
        path = os.path.join(self.dir.name, 'tracks', '20261117.json'); day = json.load(open(path))
        day['yardstick'] = {'total': 1.5, 'team': 0.9, 'unit': 'points', 'source': 'recorded'}; json.dump(day, open(path, 'w'))
        json.dump({'version': 'older'}, open(os.path.join(self.dir.name, 'rules.json'), 'w'))
        self.assertTrue(record.migrate(self.dir.name))
        self.assertEqual(json.load(open(path))['yardstick']['total'], 1.5, 'signals already logged are not re-measured after the fact')
        day['yardstick'] = {'total': 0.14, 'team': 0.15}; json.dump(day, open(path, 'w'))   # an older unit
        json.dump({'version': 'older'}, open(os.path.join(self.dir.name, 'rules.json'), 'w'))
        self.assertTrue(record.migrate(self.dir.name))
        self.assertEqual(json.load(open(path))['yardstick']['unit'], 'points')

    def test_yardstick_comes_from_earlier_slates_only(self):
        import random; random.seed(7)
        for i in range(320):
            t = 4 + i * 0.1; a = h = int(t * 1.8)
            f = sum(record.fair(150, 0, t, a, h)[k] for k in ('fa', 'fh'))
            self.store.add('20261117', 'g1', 'Away U', 'Home St', None, None, [150, 0], 'Live', None, [i * 60, round(t, 2), a, h, round((f + random.gauss(0, 2)) * 2) / 2, 0, -110, -110])
        self.store.save()
        self.assertEqual(record.yardstick(self.dir.name, '20261117')['source'], 'model.json', 'a slate never measures itself')
        later = record.yardstick(self.dir.name, '20261118')
        self.assertEqual((later['source'], later['through'], later['unit']), ('recorded', '20261117', 'points'))
        self.assertGreaterEqual(later['readings'], 300)
        self.assertTrue(0.6 < later['total'] < 2.0, later)   # the average of three readings with 2 points of noise each


if __name__ == '__main__':
    unittest.main()
