// node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createModel, elapsed, clockLabel, isClockGlitch, gapStats, breakEven, RULES } from '../js/model.js';

const root = new URL('..', import.meta.url);
const model = createModel(JSON.parse(readFileSync(new URL('model.json', root))));
const parity = JSON.parse(readFileSync(new URL('tests/fixtures/parity.json', root)));
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);

test('matches the Python recorder on every fixture case', () => {
  for (const c of parity.cases) {
    const j = model.judge(c.pre, c.t, c.away, c.home, c.book_total, c.book_spread);
    close(j.fair.away, c.fair_away, 'fair away');
    close(j.fair.home, c.fair_home, 'fair home');
    close(j.fair.awayShort, c.away_short, 'away shortfall');
    close(j.fair.homeShort, c.home_short, 'home shortfall');
    close(j.markets.total.dev, c.dev_total, 'deviations, total');
    close(j.markets.away.dev, c.dev_away, 'deviations, away');
    close(j.markets.home.dev, c.dev_home, 'deviations, home');
    close(j.markets.total.over, c.over_total, 'over chance, total');
    close(j.markets.away.over, c.over_away, 'over chance, away');
    close(j.markets.home.over, c.over_home, 'over chance, home');
  }
});

test('break-even rates match the recorder', () => {
  for (const p of parity.prices) close(breakEven(p.price), p.break_even, `price ${p.price}`);
  close(breakEven(-110), 110 / 210, 'a -110 price needs 52.4%');
});

test('reads ESPN clocks', () => {
  for (const c of parity.clocks) close(elapsed(c.period, c.clock), c.minute, `${c.period} ${c.clock}`);
  assert.equal(clockLabel(12.5), '1H 7:30');
  assert.equal(clockLabel(27.77), '2H 12:14');
});

test('the fair number lands on the score at the final whistle', () => {
  const f = model.fair([149.5, -3.5], 40, 71, 78);
  assert.equal(f.away, 71);
  assert.equal(f.home, 78);
});

test('a team behind its pace is expected to finish under its pregame total, not catch up', () => {
  const pre = [150, 0];
  const cold = model.fair(pre, 20, 22, 35);
  assert.ok(cold.awayShort > 10);
  assert.ok(cold.away < 75 - 8, `cold team fair ${cold.away}`);
  assert.ok(cold.away > 22 + (75 - 35.2) * 0.9, 'but it scores at about its normal rate from here');
});

test('drops readings whose game clock outruns the wall clock or runs backwards', () => {
  const at730 = [1000, 12.5], at507 = [1030, 14.88], at701 = [1060, 12.98], next = [1090, 13.0];
  assert.equal(isClockGlitch(null, at730), false);
  assert.equal(isClockGlitch(at730, at507), true, '2.4 game minutes in 30 seconds');
  assert.equal(isClockGlitch(at730, at701), false);
  assert.equal(isClockGlitch(at507, at701), true, 'backwards');
  assert.equal(isClockGlitch(at701, next), false);
});

test('a signal is a reading 2 out when the reading before it was already 1.5 out', () => {
  const pre = [150, 0];
  const game = (devs) => devs.map((d, i) => { const t = 20 + i, a = 30 + i, h = 32 + i, f = model.fair(pre, t, a, h).total, s = model.judge(pre, t, a, h, f, a - h).markets.total.sigma; return [i * 60, t, a, h, f - d * s, a - h, -110, -110]; });
  const total = (devs, opts) => model.signalsFor(pre, game(devs), null, opts).filter((s) => s.market === 'total').map((s) => s.minute);
  assert.deepEqual(total([0, 2.3, 0]), [], 'one reading at 2.3 with nothing before it');
  assert.deepEqual(total([0, 1.6, 2.3]), [22], '1.6 then 2.3 fires on the second');
  assert.deepEqual(total([0, 1.6, 1.9, 1.7]), [], 'armed but never reaches 2');
  assert.deepEqual(total([0, -1.8, 2.3]), [], 'armed on the other side does not count');
  assert.deepEqual(total([0, 2.3, 0], { armDev: null }), [21], 'the one-reading variant');
  assert.deepEqual(total([0, 1.6, 1.7], { buyDev: 1.5, armDev: 1.5 }), [22], 'the 1.5 twice variant');
});

