// Drawing. d3 is loaded as a global by index.html. Colours come from CSS custom properties so both themes work.

const d3 = globalThis.d3;
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
const f1 = (v) => (v == null || !Number.isFinite(v) ? '–' : v.toFixed(1));
const signed = (v) => (v == null || !Number.isFinite(v) ? '–' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1));

/**
 * The tape measure: fair sits at the centre, the amber mark is where the book sits against it.
 * Left of centre means the book is low (an over), right means high. Ticks mark 2.5 points either side.
 */
export function gapBar(edge, threshold = 2.5, span = 7) {
  const W = 150, H = 20, mid = W / 2, x = (v) => mid + (Math.max(-span, Math.min(span, v)) / span) * (mid - 4);
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': edge == null ? 'No live line' : `Book ${signed(-edge)} against fair` });
  svg.append(el('line', { x1: 4, x2: W - 4, y1: H / 2, y2: H / 2, stroke: 'var(--rule)' }));
  for (const v of [-threshold, threshold]) svg.append(el('line', { x1: x(v), x2: x(v), y1: H / 2 - 3, y2: H / 2 + 3, stroke: 'var(--dim)' }));
  svg.append(el('line', { x1: mid, x2: mid, y1: 2, y2: H - 2, stroke: 'var(--fair)', 'stroke-width': 1.5 }));
  if (edge != null) {
    const bx = x(-edge), strong = Math.abs(edge) >= threshold;
    svg.append(el('rect', { x: Math.min(mid, bx), y: H / 2 - 2, width: Math.abs(bx - mid), height: 4, fill: strong ? (edge > 0 ? 'var(--over)' : 'var(--under)') : 'var(--dim)', opacity: strong ? 0.9 : 0.5 }));
    svg.append(el('rect', { x: bx - 2, y: 3, width: 4, height: H - 6, fill: 'var(--book)' }));
  }
  return svg;
}

/** Fair-minus-book over the game so far, as a small line around zero. */
export function spark(points) {
  const W = 96, H = 22;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, 'aria-hidden': 'true' });
  svg.append(el('line', { x1: 0, x2: W, y1: H / 2, y2: H / 2, stroke: 'var(--rule)' }));
  if (points.length > 1) {
    const x = d3.scaleLinear([0, 40], [0, W]), y = d3.scaleLinear([-7, 7], [H - 1, 1]).clamp(true);
    svg.append(el('path', { d: d3.line().x((p) => x(p[0])).y((p) => y(p[1]))(points), fill: 'none', stroke: 'var(--chalk)', 'stroke-width': 1.25, opacity: 0.85 }));
  }
  return svg;
}

/**
 * Two panes on one time axis: the projected final (book, fair, pace, pregame) above the score flow.
 * A crosshair runs through both and reports through onScrub; nothing floats over the chart.
 */
