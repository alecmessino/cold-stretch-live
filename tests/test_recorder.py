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
        self.assertEqual({r['rule'] for r in ladder}, {v[0] for v in record.VARIANTS})
        self.assertEqual(len(ladder), len(record.VARIANTS) * len(record.STAGES))

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
