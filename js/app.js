// Cold Stretch Live: state, polling, routing and rendering.

import { createModel, RULES, clockLabel, isClockGlitch, gapStats } from './model.js';
import { urls, getJSON, parseEvent, parseOdds, parseSummary } from './espn.js';
import { rangePlot, histogram, gameChart, fmt } from './charts.js';

const { f1, signed } = fmt;
const $ = (s) => document.querySelector(s);
const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

const POLL_MS = 20000;
const RECORDED_EVERY = 9; // polls between reloads of the recorder's files
// Recorded tracks live on the repo's `data` branch. ?data=<url> overrides, for local work.
const DATA = (() => {
  const q = new URLSearchParams(location.search).get('data');
  if (q) return q.replace(/\/?$/, '/');
  const m = location.hostname.match(/^(.+)\.github\.io$/);
  const repo = location.pathname.split('/')[1];
  return m && repo ? `https://raw.githubusercontent.com/${m[1]}/${repo}/data/` : 'data/';
})();

// ESPN files a late tip under the Eastern date it started on, so a slate rolls over at 5 AM Eastern.
const slateOf = (ms) => new Date(ms - 10 * 36e5).toISOString().slice(0, 10).replace(/-/g, '');
const toUTC = (d) => Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8));
const shiftDay = (d, n) => new Date(toUTC(d) + n * 864e5).toISOString().slice(0, 10).replace(/-/g, '');
const dayLabel = (d) => new Date(toUTC(d)).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const timeLabel = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const today = () => slateOf(Date.now());

const S = {
  view: 'board', date: today(), sel: null, market: 'total', only: false, cursor: -1,
  games: new Map(), recorded: new Map(), recordedAt: null, ledger: [], index: [],
  model: null, scoresAt: 0, error: null, polls: 0, busy: false, memo: new Map(), histKey: null,
};
const isToday = () => S.date === today();

/* ---------- storage: this browser's own readings survive a reload ---------- */
const store = {
  key: (d) => `csl.readings.${d}`,
  load(d) { try { return JSON.parse(localStorage.getItem(this.key(d)) || '{}'); } catch { return {}; } },
  save() {
    try {
      const out = {};
      for (const g of S.games.values()) if (g.r.length) out[g.id] = g.r.slice(-400);
      localStorage.setItem(this.key(S.date), JSON.stringify(out));
      const keep = new Set([0, -1, -2].map((n) => this.key(shiftDay(today(), n))));
      for (let i = localStorage.length - 1; i >= 0; i -= 1) { const k = localStorage.key(i); if (k && k.startsWith('csl.readings.') && !keep.has(k)) localStorage.removeItem(k); }
    } catch { /* private mode or full: the page works without it */ }
  },
};

/* ---------- data ---------- */
async function loadBoard() {
  const date = S.date;
  const d = await getJSON(urls.board(date));
  if (date !== S.date) return;
  const saved = S.games.size ? null : store.load(date);
  const seen = new Set();
  for (const e of d.events || []) {
    const n = parseEvent(e);
    if (!n) continue;
    const g = S.games.get(n.id) || { r: (saved && saved[n.id]) || [], timeline: null, timelineAt: 0, pre: null, live: null };
    Object.assign(g, n);
    if (!g.pre && n.boardPre) g.pre = n.boardPre;
    S.games.set(n.id, g);
    seen.add(n.id);
  }
  for (const k of [...S.games.keys()]) if (!seen.has(k)) S.games.delete(k);
  S.scoresAt = Date.now();
  S.error = null;
}

async function loadOdds(g) {
  const o = parseOdds(await getJSON(urls.odds(g.id), { retries: 0 }));
  if (o.pre) g.pre = o.pre;
  if (g.state !== 'in') return;
  g.live = o.live ? { ...o.live, at: Date.now() } : null;
  if (g.period > 2) return; // overtime: the model stops at 40 minutes
  const reading = [Math.round(Date.now() / 1000), Number(g.minute.toFixed(2)), g.away.pts, g.home.pts,
    o.live ? o.live.total : null, o.live ? o.live.spread : null, o.live ? o.live.over : null, o.live ? o.live.under : null];
  const last = g.r[g.r.length - 1];
  if (isClockGlitch(last, reading)) return;
  if (!last || reading.slice(1).join() !== last.slice(1).join()) g.r.push(reading);
}

async function inBatches(items, size, fn) {
  const queue = items.slice();
  await Promise.all(Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) { const it = queue.shift(); try { await fn(it); } catch { /* one game failing must not stop the rest */ } }
  }));
}

