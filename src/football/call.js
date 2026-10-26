// The call: what an announcer says while the play happens.
//
// The feed's line is written after the whistle ("...for 6 yards
// (D.Lawrence)."), so reading it at the snap gives the play away. The call
// is the same facts broken into the moments the clip already marks (snap,
// throw, catch, tackle) so the voice and the lower third arrive WITH the
// picture: "Mahomes back to throw... short right... caught by Walker...
// brought down at the 33, a gain of six."

const ORD = ['', 'First', 'Second', 'Third', 'Fourth'];
const NUM = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const say = n => (n >= 0 && n <= 20 ? NUM[n] : String(n));

export const lastName = n => (n ? n.replace(/^[A-Z][A-Za-z]{0,2}\./, '') : '');

export function spotText(x, ctx) {
  const r = Math.round(x);
  if (r === 50) return 'midfield';
  if (r <= 0 || r >= 100) return 'the end zone';
  const team = r < 50 ? ctx.home : ctx.away;
  return `the ${team.location || team.name} ${r < 50 ? r : 100 - r}`;
}

export function downText(a, ctx) {
  if (!a.down) return '';
  const toGoal = a.dir > 0 ? 100 - a.los : a.los;
  const dist = a.distance >= toGoal ? 'goal' : say(a.distance);
  return `${ORD[a.down] || ''} and ${dist} at ${spotText(a.los, ctx)}`;
}

export function shortDown(a) {
  if (!a.down) return '';
  const toGoal = a.dir > 0 ? 100 - a.los : a.los;
  const th = ['', '1st', '2nd', '3rd', '4th'][a.down] || '';
  return `${th} & ${a.distance >= toGoal ? 'Goal' : a.distance}`;
}

const teamName = (id, ctx) => (id === ctx.home.id ? ctx.home.name : ctx.away.name);

