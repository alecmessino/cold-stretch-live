// Cold Stretch Live: state, polling, routing and rendering.

import { createModel, RULES, clockLabel, isClockGlitch } from './model.js';
import { urls, getJSON, parseEvent, parseOdds, parseSummary } from './espn.js';
import { gapBar, spark, gameChart, fmt } from './charts.js';

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
  model: null, scoresAt: 0, error: null, polls: 0, busy: false,
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

function word(g, st) {
  if (!st) return ['No pregame line', 'is-off'];
  if (!st.fresh) return [g.live ? 'Line is stale' : 'No live line', 'is-off'];
  const b = st.best;
  if (b && b.weight === 3) return [b.side === 'Over' ? 'Over' : 'Under', b.side === 'Over' ? 'is-over' : 'is-under'];
  if (b) return [`Lean ${b.side.toLowerCase()}`, 'is-lean'];
  if (Math.abs(g.away.pts - g.home.pts) >= RULES.blowoutLead || Math.abs(st.pre[1]) >= RULES.blowoutSpread) return ['Blowout', 'is-off'];
  if (g.minute < RULES.firstMinute) return ['Too early', 'is-off'];
  if (g.minute > RULES.lastMinute) return ['Too late', 'is-off'];
  return ['In line', 'is-off'];
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
  if (dateChanged) { S.games.clear(); S.recorded = new Map(); S.cursor = -1; }
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
function teamCell(t) {
  const nm = h('span', 'nm');
  if (t.rank) nm.append(h('span', 'rk', String(t.rank)));
  nm.append(document.createTextNode(t.name));
  return nm;
}

function gameRow(g, i) {
  const st = standing(g), row = h('button', 'game-row'), [text, cls] = word(g, st);
  row.type = 'button';
  row.dataset.id = g.id;
  if (cls === 'is-over' || cls === 'is-under') row.classList.add(cls);
  if (i === S.cursor) row.classList.add('is-cursor');
  const teams = h('span', 'c-teams');
  teams.append(teamCell(g.away), h('span', 'pt', g.away.pts), teamCell(g.home), h('span', 'pt', g.home.pts));
  const m = st ? st.markets.total : null;
  const num = (label, value, kind) => { const c = h('span', `c-num ${kind}`); c.append(h('span', 'lb', label), document.createTextNode(value)); return c; };
  const line = h('span', 'c-line');
  const bar = h('span', 'c-bar'); bar.append(gapBar(m ? m.edge : null, RULES.buyEdge));
  const strong = m && m.edge != null && Math.abs(m.edge) >= RULES.buyEdge;
  line.append(num('Book', m ? f1(m.line) : '–', 'book'), num('Fair', m ? f1(m.fair) : '–', 'fair'), bar, h('span', `c-gap${strong ? (m.edge > 0 ? ' is-over' : ' is-under') : ''}`, m ? signed(m.edge) : '–'));
  const tt = h('span', 'c-tt');
  if (st && st.markets.away.edge != null) {
    tt.append(document.createTextNode(`${g.away.abbr} `), h('b', '', signed(st.markets.away.edge)), document.createTextNode(`  ${g.home.abbr} `), h('b', '', signed(st.markets.home.edge)));
  }
  const pre = preOf(g), sp = h('span', 'c-spark');
  sp.append(spark(pre && S.model ? readingsOf(g).map((r) => { const j = S.model.judge(pre, r[1], r[2], r[3], r[4], r[5]).markets.total; return [r[1], j.edge]; }) : []));
  const read = h('span', 'c-read'); read.append(h('span', `say ${cls}`, text));
  row.append(h('span', 'c-clock', g.detail.replace(' - ', ' ')), teams, line, tt, sp, read);
  row.addEventListener('click', () => go(gameHash(g.id, st && st.best ? st.best.key : 'total')));
  return row;
}

const heat = (g) => { const st = standing(g); if (!st) return -1; const big = Math.max(...['total', 'away', 'home'].map((k) => Math.abs(st.markets[k].edge || 0))); return (st.best ? st.best.weight * 100 : 0) + big; };

function schedRow(g, right) {
  const b = h('button'); b.type = 'button';
  const who = `${g.away.rank ? g.away.rank + ' ' : ''}${g.away.name} at ${g.home.rank ? g.home.rank + ' ' : ''}${g.home.name}`;
  b.append(h('span', 'when', g.state === 'pre' ? timeLabel(g.start) : 'Final'), h('span', 'who', who), h('span', 'what', right));
  b.addEventListener('click', () => go(gameHash(g.id, 'total')));
  return b;
}

function liveRows() {
  const live = [...S.games.values()].filter((g) => g.state === 'in').sort((a, b) => heat(b) - heat(a));
  return S.only ? live.filter((g) => { const st = standing(g); return st && st.best; }) : live;
}

function renderBoard() {
  $('#day').textContent = dayLabel(S.date);
  $('#only').setAttribute('aria-pressed', String(S.only));
  const all = [...S.games.values()], nLive = all.filter((g) => g.state === 'in').length, rows = liveRows();
  $('#live-count').textContent = nLive ? ` ${nLive}` : '';
  const lined = rows.filter((g) => preOf(g)), unlined = rows.length - lined.length;
  $('#board-rows').replaceChildren(...lined.map(gameRow));
  $('#board-wrap').hidden = !lined.length;
  $('#board-unlined').hidden = !unlined;
  $('#board-unlined').textContent = `${unlined} more in progress with no DraftKings line, so nothing to measure.`;
  const empty = $('#board-empty');
  empty.hidden = rows.length > 0;
  empty.textContent = !S.scoresAt ? 'Loading the scoreboard.' : !nLive ? (isToday() ? 'No games in progress. The board fills in at tip-off.' : 'No games in progress on this date.') : 'No signals right now. An empty board is a valid result.';
  const next = all.filter((g) => g.state === 'pre').sort((a, b) => new Date(a.start) - new Date(b.start));
  $('#next-rows').replaceChildren(...next.map((g) => schedRow(g, g.pre ? `${g.pre[0]}, ${g.pre[1] <= 0 ? g.home.abbr : g.away.abbr} by ${Math.abs(g.pre[1])}` : 'No line')));
  $('#next').hidden = !next.length;
  const taped = (g) => ((S.recorded.get(g.id) || {}).r || []).length;
  const done = all.filter((g) => g.state === 'post').sort((a, b) => taped(b) - taped(a));
  $('#final-rows').replaceChildren(...done.map((g) => schedRow(g, `${g.away.pts}-${g.home.pts}${taped(g) ? ', line recorded' : ''}`)));
  $('#finals').hidden = !done.length;
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
  $('#game-none').hidden = !!g;
  $('#game-body').hidden = !g;
  if (!g) { $('#game-none').textContent = S.sel && !S.scoresAt ? 'Loading the game.' : 'Pick a game from the board.'; return; }
  const k = S.market, pre = preOf(g), st = standing(g), book = readingsOf(g);
  const side = (id, t, short) => {
    const tm = h('div', 'tm'); if (t.rank) tm.append(h('span', 'rk', String(t.rank))); tm.append(document.createTextNode(t.name));
    $(id).replaceChildren(tm, h('div', 'beh', short == null || g.state === 'pre' ? '' : short >= 0 ? `${f1(short)} behind pace` : `${f1(-short)} ahead`));
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
  $('#f-book-l').textContent = k === 'total' ? 'DraftKings live' : 'DraftKings, implied';
  $('#f-book').textContent = shown ? f1(shown.line) : '–';
  $('#f-fair').textContent = g.state === 'pre' ? f1(preK) : g.state === 'post' ? (lastRec ? f1(lastRec.fair) : '–') : m ? f1(m.fair) : '–';
  $('#f-gap').textContent = shown ? signed(shown.edge) : '–';
  $('#f-gap').className = shown && Math.abs(shown.edge) >= RULES.buyEdge ? (shown.edge > 0 ? 'is-over' : 'is-under') : '';
  $('#f-over').textContent = g.state === 'in' && m && m.over != null ? `${Math.round(m.over * 100)}%` : '–';
  $('#f-pre').textContent = f1(preK);
  const paceK = st && g.state === 'in' ? (k === 'total' ? st.fair.paceTotal : k === 'away' ? st.fair.paceAway : st.fair.paceHome) : null;
  $('#f-pace').textContent = f1(paceK);

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
  for (const p of tl) { if (p.t < 2) continue; const f = S.model.fair(pre, p.t, p.a, p.h); fairPts.push({ t: p.t, v: f[k] }); if (f[paceKey] != null) pacePts.push({ t: p.t, v: f[paceKey] }); }
  const bookPts = book.filter((r) => r[1] <= 40).map((r) => { const j = S.model.judge(pre, r[1], r[2], r[3], r[4], r[5]).markets[k]; return { t: r[1], v: j.line, fair: j.fair }; });
  const finals = g.state === 'post' ? { away: g.away.pts, home: g.home.pts } : null;
  const signals = S.model.signalsFor(pre, book, finals);
  const share = [[0, 0]]; for (let t = 2; t <= 38; t += 1) share.push([t, S.model.share(t)]); share.push([40, 1]);
  const idle = () => { scrub.textContent = 'Drag across the chart to read any minute.'; };
  gameChart(host, {
    pregame: preK, preAway: pre[0] / 2 + pre[1] / 2, preHome: pre[0] / 2 - pre[1] / 2, final: finals ? (k === 'total' ? finals.away + finals.home : finals[k]) : null,
    fair: fairPts, pace: pacePts, book: bookPts, flow: tl, share, signals: signals.filter((s) => s.market === k),
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
  $('#r-all').textContent = tally(L);
  $('#r-units').textContent = settled.length ? signed(units) : '–';
  $('#r-units').className = settled.length && units > 0 ? 'is-over' : settled.length && units < 0 ? 'is-under' : '';
  $('#r-over').textContent = tally(L.filter((s) => s.side === 'Over'));
  $('#r-under').textContent = tally(L.filter((s) => s.side === 'Under'));
  $('#days-rows').replaceChildren(...S.index.slice().reverse().map((d) => {
    const tr = document.createElement('tr'); tr.tabIndex = 0;
    for (const [v, c] of [[dayLabel(d.date)], [d.games, 'r'], [d.readings, 'r'], [d.gap_abs == null ? '–' : d.gap_abs.toFixed(1), 'r'], [d.below == null ? '–' : `${d.below}%`, 'r'], [d.above == null ? '–' : `${d.above}%`, 'r']]) tr.append(h('td', c || '', v));
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
function render() { renderPulse(); if (S.view === 'board') renderBoard(); if (S.view === 'game') renderGame(); if (S.view === 'record') renderRecord(); }

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
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (S.view === 'game') renderGame(); }, 120); });
document.addEventListener('visibilitychange', () => { if (document.hidden) store.save(); else refresh(); });
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  if (S.view === 'board') {
    const rows = liveRows().filter((g) => preOf(g));
    if (e.key === 'j' || e.key === 'ArrowDown') { S.cursor = Math.min(rows.length - 1, S.cursor + 1); renderBoard(); e.preventDefault(); }
    else if (e.key === 'k' || e.key === 'ArrowUp') { S.cursor = Math.max(0, S.cursor - 1); renderBoard(); e.preventDefault(); }
    else if (e.key === 'Enter' && rows[S.cursor] && e.target === document.body) go(gameHash(rows[S.cursor].id, 'total'));
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
