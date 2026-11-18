// Drawing. d3 is loaded as a global by index.html. Colours come from the CSS custom properties in css/app.css.

const d3 = globalThis.d3;
const f1 = (v) => (v == null || !Number.isFinite(v) ? '–' : v.toFixed(1));
const signed = (v) => { if (v == null || !Number.isFinite(v)) return '–'; const r = Math.round(v * 10) / 10; return (r > 0 ? '+' : r < 0 ? '−' : '') + Math.abs(r).toFixed(1); };
const tick = (v) => (v > 0 ? `+${v}` : v < 0 ? `−${Math.abs(v)}` : '0');

/**
 * One row of the board: fair minus book on a fixed scale of 5 points each way.
 * The dot is the latest reading, the bar is the range seen so far, the tinted ends start at the signal threshold.
 */
export function rangePlot({ gap, lo, hi, signal = false, span = 5, threshold = 2.5 }) {
  const at = (v) => `${((Math.max(-span, Math.min(span, v)) + span) / (2 * span)) * 100}%`;
  const plot = document.createElement('span');
  plot.className = 'plot';
  plot.setAttribute('role', 'img');
  plot.setAttribute('aria-label', gap == null ? 'No line to measure' : `Fair minus book ${signed(gap)}${lo != null && hi != null ? `, range ${signed(lo)} to ${signed(hi)}` : ''}`);
  if (lo != null && hi != null && hi > lo) {
    const range = document.createElement('i');
    range.className = 'range';
    range.style.left = at(lo);
    range.style.width = `${parseFloat(at(hi)) - parseFloat(at(lo))}%`;
    plot.append(range);
  }
  if (gap != null) {
    const dot = document.createElement('i');
    dot.className = `dot${gap >= threshold ? ' is-over' : gap <= -threshold ? ' is-under' : ''}${signal ? ' is-signal' : ''}`;
    dot.style.left = at(gap);
    plot.append(dot);
  }
  return plot;
}

/** Every reading on the slate, fair minus book, in half-point bins. The tails beyond the threshold are the ones that matter. */
export function histogram(host, gaps, { threshold = 2.5, span = 6 } = {}) {
  const W = Math.max(260, host.clientWidth || 360), H = 232, m = { t: 52, r: 6, b: 44, l: 6 };
  const x = d3.scaleLinear([-span, span], [m.l, W - m.r]);
  const bins = Array.from({ length: span * 4 }, (_, i) => ({ v0: -span + i * 0.5, n: 0 }));
  for (const g of gaps) bins[Math.max(0, Math.min(bins.length - 1, Math.floor((g + span) / 0.5)))].n += 1;
  const y = d3.scaleLinear([0, d3.max(bins, (b) => b.n) || 1], [H - m.b, m.t]);
  const share = (test) => (gaps.length ? `${((100 * gaps.filter(test).length) / gaps.length).toFixed(1)}%` : '–');
  const high = share((g) => g <= -threshold), low = share((g) => g >= threshold);
  const svg = d3.create('svg').attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img')
    .attr('aria-label', `Fair minus book across ${gaps.length} readings. The book was ${threshold} or more high on ${high} and ${threshold} or more low on ${low}.`);
  const bw = x(0.5) - x(0);
  svg.append('g').selectAll('rect').data(bins.filter((b) => b.n)).join('rect')
    .attr('x', (b) => x(b.v0) + 1).attr('width', Math.max(1, bw - 2)).attr('y', (b) => y(b.n)).attr('height', (b) => H - m.b - y(b.n))
    .attr('fill', (b) => (b.v0 + 0.5 <= -threshold ? 'var(--book)' : b.v0 >= threshold ? 'var(--fair)' : 'var(--rule-strong)'));
  svg.append('line').attr('x1', m.l).attr('x2', W - m.r).attr('y1', H - m.b).attr('y2', H - m.b).attr('stroke', 'var(--ink)');
  for (const v of [-threshold, threshold]) svg.append('line').attr('x1', x(v)).attr('x2', x(v)).attr('y1', m.t).attr('y2', H - m.b).attr('stroke', 'var(--faint)').attr('stroke-dasharray', '3 4');
  svg.append('g').selectAll('text').data([-5, -2.5, 0, 2.5, 5]).join('text').attr('x', x).attr('y', H - m.b + 17).attr('text-anchor', 'middle').text(tick);
  svg.append('text').attr('x', W / 2).attr('y', H - 4).attr('text-anchor', 'middle').text('Fair minus book, points');
  svg.append('text').attr('class', 'big').attr('x', m.l).attr('y', 20).attr('fill', 'var(--book)').style('fill', 'var(--book)').text(high);
  svg.append('text').attr('x', m.l).attr('y', 38).text(`book ${threshold}+ high`);
  svg.append('text').attr('class', 'big').attr('x', W - m.r).attr('y', 20).attr('text-anchor', 'end').style('fill', 'var(--fair)').text(low);
  svg.append('text').attr('x', W - m.r).attr('y', 38).attr('text-anchor', 'end').text(`book ${threshold}+ low`);
  host.replaceChildren(svg.node());
}