test('a signal needs two qualifying readings in a row, fires once, and settles on the final', () => {
  const pre = [150, 0];
  const fairAt = (t, a, h) => model.fair(pre, t, a, h).total;
  const low = (t, a, h) => Math.round((fairAt(t, a, h) - 6) * 2) / 2; // book six points under fair: a clear over
  const fine = (t, a, h) => Math.round(fairAt(t, a, h) * 2) / 2;
  const r = (ts, t, a, h, line) => [ts, t, a, h, line, 0, -110, -110];
  const oneOff = [r(0, 10, 15, 15, fine(10, 15, 15)), r(60, 11, 17, 15, low(11, 17, 15)), r(120, 12, 17, 17, fine(12, 17, 17))];
  assert.equal(model.signalsFor(pre, oneOff, null).filter((s) => s.market === 'total').length, 0, 'a single reading is not a signal');
  const held = [r(0, 10, 15, 15, fine(10, 15, 15)), r(60, 11, 17, 15, low(11, 17, 15)), r(120, 12, 17, 17, low(12, 17, 17)), r(180, 13, 19, 17, low(13, 19, 17))];
  const open = model.signalsFor(pre, held, null).filter((s) => s.market === 'total');
  assert.equal(open.length, 1);
  assert.equal(open[0].side, 'Over');
  assert.equal(open[0].minute, 12, 'it fires on the second reading');
  assert.equal(open[0].result, 'Pending');
  assert.equal(open[0].priced, 'DraftKings');
  const line = open[0].line;
  const won = model.signalsFor(pre, held, { away: Math.ceil(line / 2) + 1, home: Math.ceil(line / 2) + 1 }).find((s) => s.market === 'total');
  const lost = model.signalsFor(pre, held, { away: Math.floor(line / 2) - 2, home: Math.floor(line / 2) - 2 }).find((s) => s.market === 'total');
  assert.equal(won.result, 'Won');
  assert.equal(lost.result, 'Lost');
});

test('the threshold is in deviations, so the points it takes shrink as the game runs out', () => {
  const pre = [150, 0];
  const pointsFor = (t, a, h) => model.judge(pre, t, a, h, 150, 0).markets.total.sigma * RULES.buyDev;
  const early = pointsFor(8, 14, 14), late = pointsFor(32, 60, 60);
  assert.ok(early > 3.8 && early < 4.8, `two deviations at minute 8: ${early.toFixed(2)} points`);
  assert.ok(late > 2.2 && late < 3.0, `two deviations at minute 32: ${late.toFixed(2)} points`);
  const at = (t, a, h, points) => { const f = model.fair(pre, t, a, h).total; return model.judge(pre, t, a, h, f - points, a - h).markets.total; };
  assert.equal(at(8, 14, 14, 3.5).signal, 'lean', '3.5 points early is short of two deviations');
  assert.equal(at(32, 60, 60, 3.5).signal, 'buy', '3.5 points late is beyond two deviations');
  close(at(8, 14, 14, 3).dev, 3 / at(8, 14, 14, 3).sigma, 'dev is the gap over one deviation');
});

test('a steep price can cancel a signal, and another threshold can be asked for', () => {
  const pre = [150, 0], t = 20, a = 30, h = 32, f = model.fair(pre, t, a, h).total;
  const line = f - 2.2 * model.judge(pre, t, a, h, f, a - h).markets.total.sigma;
  assert.equal(model.judge(pre, t, a, h, line, a - h, { overPrice: -110 }).markets.total.signal, 'buy');
  assert.equal(model.judge(pre, t, a, h, line, a - h, { overPrice: -160 }).markets.total.signal, 'lean', '-160 needs 61.5% plus the margin');
  assert.equal(model.judge(pre, t, a, h, line, a - h, { overPrice: -110, buyDev: 2.5 }).markets.total.signal, 'lean');
  assert.equal(model.judge(pre, t, a, h, line, a - h, { yard: { total: 0.2, team: 0.2 } }).markets.total.signal, 'lean', 'a wider yardstick makes the same gap less unusual');
});

test('no signals in blowouts, on huge spreads, or outside the window', () => {
  const judgeAt = (pre, t, a, h) => { const f = model.fair(pre, t, a, h).total; return model.judge(pre, t, a, h, f - 8, a - h).markets.total.signal; };
  assert.equal(judgeAt([150, 0], 20, 30, 32), 'buy');
  assert.equal(judgeAt([150, 0], 20, 20, 20 + RULES.blowoutLead), null);
  assert.equal(judgeAt([150, -RULES.blowoutSpread], 20, 30, 32), null);
  assert.equal(judgeAt([150, 0], RULES.firstMinute - 1, 5, 6), null);
  assert.equal(judgeAt([150, 0], RULES.lastMinute + 1, 60, 62), null);
});

test('gap summary: average distance and the share of readings beyond the threshold on each side', () => {
  assert.deepEqual(gapStats([]), { n: 0, abs: null, low: null, high: null, mean: null, sd: null });
  const s = gapStats([0, 1, -1, 2.5, -2.5, -4, 3, -3], 2.5);
  assert.equal(s.n, 8);
  close(s.abs, 17 / 8, 'average distance');
  close(s.low, 25, 'book low: +2.5 and +3');
  close(s.high, 37.5, 'book high: -2.5, -4 and -3');
  close(s.mean, -0.5, 'mean');
  close(s.sd, Math.sqrt(46.5 / 7), 'sample standard deviation');
  assert.equal(gapStats([1.2]).sd, null, 'one reading has no spread');
});
