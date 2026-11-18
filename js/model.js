// Fair-total model. Pure functions, no DOM: the same file runs in the browser and under `node --test`.
// The Python recorder (recorder/record.py) implements the same arithmetic; tests/fixtures/parity.json keeps the two honest.

export const RULES = Object.freeze({
  // Thresholds are in deviations: fair minus book, divided by the usual size of that gap for the time left.
  // One deviation = yardstick x the model's rest-of-game standard deviation at that minute, so it is about
  // 2.1 points at minute 8 and 1.3 at minute 32 for a game total. A fixed number of points is not used anywhere.
  buyDev: 2, // deviations needed for a signal
  leanDev: 1.5,
  margin: 0.05, // and the chance must beat the price's break-even by this much
  firstMinute: 4, // signals only between these elapsed minutes
  lastMinute: 34,
  blowoutLead: 15, // no signals at or beyond this lead
  blowoutSpread: 20, // or this pregame spread
  staleMs: 100000, // a live line older than this is not acted on
  measureFrom: 4, // the slate summary counts readings between these minutes (the recorder uses the same window)
  measureTo: 36,
});

/**
 * Summary of a set of fair-minus-book gaps: how far apart the two numbers ran, and how often the book
 * was at least `threshold` points low (the over side) or high (the under side). Shares are percentages;
 * `sd` is the sample standard deviation of the gap, the yardstick for how unusual a reading is.
 */
export function gapStats(gaps, threshold = RULES.buyDev) {
  const n = gaps.length;
  if (!n) return { n: 0, abs: null, low: null, high: null, mean: null, sd: null };
  let abs = 0, low = 0, high = 0, sum = 0, squares = 0;
  for (const g of gaps) { abs += Math.abs(g); sum += g; squares += g * g; if (g >= threshold) low += 1; else if (g <= -threshold) high += 1; }
  const mean = sum / n;
  return { n, abs: abs / n, low: (100 * low) / n, high: (100 * high) / n, mean, sd: n > 1 ? Math.sqrt(Math.max(0, squares - n * mean * mean) / (n - 1)) : null };
}

/** The win rate an American price needs to break even: -110 needs 52.4%. */
export function breakEven(price) {
  return price < 0 ? -price / (-price + 100) : 100 / (price + 100);
}

/** Elapsed game minutes (0-40) from ESPN's period and "MM:SS" clock. Overtime clamps to 40. */
export function elapsed(period, clock) {
  const m = /^(\d+):(\d+(?:\.\d+)?)$/.exec(clock || '');
  const left = m ? Number(m[1]) + Number(m[2]) / 60 : (parseFloat(clock) || 0) / 60;
  if (period >= 3) return 40;
  return ((period || 1) - 1) * 20 + (20 - left);
}

/** "2H 12:14" for an elapsed minute. */
export function clockLabel(t) {
  const half = t <= 20 ? 1 : 2;
  const left = Math.max(0, half * 20 - t);
  const sec = Math.round((left % 1) * 60) % 60;
  return `${half}H ${Math.floor(left)}:${String(sec).padStart(2, '0')}`;
}

/**
 * ESPN's clock occasionally jumps (7:30, then 5:07, then 7:01). A game clock cannot run faster than the wall clock,
 * and cannot run backwards, so a reading that does either is dropped.
 * Readings are [unixSeconds, elapsedMinutes, ...].
 */
export function isClockGlitch(prev, next) {
  if (!prev) return false;
  return (next[1] - prev[1]) * 60 > next[0] - prev[0] + 15 || next[1] < prev[1] - 0.05;
}

