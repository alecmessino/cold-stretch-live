// The board's headline and the line under it, in plain words. Pure functions, so every state of a slate can be tested.

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const settled = (s) => `${s.won} won, ${s.lost} lost${s.pushed ? `, ${s.pushed} pushed` : ''}`;

/**
 * d: { loaded, today, weekday, games, live, ahead, nextTip, anyFinal, readings, apart, firstMinute, afterFact,
 *      signals: { n, open, won, lost, pushed } }
 * The headline says what there is to act on; the standfirst says what a signal is and how close the two numbers ran.
 */
export function boardWords(d) {
  const s = d.signals || { n: 0, open: 0, won: 0, lost: 0, pushed: 0 };
  if (!d.loaded) return { head: 'Loading the slate.', sub: '' };
  if (!d.games) return { head: 'No games on this date.', sub: '' };
  const from = `Signals can fire from minute ${d.firstMinute} of each game.`;
  if (!d.readings) {
    if (d.today && d.live) return { head: `${plural(d.live, 'game')} in progress. The first lines are coming in.`, sub: from };
    if (d.ahead && !d.anyFinal) return { head: `${plural(d.ahead, 'game')} on the slate. The first tips at ${d.nextTip}.`, sub: `The board fills in at tip-off. ${from}` };
    if (d.today && d.ahead) return { head: `${plural(d.ahead, 'game')} still to tip. The next is at ${d.nextTip}.`, sub: `No live line has been recorded yet today. ${from}` };
    return { head: 'No live lines were recorded for this slate.', sub: 'ESPN drops the live line at the final whistle, so a slate can only be measured while the recorder is running.' };
  }
  const apart = `Across ${plural(d.readings, 'reading')} the sportsbook and the fair number have been ${d.apart.toFixed(1)} points apart on average.`;
  const done = s.won + s.lost + s.pushed;
  if (d.today && d.live) {
    const head = s.open ? `${s.open === 1 ? 'One signal is' : `${s.open} signals are`} open across ${plural(d.live, 'live game')}.`
      : `No signal is open right now. ${d.live === 1 ? 'One game is' : `${d.live} games are`} live.`;
    return { head, sub: `${done ? `Settled so far today: ${settled(s)}. ` : ''}${apart}` };
  }
  const when = d.today ? 'today' : `on ${d.weekday}`;
  const head = s.n ? `${plural(s.n, 'signal')} ${when}: ${settled(s)}${s.open ? `, ${s.open} open` : ''}.` : `No signals ${when}.`;
  const what = 'A signal is logged when the sportsbook’s live total sits well away from the fair number for three minutes, at a price that pays.';
  const next = d.today && d.ahead ? ` ${d.ahead === 1 ? 'One game is' : `${d.ahead} games are`} still to tip; the next is at ${d.nextTip}.` : '';
  const scored = d.afterFact && s.n ? ' This slate was scored after the fact, under a rule set later.' : '';
  return { head, sub: `${what} ${apart.replace('have been', d.today ? 'have been' : 'were')}${next}${scored}` };
}
