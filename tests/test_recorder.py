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

    def test_signal_needs_two_readings_and_settles(self):
        fair = lambda t, a, h: sum(record.fair(150, 0, t, a, h)[k] for k in ('fa', 'fh'))
        low = lambda t, a, h: round((fair(t, a, h) - 6) * 2) / 2
        self.add(0, 10, 15, 15, round(fair(10, 15, 15) * 2) / 2)
        self.add(60, 11, 17, 15, low(11, 17, 15))
        g = self.store.day('20261117')['g1']
        self.assertEqual([s for s in record.signals_for(g) if s['mkt'] == 'total'], [])
        self.add(120, 12, 17, 17, low(12, 17, 17))
        self.add(180, 13, 19, 17, low(13, 19, 17))
        sig = [s for s in record.signals_for(g) if s['mkt'] == 'total']
        self.assertEqual(len(sig), 1)
        self.assertEqual((sig[0]['side'], sig[0]['t'], sig[0]['result'], sig[0]['priced']), ('Over', 12, 'Pending', 'DraftKings'))
        self.add(0, 0, 0, 0, None, final=[90, 90], status='Final')
        self.assertEqual([s['result'] for s in record.signals_for(g) if s['mkt'] == 'total'], ['Won'])

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
        self.assertEqual([r['k'] for r in ladder], list(record.LADDER))

    def test_threshold_is_in_deviations_and_price_aware(self):
        fair = lambda t, a, h: sum(record.fair(150, 0, t, a, h)[k] for k in ('fa', 'fh'))
        sigma = lambda t: record.YARD['total'] * record.coef(t)['sd_total']
        for i, t in enumerate((20, 21, 22)):
            self.store.add('20261117', 'g1', 'Away U', 'Home St', None, None, [150, 0], 'Live', None, [i * 60, t, 30 + i, 32 + i, round((fair(t, 30 + i, 32 + i) - 2.3 * sigma(t)) * 2) / 2, 0, -110, -110])
        g = self.store.day('20261117')['g1']
        total = lambda **kw: [s for s in record.signals_for(g, **kw) if s['mkt'] == 'total']
        self.assertEqual(len(total()), 1)
        self.assertGreaterEqual(total()[0]['dev'], 2)
        self.assertEqual(total(k=3.0), [], 'not three deviations out')
        self.assertEqual(total(yard={'total': 0.25, 'team': 0.25}), [], 'a wider yardstick makes the same gap ordinary')
        for r in g['r']: r[6] = -170
        self.assertEqual(total(), [], 'a steep price cancels it')

    def test_yardstick_comes_from_earlier_slates_only(self):
        import random; random.seed(7)
        for i in range(320):
            t = 5 + i * 0.09; a = h = int(t * 1.8)
            f = sum(record.fair(150, 0, t, a, h)[k] for k in ('fa', 'fh'))
            self.store.add('20261117', 'g1', 'Away U', 'Home St', None, None, [150, 0], 'Live', None, [i * 60, round(t, 2), a, h, round((f + random.gauss(0, 2)) * 2) / 2, 0, -110, -110])
        self.store.save()
        self.assertEqual(record.yardstick(self.dir.name, '20261117')['source'], 'model.json', 'a slate never measures itself')
        later = record.yardstick(self.dir.name, '20261118')
        self.assertEqual((later['source'], later['through'], later['readings']), ('recorded', '20261117', 320))
        self.assertTrue(0.1 < later['total'] < 0.25, later)


if __name__ == '__main__':
    unittest.main()