export function createModel(json) {
  const rows = new Map(json.rows.map((r) => [r.minute, r]));
  const dist = json.cdf;
  const baseYard = json.yardstick; // { total, team }: the usual book-to-fair gap as a share of the rest-of-game standard deviation

  function coef(t) {
    const tt = Math.min(38, Math.max(2, t));
    const lo = Math.min(37, Math.floor(tt));
    const w = tt - lo;
    const a = rows.get(lo);
    const b = rows.get(lo + 1);
    const out = {};
    for (const k of Object.keys(a)) out[k] = a[k] + (b[k] - a[k]) * w;
    return out;
  }

  // Rest-of-game points for one team, and how far it is behind its pregame pace.
  function rest(c, teamTotal, oppTotal, pts, oppPts) {
    const expected = teamTotal * c.share;
    const short = expected - pts;
    const oppShort = oppTotal * c.share - oppPts;
    const lead = pts - oppPts;
    const r = c.b0 + c.b_erem * (teamTotal - expected) + c.b_short * short + c.b_oshort * oppShort
      + c.b_lead * Math.max(lead, 0) + c.b_trail * Math.max(-lead, 0)
      + c.b_lead12 * Math.max(lead - 12, 0) + c.b_trail12 * Math.max(-lead - 12, 0);
    return [Math.max(0, r), short];
  }

  /** P(standardised residual <= z), from the empirical distribution. */
  function cdf(z) {
    if (z <= dist[0][0]) return dist[0][1];
    const last = dist[dist.length - 1];
    if (z >= last[0]) return last[1];
    let i = 1;
    while (dist[i][0] < z) i += 1;
    const a = dist[i - 1];
    const b = dist[i];
    return a[1] + (b[1] - a[1]) * (z - a[0]) / (b[0] - a[0]);
  }

  /**
   * Fair finals at elapsed minute t.
   * pre = [closing total, home spread] (home spread negative when the home team is favoured).
   */
  function fair(pre, t, awayPts, homePts) {
    const homeTotal = pre[0] / 2 - pre[1] / 2;
    const awayTotal = pre[0] / 2 + pre[1] / 2;
    const c = coef(t);
    const fade = t <= 38 ? 1 : Math.max(0, (40 - t) / 2); // the last two minutes run the estimate down to the score
    const [homeRest, homeShort] = rest(c, homeTotal, awayTotal, homePts, awayPts);
    const [awayRest, awayShort] = rest(c, awayTotal, homeTotal, awayPts, homePts);
    const away = awayPts + awayRest * fade;
    const home = homePts + homeRest * fade;
    const pace = (p) => (t >= 4 ? p / c.share : null);
    return {
      away, home, total: away + home,
      awayShort, homeShort,
      paceAway: pace(awayPts), paceHome: pace(homePts), paceTotal: pace(awayPts + homePts),
      sdTeam: c.sd_team, sdTotal: c.sd_total,
      pregame: { total: pre[0], away: awayTotal, home: homeTotal },
    };
  }

  /**
   * One reading against the model. bookTotal and bookSpread are DraftKings' live total and home spread, or null.
   * Returns, per market, the line, the fair number, the edge (fair minus line) in points and in deviations (`dev`),
   * the points one deviation is worth right now (`sigma`), the chance of the over, and the signal the reading earns
   * on its own: 'buy', 'lean' or null. A buy still has to repeat (see signalsFor).
   * opts: { yard, buyDev, overPrice, underPrice }. Prices are American odds for the game total; -115 is assumed when absent.
   */
  function judge(pre, t, awayPts, homePts, bookTotal, bookSpread, opts = {}) {
    const yard = opts.yard || baseYard;
    const buyDev = opts.buyDev == null ? RULES.buyDev : opts.buyDev;
    const f = fair(pre, t, awayPts, homePts);
    const hasBook = bookTotal != null && bookSpread != null;
    const lines = hasBook ? { total: bookTotal, away: bookTotal / 2 + bookSpread / 2, home: bookTotal / 2 - bookSpread / 2 } : null;
    const eligible = t >= RULES.firstMinute && t <= RULES.lastMinute
      && Math.abs(awayPts - homePts) < RULES.blowoutLead && Math.abs(pre[1]) < RULES.blowoutSpread;
    const markets = {};
    for (const k of ['total', 'away', 'home']) {
      const m = { fair: f[k], line: null, edge: null, dev: null, sigma: (k === 'total' ? yard.total * f.sdTotal : yard.team * f.sdTeam), over: null, side: null, chance: null, price: null, signal: null };
      if (lines) {
        m.line = lines[k];
        m.edge = m.fair - m.line;
        m.over = 1 - cdf((m.line - m.fair) / (k === 'total' ? f.sdTotal : f.sdTeam));
        m.side = m.edge >= 0 ? 'Over' : 'Under';
        m.chance = m.side === 'Over' ? m.over : 1 - m.over;
        m.dev = m.edge / m.sigma;
        const quoted = k === 'total' ? (m.side === 'Over' ? opts.overPrice : opts.underPrice) : null;
        m.price = quoted == null ? -115 : quoted;
        m.quoted = quoted != null;
        const size = Math.abs(m.dev);
        if (eligible && size >= buyDev && m.chance >= breakEven(m.price) + RULES.margin) m.signal = 'buy';
        else if (eligible && size >= RULES.leanDev) m.signal = 'lean';
      }
      markets[k] = m;
    }
    return { fair: f, markets, eligible };
  }

  /**
   * Signals in a game's readings: the first time each market and side qualifies on two readings in a row.
   * opts: { yard, buyDev } to judge against another slate's yardstick or another threshold.
   * readings: [[unixSeconds, elapsedMinutes, awayPts, homePts, bookTotal, bookSpread, overPrice, underPrice], ...]
   * finals: {away, home} once the game is over, else null.
   */
  function signalsFor(pre, readings, finals, opts = {}) {
    const fired = new Set();
    const out = [];
    let prev = {};
    for (const r of readings) {
      if (r[4] == null || r[5] == null) { prev = {}; continue; }
      const j = judge(pre, r[1], r[2], r[3], r[4], r[5], { ...opts, overPrice: r[6], underPrice: r[7] });
      const cur = {};
      for (const k of ['total', 'away', 'home']) {
        const m = j.markets[k];
        if (m.signal !== 'buy') continue;
        cur[k] = m.side;
        const key = k + m.side;
        if (prev[k] !== m.side || fired.has(key)) continue;
        fired.add(key);
        const final = finals ? (k === 'total' ? finals.away + finals.home : finals[k]) : null;
        out.push({
          market: k, side: m.side, at: r[0], minute: r[1], score: `${r[2]}-${r[3]}`,
          line: m.line, fair: m.fair, edge: m.edge, dev: m.dev, sigma: m.sigma, chance: m.chance,
          price: m.price, priced: m.quoted ? 'DraftKings' : 'assumed',
          final,
          result: final == null ? 'Pending' : final === m.line ? 'Push' : (final > m.line) === (m.side === 'Over') ? 'Won' : 'Lost',
        });
      }
      prev = cur;
    }
    return out;
  }

  return { coef, cdf, fair, judge, signalsFor, yardstick: baseYard, share: (t) => (t <= 0 ? 0 : t >= 40 ? 1 : coef(t).share) };
}