async function loadRecorded() {
  const minute = Math.floor(Date.now() / 60000);
  try {
    const d = await getJSON(`${DATA}tracks/${S.date}.json?_=${minute}`, { retries: 0 });
    S.recorded = new Map((d.games || []).map((g) => [String(g.id), g]));
    S.recordedAt = d.updated || null;
  } catch { S.recorded = new Map(); S.recordedAt = null; }
  try { S.ledger = await getJSON(`${DATA}ledger.json?_=${minute}`, { retries: 0 }); } catch { S.ledger = []; }
  try { S.index = await getJSON(`${DATA}index.json?_=${minute}`, { retries: 0 }); } catch { S.index = []; }
}

async function loadTimeline(g) {
  const s = parseSummary(await getJSON(urls.summary(g.id)));
  g.timeline = s.timeline;
  g.timelineAt = Date.now();
  if (!g.pre && s.pre) g.pre = s.pre;
}

const preOf = (g) => g.pre || (S.recorded.get(g.id) || {}).pre || null;

/** The recorder's readings and this browser's, merged on time, with clock glitches dropped. */
function readingsOf(g) {
  const rec = (S.recorded.get(g.id) || {}).r || [];
  const all = rec.concat(g.r).filter((r) => r[4] != null && r[5] != null).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const r of all) { const last = out[out.length - 1]; if (!last || (r[0] - last[0] >= 20 && !isClockGlitch(last, r))) out.push(r); }
  return out;
}

/** Where a live game stands right now: the model's view, and whether a buy has held for two readings. */
function standing(g) {
  const pre = preOf(g);
  if (!pre || !S.model) return null;
  const fresh = g.state === 'in' && g.live && Date.now() - g.live.at < RULES.staleMs;
  const j = S.model.judge(pre, g.minute, g.away.pts, g.home.pts, fresh ? g.live.total : null, fresh ? g.live.spread : null);
  const prior = g.r.length > 1 ? g.r[g.r.length - 2] : null;
  const before = prior && prior[4] != null && g.r[g.r.length - 1][0] - prior[0] < 150 ? S.model.judge(pre, prior[1], prior[2], prior[3], prior[4], prior[5]) : null;
  let best = null;
  for (const k of ['total', 'away', 'home']) {
    const m = j.markets[k];
    m.confirmed = m.signal === 'buy' && !!before && before.markets[k].signal === 'buy' && before.markets[k].side === m.side;
    const weight = m.signal === 'buy' ? (m.confirmed ? 3 : 2) : m.signal === 'lean' ? 1 : 0;
    if (weight && (!best || weight > best.weight || (weight === best.weight && m.chance > best.chance))) best = { ...m, key: k, weight };
  }
  return { ...j, pre, fresh, best };
}

/** The status column: a signal, or the plain reason there cannot be one. */
function word(g, st) {
  if (g.state === 'post') return [`Total ${g.away.pts + g.home.pts}`, ''];
  if (!st) return ['No pregame line', ''];
  if (!st.fresh) return [g.live ? 'Line is stale' : 'No live line', ''];
  const b = st.best, where = b && b.key !== 'total' ? `, ${g[b.key].abbr}` : '';
  if (b && b.weight === 3) return [`${b.side}${where}`, b.side === 'Over' ? 'is-over' : 'is-under'];
  if (Math.abs(st.pre[1]) >= RULES.blowoutSpread) return [`Spread over ${RULES.blowoutSpread}`, ''];
  if (g.minute < RULES.firstMinute) return [`Before minute ${RULES.firstMinute}`, ''];
  if (g.minute > RULES.lastMinute) return [`Past minute ${RULES.lastMinute}`, ''];
  if (Math.abs(g.away.pts - g.home.pts) >= RULES.blowoutLead) return [`Lead over ${RULES.blowoutLead}`, ''];
  if (b && b.weight === 2) return [`${b.side}${where}, if it holds`, 'is-live'];
  if (b) return [`Lean ${b.side.toLowerCase()}${where}`, 'is-live'];
  return ['In window', 'is-live'];
}