export function gameChart(host, d) {
  const W = Math.max(300, host.clientWidth), narrow = W < 560;
  const topH = narrow ? 230 : 270, botH = narrow ? 150 : 170, gap = 34;
  const m = { t: 12, r: 46, b: 22, l: 34 }, H = m.t + topH + gap + botH + m.b;
  const x = d3.scaleLinear([0, 40], [m.l, W - m.r]);
  const svg = d3.create('svg').attr('viewBox', `0 0 ${W} ${H}`).attr('width', '100%').attr('role', 'img')
    .attr('aria-label', 'Projected final by game minute, with the score flow underneath');

  // ---- top pane: projected final
  const vals = [d.pregame, ...d.fair.map((p) => p.v), ...d.book.map((p) => p.v)].concat(d.final == null ? [] : [d.final]);
  const lo = d3.min(vals), hi = d3.max(vals), pad = Math.max(3, (hi - lo) * 0.12);
  const y = d3.scaleLinear([lo - pad, hi + pad], [m.t + topH, m.t]);
  const yt = y.ticks(5);
  svg.append('g').selectAll('line').data(yt).join('line').attr('x1', m.l).attr('x2', W - m.r).attr('y1', y).attr('y2', y).attr('stroke', 'var(--rule-soft)');
  svg.append('g').selectAll('text').data(yt).join('text').attr('x', m.l - 7).attr('y', y).attr('dy', '0.32em').attr('text-anchor', 'end').text((v) => v);
  const clip = `clip-${Math.random().toString(36).slice(2, 8)}`;
  svg.append('clipPath').attr('id', clip).append('rect').attr('x', m.l).attr('y', m.t).attr('width', W - m.l - m.r).attr('height', topH);
  const top = svg.append('g').attr('clip-path', `url(#${clip})`);
  top.append('line').attr('x1', m.l).attr('x2', W - m.r).attr('y1', y(d.pregame)).attr('y2', y(d.pregame)).attr('stroke', 'var(--dim)').attr('stroke-dasharray', '5 4');
  top.append('path').attr('d', d3.line().x((p) => x(p.t)).y((p) => y(p.v))(d.pace)).attr('fill', 'none').attr('stroke', 'var(--fog)').attr('stroke-width', 1.5).attr('stroke-dasharray', '1 4').attr('stroke-linecap', 'round');
  for (let i = 0; i + 1 < d.book.length; i += 1) { // the space between book and fair, tinted by which way it leans
    const a = d.book[i], b = d.book[i + 1];
    if (b.t <= a.t || b.t - a.t > 3) continue;
    top.append('path').attr('d', `M${x(a.t)},${y(a.v)}L${x(b.t)},${y(a.v)}L${x(b.t)},${y(b.fair)}L${x(a.t)},${y(a.fair)}Z`).attr('fill', a.fair >= a.v ? 'var(--over)' : 'var(--under)').attr('opacity', 0.16);
  }
  top.append('path').attr('d', d3.line().x((p) => x(p.t)).y((p) => y(p.v))(d.fair)).attr('fill', 'none').attr('stroke', 'var(--fair)').attr('stroke-width', 2).attr('stroke-linejoin', 'round');
  top.append('path').attr('d', d3.line().defined((p, i) => i === 0 || p.t - d.book[i - 1].t <= 3).curve(d3.curveStepAfter).x((p) => x(p.t)).y((p) => y(p.v))(d.book)).attr('fill', 'none').attr('stroke', 'var(--book)').attr('stroke-width', 2.5);
  svg.append('g').selectAll('path').data(d.signals).join('path').attr('d', d3.symbol(d3.symbolTriangle, 80))
    .attr('transform', (s) => `translate(${x(s.minute)},${y(s.line) + (s.side === 'Over' ? 13 : -13)}) rotate(${s.side === 'Over' ? 0 : 180})`)
    .attr('fill', (s) => (s.side === 'Over' ? 'var(--over)' : 'var(--under)')).attr('stroke', 'var(--court)');
  const ends = [];
  if (d.fair.length) ends.push({ y: y(d.fair[d.fair.length - 1].v), x: x(d.fair[d.fair.length - 1].t), text: f1(d.fair[d.fair.length - 1].v), fill: 'var(--fair)' });
  if (d.book.length) ends.push({ y: y(d.book[d.book.length - 1].v), x: x(d.book[d.book.length - 1].t), text: f1(d.book[d.book.length - 1].v), fill: 'var(--book)' });
  if (d.final != null) {
    svg.append('rect').attr('x', x(40) - 4).attr('y', y(d.final) - 4).attr('width', 8).attr('height', 8).attr('fill', 'var(--chalk)');
    ends.push({ y: y(d.final), x: x(40), text: String(d.final), fill: 'var(--chalk)' });
  }
  ends.sort((a, b) => a.y - b.y).forEach((e, i, arr) => { if (i && e.y - arr[i - 1].y < 13) e.y = arr[i - 1].y + 13; });
  for (const e of ends) svg.append('text').attr('class', 'lbl').attr('x', Math.min(e.x + 8, W - m.r + 8)).attr('y', e.y).attr('dy', '0.32em').attr('fill', e.fill).text(e.text);

  // ---- bottom pane: score flow against pregame pace
  const by0 = m.t + topH + gap;
  const maxPts = Math.max(d.preAway, d.preHome, d3.max(d.flow, (p) => Math.max(p.a, p.h)) || 0) * 1.06;
  const yb = d3.scaleLinear([0, maxPts], [by0 + botH, by0]);
  const ybt = yb.ticks(3);
  svg.append('g').selectAll('line').data(ybt).join('line').attr('x1', m.l).attr('x2', W - m.r).attr('y1', yb).attr('y2', yb).attr('stroke', 'var(--rule-soft)');
  svg.append('g').selectAll('text').data(ybt).join('text').attr('x', m.l - 7).attr('y', yb).attr('dy', '0.32em').attr('text-anchor', 'end').text((v) => v);
  for (const [k, total, colour] of [['a', d.preAway, 'var(--away)'], ['h', d.preHome, 'var(--home)']]) {
    svg.append('path').attr('d', d3.line().x((s) => x(s[0])).y((s) => yb(total * s[1]))(d.share)).attr('fill', 'none').attr('stroke', colour).attr('stroke-dasharray', '3 4').attr('opacity', 0.55);
    svg.append('path').attr('d', d3.line().curve(d3.curveStepAfter).x((p) => x(p.t)).y((p) => yb(p[k]))(d.flow)).attr('fill', 'none').attr('stroke', colour).attr('stroke-width', 2.25);
  }
  const lastFlow = d.flow[d.flow.length - 1];
  const fl = [{ y: yb(lastFlow.a), text: String(lastFlow.a), fill: 'var(--away)' }, { y: yb(lastFlow.h), text: String(lastFlow.h), fill: 'var(--home)' }].sort((a, b) => a.y - b.y);
  if (fl[1].y - fl[0].y < 13) fl[1].y = fl[0].y + 13;
  for (const e of fl) svg.append('text').attr('class', 'lbl').attr('x', x(lastFlow.t) + 8).attr('y', e.y).attr('dy', '0.32em').attr('fill', e.fill).text(e.text);

  // ---- shared axis and crosshair
  for (const yy of [m.t + topH, by0 + botH]) svg.append('line').attr('x1', m.l).attr('x2', W - m.r).attr('y1', yy).attr('y2', yy).attr('stroke', 'var(--rule)');
  svg.append('line').attr('x1', x(20)).attr('x2', x(20)).attr('y1', m.t).attr('y2', by0 + botH).attr('stroke', 'var(--rule)').attr('stroke-dasharray', '2 3');
  svg.append('g').selectAll('text').data([[0, 'Tip'], [10, '10:00 1H'], [20, 'Half'], [30, '10:00 2H'], [40, 'Final']]).join('text')
    .attr('x', (v) => x(v[0])).attr('y', H - 5).attr('text-anchor', (v, i) => (i === 0 ? 'start' : i === 4 ? 'end' : 'middle')).text((v) => (narrow && v[0] % 20 ? '' : v[1]));
  const hair = svg.append('line').attr('y1', m.t).attr('y2', by0 + botH).attr('stroke', 'var(--chalk)').attr('opacity', 0.5).style('display', 'none');
  const nearest = (rows, t) => rows.reduce((best, r) => (best == null || Math.abs(r.t - t) < Math.abs(best.t - t) ? r : best), null);
  const at = (ev) => {
    const t = Math.max(0, Math.min(40, x.invert(d3.pointer(ev, svg.node())[0])));
    const book = nearest(d.book, t), fair = nearest(d.fair, t), pace = nearest(d.pace, t);
    const useBook = book && Math.abs(book.t - t) <= 1.5;
    const tt = useBook ? book.t : fair ? fair.t : t;
    const past = d.flow.filter((p) => p.t <= tt), score = past.length ? past[past.length - 1] : d.flow[0];
    hair.attr('x1', x(tt)).attr('x2', x(tt)).style('display', null);
    d.onScrub({ t: tt, a: score.a, h: score.h, book: useBook ? book.v : null, fair: useBook ? book.fair : fair ? fair.v : null, pace: pace && Math.abs(pace.t - tt) <= 1.5 ? pace.v : null });
  };
  svg.append('rect').attr('x', m.l).attr('y', m.t).attr('width', W - m.l - m.r).attr('height', topH + gap + botH).attr('fill', 'transparent')
    .on('pointermove pointerdown', at).on('pointerleave', () => { hair.style('display', 'none'); d.onScrub(null); });
  host.replaceChildren(svg.node());
}

export const fmt = { f1, signed };