// [{ t, text, big? }] in clip time. `big` lines are the ones a crowd reacts to.
export function callScript(action, clip, ctx) {
  const a = action;
  const lines = [];
  const at = (t, text, big) => lines.push({ t, text, big: !!big });
  const ev = type => clip.events.filter(e => e.type === type);
  const first = type => clip.events.find(e => e.type === type);
  const kick = a.legs.find(l => l.k === 'kick');
  const pass = a.legs.find(l => l.k === 'pass');
  const runs = a.legs.filter(l => l.k === 'run');
  const lastRun = runs.at(-1);
  const gain = y => (y > 0 ? `a gain of ${say(Math.round(y))}` : y < 0 ? `a loss of ${say(Math.round(-y))}` : 'no gain');

  if (a.kind === 'penalty') {
    const p = a.penalties.find(p => !p.declined) || a.penalties[0];
    at(0.2, downText(a, ctx) + '.');
    if (p) at(1.8, `Flag down before the snap. ${p.foul}${p.player ? `, ${lastName(p.player)}` : ''}, ${teamName(p.team, ctx)}.`, true);
    return lines;
  }

  if (a.kind === 'kickoff') {
    const k = first('kick');
    at(0.2, `${lastName(kick.who.name)} to kick it off for the ${teamName(a.offense, ctx)}.`);
    if (k) at(k.t, kick.kind === 'onside' ? 'Onside kick!' : 'And away it goes...', kick.kind === 'onside');
    const tb = first('touchback');
    if (tb || kick.result === 'touchback') at(tb?.t ?? (clip.whistle ?? k?.t + 3), 'Into the end zone. Touchback.');
    const oob = kick.result === 'oob' && clip.whistle;
    if (oob) at(clip.whistle, 'The kick is out of bounds.');
  } else if (a.kind === 'punt') {
    const k = first('kick');
    at(0.3, `${ORD[a.down] || 'Fourth'} down. ${teamName(a.offense, ctx)} will punt.`);
    if (k) at(k.t, kick.result === 'blocked' ? 'The punt is BLOCKED!' : `${lastName(kick.who.name)} gets it away...`, kick.result === 'blocked');
    if (kick.result === 'fair') { const c = first('fair'); if (c) at(c.t - 0.3, 'Fair catch called.'); }
    if (kick.result === 'touchback') { const c = first('touchback'); if (c) at(c.t, 'Into the end zone. Touchback.'); }
    if (kick.result === 'downed') at(clip.whistle ?? 0, `Downed at ${spotText(a.endX, ctx)}.`);
    if (kick.result === 'oob') at(clip.whistle ?? 0, `Out of bounds at ${spotText(kick.toX, ctx)}.`);
  } else if (a.kind === 'fg' || a.kind === 'xp') {
    const k = first('kick');
    at(0.2, a.kind === 'xp' ? 'The try for the extra point...' : `${lastName(kick.who.name)} on for a ${say(kick.yards)} yard try...`);
    if (k) at(k.t, 'The snap, the hold, the kick...');
    const r = first('good') || first('nogood') || first('blocked');
    if (r) at(r.t, r.type === 'good' ? (a.kind === 'xp' ? 'Good.' : 'It is GOOD!') : r.type === 'blocked' ? 'BLOCKED!' : `No good! ${kick.miss || ''}`.trim(), a.kind === 'fg');
  } else {
    const dd = downText(a, ctx);
    if (dd) at(0.15, dd + '.');
    const snap = first('snap');
    const qb = pass?.who?.name || a.legs.find(l => l.k === 'sack' || l.k === 'kneel' || l.k === 'spike')?.who?.name;
    if (a.kind === 'kneel') at(snap?.t ?? 1, `${lastName(qb)} takes a knee.`);
    else if (a.kind === 'spike') at(snap?.t ?? 1, `${lastName(qb)} spikes it to stop the clock.`);
    else if (pass || a.kind === 'sack') at(snap?.t ?? 1, `${lastName(qb) || 'The quarterback'} back to throw...`);
    else if (a.kind === 'scramble') at(snap?.t ?? 1, `${lastName(runs[0]?.who?.name)} drops back... and takes off!`);
    const hand = first('handoff');
    if (hand && runs[0]?.who?.name) at(hand.t, `Handoff to ${lastName(runs[0].who.name)}...`);
    const th = first('throw');
    if (th && pass) at(th.t, `${pass.depth === 'deep' ? 'Fires deep' : 'Throws'} ${pass.side === 'middle' ? 'over the middle' : pass.side}...`, pass.depth === 'deep');
    const c = first('catch');
    if (c && pass?.target?.name) at(c.t, `Caught by ${lastName(pass.target.name)}!`, (c.yards ?? 0) > 15);
    const inc = first('incomplete');
    if (inc) at(inc.t, pass?.target?.name ? `Incomplete, intended for ${lastName(pass.target.name)}.` : 'Thrown away, incomplete.');
    const int = first('interception');
    if (int && pass?.by) at(int.t, `INTERCEPTED! ${lastName(pass.by.name)} picks it off!`, true);
    const sk = first('sack');
    if (sk) {
      const s = a.legs.find(l => l.k === 'sack');
      at(sk.t, `Sacked${s?.tacklers?.[0] ? ` by ${lastName(s.tacklers[0])}` : ''}! ${gain(sk.yards)}.`, true);
    }
  }

  for (const f of ev('fumble')) at(f.t, 'FUMBLE! The ball is loose!', true);
  for (const r of ev('recover')) {
    const leg = a.legs.find(l => l.k === 'recover');
    at(r.t, `Recovered by ${leg?.who?.name ? lastName(leg.who.name) + ', ' : ''}${teamName(r.team, ctx)}!`, r.team !== a.offense);
  }
  const td = first('td');
  if (td) at(td.t, `TOUCHDOWN ${teamName(td.team, ctx).toUpperCase()}!`, true);
  else if (lastRun && clip.whistle != null && !a.legs.some(l => l.k === 'sack')) {
    const yards = (lastRun.toX - a.los) * a.dir;
    const who = lastName(lastRun.who?.name);
    const tk = lastRun.tacklers?.[0];
    const how = lastRun.oob ? `pushed out of bounds at ${spotText(lastRun.toX, ctx)}` : tk ? `brought down by ${lastName(tk)} at ${spotText(lastRun.toX, ctx)}` : `down at ${spotText(lastRun.toX, ctx)}`;
    const scrimmage = a.kind === 'rush' || a.kind === 'pass' || a.kind === 'scramble';
    at(clip.whistle, `${who ? who + ', ' : ''}${how}${scrimmage ? `, ${gain(yards)}` : ''}.`, scrimmage && yards >= 20);
  }
  for (const f of ev('flag')) {
    at(f.t, `There's a flag on the play...`, true);
    at(Math.max(f.t + 1.2, clip.whistle ?? 0) + 0.6, `${f.foul}${f.player ? `, ${lastName(f.player)}` : ''}, ${teamName(f.team, ctx)}${f.noPlay ? '. No play.' : '.'}`);
  }
  return lines.sort((x, y) => x.t - y.t);
}

// The feed's line, tidied for reading aloud or on screen.
export function readable(text) {
  return (text || '')
    .replace(/\((?:No Huddle, )?Shotgun\)\s*/g, '')
    .replace(/\(No Huddle\)\s*/g, '')
    .replace(/\*\*.*$/, '')
    .trim();
}