/**
 * Two panes on one time axis: the projected final (book, fair, pregame) above the score flow.
 * A crosshair runs through both and reports through onScrub; nothing floats over the chart.
 */
export function gameChart(host, d) {
  const W = Math.max(300, host.clientWidth), narrow = W < 620;
  const topH = narrow ? 220 : 280, botH = narrow ? 140 : 170, gap = 52;
  const m = { t: 26, r: narrow ? 46 : 104, b: 24, l: 34 }, H = m.t + topH + gap + botH + m.b;
  const x = d3.scaleLinear([0, 40], [m.l, W - m.r]);
  const svg = d3.create('svg').attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img')
    .attr('aria-label', 'Projected final by game minute, with the score flow underneath');
  const name = (label, value) => (narrow ? value : `${label} ${value}`);

  // ---- top pane: projected final
  const vals = [d.pregame, ...d.fair.map((p) => p.v), ...d.book.map((p) => p.v)].concat(d.final == null ? [] : [d.final]);
  const lo = d3.min(vals), hi = d3.max(vals), pad = Math.max(3, (hi - lo) * 0.12);
  const y = d3.scaleLinear([lo - pad, hi + pad], [m.t + topH, m.t]);
  const yt = y.ticks(5);
  svg.append('text').attr('class', 'ttl').attr('x', m.l).attr('y', 12).text('Projected final');
  svg.append('g').selectAll('line').data(yt).join('line').attr('x1', m.l).attr('x2', W - m.r).attr('y1', y).attr('y2', y).attr('stroke', 'var(--rule-soft)');
  svg.append('g').selectAll('text').data(yt).join('text').attr('x', m.l - 7).attr('y', y).attr('dy', '0.32em').attr('text-anchor', 'end').text((v) => v);
  const clip = `clip-${Math.random().toString(36).slice(2, 8)}`;
  svg.append('clipPath').attr('id', clip).append('rect').attr('x', m.l).attr('y', m.t).attr('width', W - m.l - m.r).attr('height', topH);
  const top = svg.append('g').attr('clip-path', `url(#${clip})`);
  top.append('line').attr('x1', m.l).attr('x2', W - m.r).attr('y1', y(d.pregame)).attr('y2', y(d.pregame)).attr('stroke', 'var(--faint)').attr('stroke-width', 1.5).attr('stroke-dasharray', '6 5');
  for (let i = 0; i + 1 < d.book.length; i += 1) { // the space between book and fair, tinted by which number is higher
    const a = d.book[i], b = d.book[i + 1];
    if (b.t <= a.t || b.t - a.t > 3) continue;
    top.append('path').attr('d', `M${x(a.t)},${y(a.v)}L${x(b.t)},${y(a.v)}L${x(b.t)},${y(b.fair)}L${x(a.t)},${y(a.fair)}Z`).attr('fill', a.fair >= a.v ? 'var(--fair)' : 'var(--book)').attr('opacity', 0.13);
  }
  top.append('path').attr('d', d3.line().x((p) => x(p.t)).y((p) => y(p.v))(d.fair)).attr('fill', 'none').attr('stroke', 'var(--fair)').attr('stroke-width', 2.25).attr('stroke-linejoin', 'round');
  top.append('path').attr('d', d3.line().defined((p, i) => i === 0 || p.t - d.book[i - 1].t <= 3).curve(d3.curveStepAfter).x((p) => x(p.t)).y((p) => y(p.v))(d.book)).attr('fill', 'none').attr('stroke', 'var(--book)').attr('stroke-width', 2.25);
  svg.append('g').selectAll('path').data(d.signals).join('path').attr('d', d3.symbol(d3.symbolTriangle, 80))
    .attr('transform', (s) => `translate(${x(s.minute)},${y(s.line) + (s.side === 'Over' ? 13 : -13)}) rotate(${s.side === 'Over' ? 0 : 180})`)
    .attr('fill', (s) => (s.side === 'Over' ? 'var(--fair)' : 'var(--book)')).attr('stroke', 'var(--panel)');
  const ends = [{ y: y(d.pregame), x: W - m.r, text: name('Pregame', f1(d.pregame)), fill: 'var(--sub)', dot: null }];
  if (d.fair.length && d.final == null) { const p = d.fair[d.fair.length - 1]; ends.push({ y: y(p.v), x: x(p.t), text: name('Fair', f1(p.v)), fill: 'var(--fair)', dot: 'var(--fair)' }); }
  if (d.book.length) { const p = d.book[d.book.length - 1]; ends.push({ y: y(p.v), x: x(p.t), text: name('Book', f1(p.v)), fill: 'var(--book)', dot: 'var(--book)' }); }
  if (d.final != null) {
    svg.append('rect').attr('x', x(40) - 4).attr('y', y(d.final) - 4).attr('width', 8).attr('height', 8).attr('fill', 'var(--ink)');
    ends.push({ y: y(d.final), x: x(40), text: name('Final', String(d.final)), fill: 'var(--ink)', dot: null });
  }
  for (const e of ends) if (e.dot) svg.append('circle').attr('cx', e.x).attr('cy', e.y).attr('r', 4).attr('fill', e.dot).attr('stroke', 'var(--panel)').attr('stroke-width', 1.5);
  ends.sort((a, b) => a.y - b.y).forEach((e, i, arr) => { if (i && e.y - arr[i - 1].y < 15) e.y = arr[i - 1].y + 15; });
  for (const e of ends) svg.append('text').attr('class', 'lbl').attr('x', W - m.r + 9).attr('y', e.y).attr('dy', '0.32em').style('fill', e.fill).text(e.text);

  // ---- bottom pane: score flow against pregame pace
  const by0 = m.t + topH + gap;
  svg.append('text').attr('class', 'ttl').attr('x', m.l).attr('y', by0 - 14).text('Score, with the pregame pace dashed');
  const maxPts = Math.max(d.preAway, d.preHome, d3.max(d.flow, (p) => Math.max(p.a, p.h)) || 0) * 1.06;
  const yb = d3.scaleLinear([0, maxPts], [by0 + botH, by0]);
  const ybt = yb.ticks(3);
  svg.append('g').selectAll('line').data(ybt).join('line').attr('x1', m.l).attr('x2', W - m.r).attr('y1', yb).attr('y2', yb).attr('stroke', 'var(--rule-soft)');
  svg.append('g').selectAll('text').data(ybt).join('text').attr('x', m.l - 7).attr('y', yb).attr('dy', '0.32em').attr('text-anchor', 'end').text((v) => v);
  for (const [k, total, colour] of [['a', d.preAway, 'var(--away)'], ['h', d.preHome, 'var(--home)']]) {
    svg.append('path').attr('d', d3.line().x((s) => x(s[0])).y((s) => yb(total * s[1]))(d.share)).attr('fill', 'none').attr('stroke', colour).attr('stroke-width', 1.25).attr('stroke-dasharray', '4 4').attr('opacity', 0.7);
    svg.append('path').attr('d', d3.line().curve(d3.curveStepAfter).x((p) => x(p.t)).y((p) => yb(p[k]))(d.flow)).attr('fill', 'none').attr('stroke', colour).attr('stroke-width', 2);
  }
  const lastFlow = d.flow[d.flow.length - 1];
  const fl = [{ y: yb(lastFlow.a), text: name(d.awayName || '', String(lastFlow.a)), fill: 'var(--away)' }, { y: yb(lastFlow.h), text: name(d.homeName || '', String(lastFlow.h)), fill: 'var(--home)' }].sort((a, b) => a.y - b.y);
  if (fl[1].y - fl[0].y < 15) fl[1].y = fl[0].y + 15;
  for (const e of fl) svg.append('text').attr('class', 'lbl').attr('x', W - m.r + 9).attr('y', e.y).attr('dy', '0.32em').style('fill', e.fill).text(e.text.trim());

  // ---- shared axis and crosshair
  for (const yy of [m.t + topH, by0 + botH]) svg.append('line').attr('x1', m.l).attr('x2', W - m.r).attr('y1', yy).attr('y2', yy).attr('stroke', 'var(--rule-strong)');
  for (const [a, b] of [[m.t, m.t + topH], [by0, by0 + botH]]) svg.append('line').attr('x1', x(20)).attr('x2', x(20)).attr('y1', a).attr('y2', b).attr('stroke', 'var(--rule-strong)').attr('stroke-dasharray', '2 4');
  svg.append('g').selectAll('text').data([[0, 'Tip'], [10, '10 min'], [20, 'Half'], [30, '30 min'], [40, 'Final']]).join('text')
    .attr('x', (v) => x(v[0])).attr('y', H - 6).attr('text-anchor', (v, i) => (i === 0 ? 'start' : i === 4 ? 'end' : 'middle')).text((v) => (narrow && v[0] % 20 ? '' : v[1]));
  const hair = svg.append('line').attr('y1', m.t).attr('y2', by0 + botH).attr('stroke', 'var(--ink)').attr('opacity', 0.45).style('display', 'none');
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