/* ---------- routing ---------- */
function route() {
  const [view, a, b, c] = location.hash.replace(/^#\/?/, '').split('/');
  if (view === 'game') return { view: 'game', date: /^\d{8}$/.test(a || '') ? a : S.date, sel: b || S.sel, market: ['total', 'away', 'home'].includes(c) ? c : S.market };
  if (view === 'record') return { view: 'record', date: S.date };
  return { view: 'board', date: /^\d{8}$/.test(a || '') ? a : S.view === 'board' ? today() : S.date };
}
function go(hash) { if (location.hash === hash) applyRoute(); else location.hash = hash; }
const boardHash = (d) => (d === today() ? '#/board' : `#/board/${d}`);
const gameHash = (id, market = S.market, date = S.date) => `#/game/${date}/${id}/${market}`;

async function applyRoute() {
  const r = route();
  const dateChanged = r.date !== S.date;
  Object.assign(S, { view: r.view, date: r.date, sel: r.sel || (r.view === 'game' ? S.sel : null), market: r.market || S.market });
  if (dateChanged) { S.games.clear(); S.recorded = new Map(); S.cursor = -1; S.histKey = null; }
  for (const b of document.querySelectorAll('.nav button')) b.toggleAttribute('aria-current', false);
  const cur = $(`.nav button[data-view="${S.view}"]`); if (cur) cur.setAttribute('aria-current', 'page');
  for (const v of ['board', 'game', 'record']) $(`#view-${v}`).hidden = v !== S.view;
  render();
  if (dateChanged || !S.games.size) await refresh(true);
  if (S.view === 'game') openSelected();
  window.scrollTo(0, 0);
}

async function openSelected() {
  const g = S.games.get(S.sel);
  if (!g) return;
  const jobs = [];
  if (!g.timeline || (g.state === 'in' && Date.now() - g.timelineAt > 60000)) jobs.push(loadTimeline(g));
  if (!g.pre || (g.state === 'in' && isToday())) jobs.push(loadOdds(g));
  if (!jobs.length) return;
  await Promise.all(jobs.map((p) => p.catch(() => {})));
  if (S.view === 'game' && S.sel === g.id) renderGame();
}

/* ---------- board ---------- */
/** Book against fair at every reading of a game: the series behind the range plot, the histogram and the lead. */
function series(g) {
  if (S.memo.has(g.id)) return S.memo.get(g.id);
  const pre = preOf(g);
  const out = pre && S.model ? readingsOf(g).filter((r) => r[1] >= 2 && r[1] <= 40).map((r) => { const m = S.model.judge(pre, r[1], r[2], r[3], r[4], r[5]).markets.total; return { t: r[1], gap: m.edge, book: m.line, fair: m.fair, over: m.over }; }) : [];
  S.memo.set(g.id, out);
  return out;
}

const clockText = (g) => (g.state === 'post' ? 'Final' : g.detail.replace(' - ', ' ').replace('Halftime', 'Half'));

function teamLine(t, other, played) {
  const row = h('span', `tm${played && t.pts > other.pts ? ' is-ahead' : ''}`), nm = h('span', 'nm');
  nm.append(document.createTextNode(t.name));
  if (t.rank) nm.append(h('span', 'rk', String(t.rank)));
  row.append(nm, h('span', 'pt', played ? t.pts : ''));
  return row;
}

function standRow(g, i) {
  const st = g.state === 'in' ? standing(g) : null, s = series(g), last = s[s.length - 1] || null;
  const m = st && st.fresh && st.markets.total.line != null ? st.markets.total : null;
  const now = m ? { gap: m.edge, book: m.line, fair: m.fair, over: m.over } : last;
  const [text, cls] = word(g, st);
  const row = h('a', `stand-row${g.state === 'post' ? ' is-final' : ''}${i === S.cursor ? ' is-cursor' : ''}`);
  row.href = gameHash(g.id, st && st.best ? st.best.key : 'total');
  row.dataset.id = g.id;
  const game = h('span', 'c-game'); game.append(teamLine(g.away, g.home, true), teamLine(g.home, g.away, true));
  const gaps = s.map((p) => p.gap).concat(now ? [now.gap] : []);
  const plot = h('span', 'c-plot');
  plot.append(rangePlot({ gap: now ? now.gap : null, lo: gaps.length ? Math.min(...gaps) : null, hi: gaps.length ? Math.max(...gaps) : null, signal: !!(st && st.best && st.best.weight === 3 && st.best.key === 'total'), threshold: RULES.buyEdge }));
  const nums = h('span', 'c-nums');
  const num = (label, value, kind) => { const c = h('span', `c-num ${kind}`, value); c.dataset.l = label; return c; };
  nums.append(num('Book', now ? f1(now.book) : '–', 'book'), num('Fair', now ? f1(now.fair) : '–', 'fair'), num('Gap', now ? signed(now.gap) : '–', 'gap'), num('Over', now && now.over != null ? `${Math.round(now.over * 100)}%` : '–', 'over'));
  row.append(game, h('span', 'c-clock', clockText(g)), plot, nums, h('span', `c-status ${cls}`, text));
  return row;
}

const heat = (g) => { const st = standing(g); if (!st) return -1; const big = Math.max(...['total', 'away', 'home'].map((k) => Math.abs(st.markets[k].edge || 0))); return (st.best ? st.best.weight * 100 : 0) + (st.eligible ? 50 : 0) + big; };

/** The rows of the board, in order: live games with a line by how much is going on, then finished games whose line was recorded. */
function standGames() {
  const all = [...S.games.values()];
  const live = all.filter((g) => g.state === 'in' && preOf(g)).sort((a, b) => heat(b) - heat(a));
  if (S.only) return live.filter((g) => { const st = standing(g); return st && st.best; });
  const done = all.filter((g) => g.state === 'post' && series(g).length).sort((a, b) => Math.abs(series(b).at(-1).gap) - Math.abs(series(a).at(-1).gap));
  return live.concat(done);
}

function schedRow(g, right) {
  const b = h('button'); b.type = 'button';
  const who = `${g.away.rank ? g.away.rank + ' ' : ''}${g.away.name} at ${g.home.rank ? g.home.rank + ' ' : ''}${g.home.name}`;
  b.append(h('span', 'when', g.state === 'pre' ? timeLabel(g.start) : 'Final'), h('span', 'who', who), h('span', 'what', right));
  b.addEventListener('click', () => go(gameHash(g.id, 'total')));
  return b;
}

/** The slate in one finding: how far the book ran from fair, which way it missed, and whether anything held. */
function renderLead(all) {
  const gaps = [], plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  let signals = 0, measured = 0;
  for (const g of all) {
    const s = series(g).filter((p) => p.t >= RULES.measureFrom && p.t <= RULES.measureTo);
    if (!s.length) continue;
    measured += 1;
    for (const p of s) gaps.push(p.gap);
    const pre = preOf(g);
    if (Math.abs(pre[1]) < RULES.blowoutSpread) signals += S.model.signalsFor(pre, readingsOf(g), g.state === 'post' ? { away: g.away.pts, home: g.home.pts } : null).length;
  }
  const st = gapStats(gaps, RULES.buyEdge), live = all.filter((g) => g.state === 'in').length, ahead = all.filter((g) => g.state === 'pre').sort((a, b) => new Date(a.start) - new Date(b.start));
  let head, sub;
  if (!S.scoresAt) [head, sub] = ['Loading the slate.', ''];
  else if (!st.n && !all.length) [head, sub] = ['No games on this date.', ''];
  else if (!st.n && isToday() && live) [head, sub] = [`${plural(live, 'game')} in progress. The first lines are coming in.`, 'The figures fill in as DraftKings posts live totals. Each game is measured from minute 4.'];
  else if (!st.n && ahead.length && !all.some((g) => g.state === 'post')) [head, sub] = [`${plural(ahead.length, 'game')} on the slate. The first tips at ${timeLabel(ahead[0].start)}.`, 'The board fills in at tip-off. Each game is measured from minute 4.'];
  else if (!st.n && isToday() && ahead.length) [head, sub] = [`${plural(ahead.length, 'game')} still to tip. The next is at ${timeLabel(ahead[0].start)}.`, 'No live line has been recorded yet today. Each game is measured from minute 4.'];
  else if (!st.n) [head, sub] = ['No live lines were recorded for this slate.', 'ESPN drops the live line at the final whistle, so a slate can only be measured while the recorder is running.'];
  else {
    const when = isToday() ? 'today' : `on ${new Date(toUTC(S.date)).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })}`;
    const lean = st.high >= 3 && st.high >= 2 * st.low ? ' When it missed, it was mostly too high.' : st.low >= 3 && st.low >= 2 * st.high ? ' When it missed, it was mostly too low.' : st.high + st.low < 3 ? ' It rarely missed by much.' : ' It missed in both directions.';
    head = `DraftKings’ live total ${isToday() ? 'has sat' : 'sat'} ${st.abs.toFixed(1)} points from fair ${when}.${lean}`;
    sub = `A cold-stretch buy needs the book to be too low. That was true on ${st.low.toFixed(1)}% of ${plural(st.n, 'reading')}. ${signals ? `${plural(signals, 'signal')} held for two readings in a row.` : 'No gap has held for two readings in a row, so the record for this slate is empty.'}`;
  }
  $('#lead-head').textContent = head;
  $('#lead-sub').textContent = sub; $('#lead-sub').hidden = !sub;
  $('#fig-abs').textContent = st.n ? st.abs.toFixed(1) : '–';
  $('#fig-low').textContent = st.n ? `${st.low.toFixed(1)}%` : '–';
  $('#fig-high').textContent = st.n ? `${st.high.toFixed(1)}%` : '–';
  $('#fig-sig').textContent = st.n ? String(signals) : '–';
  $('#hist-title').textContent = st.n ? `All ${plural(st.n, 'reading')}` : 'All readings';
  $('#hist-note').textContent = st.n ? `Every recorded line between minute ${RULES.measureFrom} and minute ${RULES.measureTo}, across ${plural(measured, 'game')}.` : 'The distribution fills in as lines are recorded.';
  return gaps;
}

/** Drawn last, once the layout around it has settled, so the chart is built at the width it will be shown at. */
function renderHistogram(gaps) {
  const host = $('#hist'), key = `${S.date}:${gaps.length}:${host.clientWidth}`;
  if (!gaps.length) { host.replaceChildren(); S.histKey = null; return; }
  if (S.histKey === key) return;
  histogram(host, gaps, { threshold: RULES.buyEdge });
  S.histKey = key;
}

function renderBoard() {
  $('#day').textContent = dayLabel(S.date);
  $('#only').setAttribute('aria-pressed', String(S.only));
  const all = [...S.games.values()], nLive = all.filter((g) => g.state === 'in').length, rows = standGames();
  const gaps = renderLead(all);
  $('#stand-rows').replaceChildren(...rows.map(standRow));
  $('#stand').hidden = !rows.length;
  const unlined = all.filter((g) => g.state === 'in' && !preOf(g)).length;
  $('#board-unlined').hidden = !unlined || S.only;
  $('#board-unlined').textContent = `${unlined} more in progress with no DraftKings line, so nothing to measure.`;
  const empty = $('#board-empty');
  empty.hidden = rows.length > 0;
  empty.textContent = !S.scoresAt ? 'Loading the scoreboard.' : S.only ? 'No signals right now. An empty board is a valid result.' : nLive ? 'Games are in progress, but none has a DraftKings line yet.' : isToday() ? 'No games in progress. The board fills in at tip-off.' : 'No lines were recorded on this date.';
  const next = all.filter((g) => g.state === 'pre').sort((a, b) => new Date(a.start) - new Date(b.start));
  $('#next-rows').replaceChildren(...next.map((g) => schedRow(g, g.pre ? `${g.pre[0]}, ${g.pre[1] <= 0 ? g.home.abbr : g.away.abbr} by ${Math.abs(g.pre[1])}` : 'No line')));
  $('#next').hidden = !next.length;
  const done = all.filter((g) => g.state === 'post' && !series(g).length);
  $('#final-rows').replaceChildren(...done.map((g) => schedRow(g, `${g.away.pts}–${g.home.pts}`)));
  $('#finals-sum').textContent = `${done.length} finished game${done.length === 1 ? '' : 's'} with no line recorded`;
  $('#finals').hidden = !done.length;
  renderHistogram(gaps);
}

/* ---------- game ---------- */
function sentence(g, st, k, book) {
  const pre = preOf(g);
  if (!pre) return ['DraftKings posted no line for this game, so there is no pace to measure it against.', ''];
  if (g.state === 'pre') return [`Tips at ${timeLabel(g.start)}. DraftKings has the total at ${pre[0]} and ${pre[1] <= 0 ? g.home.name : g.away.name} by ${Math.abs(pre[1])}.`, ''];
  const name = k === 'total' ? 'the total' : `${g[k].name}’s team total`;
  if (g.state === 'post') {
    const final = k === 'total' ? g.away.pts + g.home.pts : g[k].pts;
    const preK = k === 'total' ? pre[0] : k === 'away' ? pre[0] / 2 + pre[1] / 2 : pre[0] / 2 - pre[1] / 2;
    return [`Final ${final} against a pregame ${f1(preK)}. ${book.length ? `The live line was recorded ${book.length} times.` : 'The live line was not recorded. ESPN drops it at the final whistle.'}`, ''];
  }
  const m = st.markets[k];
  if (!st.fresh || m.line == null) return ['DraftKings is not showing a live line right now. No read without a fresh line.', ''];
  const gap = `${f1(Math.abs(m.edge))} ${m.edge >= 0 ? 'low' : 'high'}`;
  const lead = `DraftKings has ${name} at ${f1(m.line)}${k === 'total' ? '' : ' (implied)'}. Fair is ${f1(m.fair)}, so the book is ${gap}.`;
  if (m.signal === 'buy' && m.confirmed) return [`${lead} The ${m.side.toLowerCase()} has a ${Math.round(m.chance * 100)}% chance. Signal: ${m.side.toLowerCase()}.`, m.side === 'Over' ? 'is-over' : 'is-under'];
  if (m.signal === 'buy') return [`${lead} The ${m.side.toLowerCase()} has a ${Math.round(m.chance * 100)}% chance. It becomes a signal if the next reading agrees.`, ''];
  if (m.signal === 'lean') return [`${lead} Leaning ${m.side.toLowerCase()} at ${Math.round(m.chance * 100)}%, short of a signal.`, ''];
  if (!st.eligible) {
    const why = g.minute < RULES.firstMinute ? `before minute ${RULES.firstMinute}` : g.minute > RULES.lastMinute ? `after minute ${RULES.lastMinute}` : Math.abs(st.pre[1]) >= RULES.blowoutSpread ? `on a ${RULES.blowoutSpread}-point spread` : `at a ${RULES.blowoutLead}-point lead`;
    return [`${lead} No signals ${why}.`, ''];
  }
  return [`${lead} That is inside the model’s noise.`, ''];
}

function renderGame() {
  const g = S.games.get(S.sel);
  $('#back').href = boardHash(S.date);
  $('#game-none').hidden = !!g;
  $('#game-body').hidden = !g;
  if (!g) { $('#game-none').textContent = S.sel && !S.scoresAt ? 'Loading the game.' : 'Pick a game from the board.'; return; }
  const k = S.market, pre = preOf(g), st = standing(g), book = readingsOf(g);
  const side = (id, t, short) => {
    const tm = h('div', 'tm'); if (t.rank) tm.append(h('span', 'rk', String(t.rank))); tm.append(document.createTextNode(t.name));
    $(id).replaceChildren(tm, h('div', 'beh', short == null || g.state === 'pre' ? '' : short >= 0 ? `${f1(short)} behind pace` : `${f1(-short)} ahead of pace`));
  };
  side('#side-away', g.away, st ? st.fair.awayShort : null);
  side('#side-home', g.home, st ? st.fair.homeShort : null);
  $('#pts-away').textContent = g.state === 'pre' ? '–' : g.away.pts;
  $('#pts-home').textContent = g.state === 'pre' ? '–' : g.home.pts;
  const [c1, c2] = g.state === 'pre' ? [timeLabel(g.start), dayLabel(S.date)] : g.state === 'post' ? ['Final', dayLabel(S.date)] : g.detail.split(' - ');
  $('#clock').replaceChildren(h('b', '', c1), document.createTextNode(c2 || ''));
  for (const b of document.querySelectorAll('#markets button')) b.setAttribute('aria-pressed', String(b.dataset.market === k));
  $('#mk-away').textContent = g.away.name; $('#mk-home').textContent = g.home.name;
  $('#lg-away').textContent = g.away.name; $('#lg-home').textContent = g.home.name;
  const [text, cls] = sentence(g, st, k, book);
  $('#read').textContent = text; $('#read').className = `read ${cls}`;

  const m = st ? st.markets[k] : null;
  const lastRec = pre && book.length && S.model ? S.model.judge(pre, ...book[book.length - 1].slice(1, 6)).markets[k] : null;
  const shown = g.state === 'in' && m && m.line != null ? m : g.state !== 'pre' ? lastRec : null;
  const preK = pre ? (k === 'total' ? pre[0] : k === 'away' ? pre[0] / 2 + pre[1] / 2 : pre[0] / 2 - pre[1] / 2) : null;
  const lastLine = g.state === 'post' ? ', last line' : '';
  $('#f-book-l').textContent = (k === 'total' ? 'DraftKings live' : 'DraftKings, implied') + lastLine;
  $('#f-fair-l').textContent = g.state === 'post' ? 'Fair, at that reading' : 'Fair';
  $('#f-book').textContent = shown ? f1(shown.line) : '–';
  $('#f-fair').textContent = g.state === 'pre' ? f1(preK) : g.state === 'post' ? (lastRec ? f1(lastRec.fair) : '–') : m ? f1(m.fair) : '–';
  $('#f-gap').textContent = shown ? signed(shown.edge) : '–';
  $('#f-gap').className = shown && Math.abs(shown.edge) >= RULES.buyEdge ? (shown.edge > 0 ? 'is-over' : 'is-under') : '';
  $('#f-over').textContent = g.state === 'in' && m && m.over != null ? `${Math.round(m.over * 100)}%` : '–';
  $('#f-pre').textContent = f1(preK);
  const paceK = st && g.state === 'in' ? (k === 'total' ? st.fair.paceTotal : k === 'away' ? st.fair.paceAway : st.fair.paceHome) : null;
  $('#f-pace').textContent = f1(paceK);
  for (const id of ['#f-over', '#f-pace']) $(id).parentElement.hidden = g.state !== 'in';

  const host = $('#chart'), scrub = $('#scrub');
  const tl = (g.timeline || [{ t: 0, a: 0, h: 0 }]).filter((p) => p.t <= 40).slice();
  for (const r of g.r) { const last = tl[tl.length - 1]; if (r[1] > last.t && r[1] <= 40 && (r[2] !== last.a || r[3] !== last.h)) tl.push({ t: r[1], a: r[2], h: r[3] }); }
  if (g.state === 'in' && g.minute <= 40 && g.minute > tl[tl.length - 1].t) tl.push({ t: g.minute, a: g.away.pts, h: g.home.pts });
  if (!pre || !S.model || (tl.length < 2 && !book.length)) {
    host.replaceChildren(h('p', 'vacant', !pre ? 'No chart without a pregame line.' : g.state === 'pre' ? 'The chart starts at tip-off.' : 'Loading the play-by-play.'));
    scrub.textContent = ''; $('#sig-rows').replaceChildren(); $('#sig-none').hidden = false; $('#sig-sheet').hidden = true; return;
  }
  const paceKey = k === 'total' ? 'paceTotal' : k === 'away' ? 'paceAway' : 'paceHome';
  const fairPts = [], pacePts = [];
  for (const p of tl) { if (p.t < 2) continue; const f = S.model.fair(pre, p.t, p.a, p.h); fairPts.push({ t: p.t, v: f[k] }); if (f[paceKey] != null && p.t >= 6) pacePts.push({ t: p.t, v: f[paceKey] }); }
  const bookPts = book.filter((r) => r[1] >= 2 && r[1] <= 40).map((r) => { const j = S.model.judge(pre, r[1], r[2], r[3], r[4], r[5]).markets[k]; return { t: r[1], v: j.line, fair: j.fair }; });
  const finals = g.state === 'post' ? { away: g.away.pts, home: g.home.pts } : null;
  const signals = S.model.signalsFor(pre, book, finals);
  const share = [[0, 0]]; for (let t = 2; t <= 38; t += 1) share.push([t, S.model.share(t)]); share.push([40, 1]);
  const idle = () => { scrub.textContent = 'Drag across the chart to read any minute.'; };
  gameChart(host, {
    pregame: preK, preAway: pre[0] / 2 + pre[1] / 2, preHome: pre[0] / 2 - pre[1] / 2, final: finals ? (k === 'total' ? finals.away + finals.home : finals[k]) : null,
    fair: fairPts, pace: pacePts, book: bookPts, flow: tl, share, signals: signals.filter((s) => s.market === k), awayName: g.away.name, homeName: g.home.name,
    onScrub(p) {
      if (!p) { idle(); return; }
      scrub.replaceChildren(h('b', '', `${clockLabel(p.t)}  ${p.a}-${p.h}`));
      if (p.book != null) scrub.append(h('b', 'v-book', `Book ${f1(p.book)}`));
      if (p.fair != null) scrub.append(h('b', 'v-fair', `Fair ${f1(p.fair)}`));
      if (p.book != null && p.fair != null) scrub.append(h('b', '', `Gap ${signed(p.fair - p.book)}`));
      if (p.pace != null) scrub.append(document.createTextNode(`Pace ${f1(p.pace)}`));
    },
  });
  idle();
  const label = (s) => (s.market === 'total' ? 'Game total' : `${g[s.market].name} team total`);
  $('#sig-rows').replaceChildren(...signals.map((s) => {
    const tr = document.createElement('tr');
    for (const [v, c] of [[label(s)], [s.side], [clockLabel(s.minute)], [s.score], [f1(s.line), 'r'], [f1(s.fair), 'r'], [`${Math.round(s.chance * 100)}%`, 'r'], [s.final == null ? '' : s.final, 'r'], [s.result, s.result === 'Won' ? 'won' : s.result === 'Lost' ? 'lost' : '']]) tr.append(h('td', c || '', v));
    return tr;
  }));
  $('#sig-none').hidden = signals.length > 0;
  $('#sig-sheet').hidden = !signals.length;
}

/* ---------- record ---------- */
function renderRecord() {
  const L = S.ledger.slice().sort((a, b) => b.ts - a.ts);
  const tally = (rows) => { const w = rows.filter((s) => s.result === 'Won').length, l = rows.filter((s) => s.result === 'Lost').length; return w + l ? `${w}–${l}` : '–'; };
  const settled = L.filter((s) => s.result === 'Won' || s.result === 'Lost');
  const units = settled.reduce((u, s) => u + (s.result === 'Won' ? (s.price > 0 ? s.price / 100 : 100 / -s.price) : -1), 0);
  const won = settled.filter((s) => s.result === 'Won').length, open = L.length - settled.length;
  $('#rec-head').textContent = !L.length ? 'No signal has fired yet.' : `${L.length} signal${L.length === 1 ? '' : 's'} so far: ${won} won, ${settled.length - won} lost${open ? `, ${open} still open` : ''}.`;
  document.querySelector('.sums').hidden = !L.length;
  $('#r-all').textContent = tally(L);
  $('#r-units').textContent = settled.length ? signed(units) : '–';
  $('#r-units').className = settled.length && units > 0 ? 'is-over' : settled.length && units < 0 ? 'is-under' : '';
  $('#r-over').textContent = tally(L.filter((s) => s.side === 'Over'));
  $('#r-under').textContent = tally(L.filter((s) => s.side === 'Under'));
  $('#days-rows').replaceChildren(...S.index.slice().reverse().map((d) => {
    const tr = document.createElement('tr'); tr.tabIndex = 0;
    for (const [v, c] of [[dayLabel(d.date)], [d.games, 'r'], [d.total_readings == null ? d.readings : d.total_readings, 'r'], [d.gap_abs == null ? '–' : d.gap_abs.toFixed(1), 'r'], [d.below == null ? '–' : `${d.below}%`, 'r'], [d.above == null ? '–' : `${d.above}%`, 'r']]) tr.append(h('td', c || '', v));
    const open = () => go(boardHash(d.date));
    tr.addEventListener('click', open); tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    return tr;
  }));
  $('#days-none').hidden = S.index.length > 0; $('#days-sheet').hidden = !S.index.length;
  $('#ledger-rows').replaceChildren(...L.map((s) => {
    const tr = document.createElement('tr'); tr.tabIndex = 0;
    const price = `${s.price > 0 ? '+' : ''}${s.price}${s.priced === 'Assumed' ? ' est.' : ''}`;
    for (const [v, c] of [[dayLabel(s.date)], [s.matchup], [s.market], [s.side], [clockLabel(s.t)], [s.score], [f1(s.line), 'r'], [price, 'r'], [f1(s.fair), 'r'], [`${s.chance}%`, 'r'], [s.final == null ? '' : s.final, 'r'], [s.result, s.result === 'Won' ? 'won' : s.result === 'Lost' ? 'lost' : '']]) tr.append(h('td', c || '', v));
    const open = () => go(gameHash(s.game, s.mkt, s.date));
    tr.addEventListener('click', open); tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    return tr;
  }));
  $('#ledger-none').hidden = L.length > 0; $('#ledger-sheet').hidden = !L.length;
}

/* ---------- loop ---------- */
function renderPulse() {
  const p = $('#pulse'), live = [...S.games.values()].filter((g) => g.state === 'in').length;
  p.classList.toggle('is-down', !!S.error);
  if (S.error) { p.replaceChildren(h('b', '', 'ESPN is not responding'), document.createTextNode(` (${S.error}). Retrying.`)); return; }
  if (!S.scoresAt) { p.textContent = 'Loading'; return; }
  const age = Math.max(0, Math.round((Date.now() - S.scoresAt) / 1000));
  const rec = S.recordedAt ? `, recorder ${Math.max(0, Math.round((Date.now() / 1000 - S.recordedAt) / 60))} min ago` : '';
  p.replaceChildren(h('b', '', isToday() ? `${live} live` : dayLabel(S.date)), document.createTextNode(`, scores ${age}s ago`), h('span', 'wide', rec));
}
function render() { S.memo.clear(); renderPulse(); if (S.view === 'board') renderBoard(); if (S.view === 'game') renderGame(); if (S.view === 'record') renderRecord(); }

async function refresh(force) {
  if (S.busy && !force) return;
  S.busy = true;
  try {
    await loadBoard();
    if (isToday()) await inBatches([...S.games.values()].filter((g) => g.state === 'in'), 6, loadOdds);
    if (force || S.polls % RECORDED_EVERY === 0) await loadRecorded();
    const sel = S.games.get(S.sel);
    if (sel && S.view === 'game' && sel.state === 'in' && Date.now() - sel.timelineAt > 90000) await loadTimeline(sel).catch(() => {});
    S.polls += 1;
    if (S.polls % 3 === 0) store.save();
  } catch (err) { S.error = err.message || 'error'; }
  S.busy = false;
  render();
}

/* ---------- wiring ---------- */
for (const b of document.querySelectorAll('.nav button')) b.addEventListener('click', () => go(b.dataset.view === 'board' ? boardHash(S.date) : b.dataset.view === 'record' ? '#/record' : S.sel ? gameHash(S.sel) : '#/game'));
for (const b of document.querySelectorAll('#markets button')) b.addEventListener('click', () => go(gameHash(S.sel, b.dataset.market)));
$('#prev').addEventListener('click', () => go(boardHash(shiftDay(S.date, -1))));
$('#next-day').addEventListener('click', () => go(boardHash(shiftDay(S.date, 1))));
$('#today').addEventListener('click', () => go(boardHash(today())));
$('#only').addEventListener('click', () => { S.only = !S.only; renderBoard(); });
window.addEventListener('hashchange', applyRoute);
let resizeTimer = 0;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (S.view === 'game') renderGame(); if (S.view === 'board') renderBoard(); }, 120); });
document.addEventListener('visibilitychange', () => { if (document.hidden) store.save(); else refresh(); });
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  if (S.view === 'board') {
    const rows = standGames();
    if (e.key === 'j' || e.key === 'ArrowDown') { S.cursor = Math.min(rows.length - 1, S.cursor + 1); renderBoard(); e.preventDefault(); }
    else if (e.key === 'k' || e.key === 'ArrowUp') { S.cursor = Math.max(0, S.cursor - 1); renderBoard(); e.preventDefault(); }
    else if (e.key === 'Enter' && rows[S.cursor] && e.target === document.body) go(gameHash(rows[S.cursor].id, 'total', S.date));
    else if (e.key === '[') go(boardHash(shiftDay(S.date, -1)));
    else if (e.key === ']') go(boardHash(shiftDay(S.date, 1)));
    else if (e.key === 't') go(boardHash(today()));
    else if (e.key === 's') { S.only = !S.only; renderBoard(); }
  } else if (S.view === 'game') {
    const mk = { 1: 'total', 2: 'away', 3: 'home' }[e.key];
    if (mk && S.sel) go(gameHash(S.sel, mk));
    else if (e.key === 'Escape' || e.key === 'b') go(boardHash(S.date));
  }
});

(async () => {
  try { S.model = createModel(await getJSON('model.json')); } catch { $('#pulse').textContent = 'Could not load the model file.'; return; }
  await applyRoute();
  setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
  setInterval(renderPulse, 5000);
})();
