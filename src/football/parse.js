// Description -> action.
//
// The play-by-play line is a sentence about the BALL: who had it, where it
// went, how it got there, who stopped it.
//
//   "(Shotgun) K.Cousins pass short right to B.Bowers to NE 36 for 15 yards
//    (K.Vildor; K.Byard). FUMBLES (K.Vildor), RECOVERED by NE-C.Woodson at
//    NE 34."
//
// so the parser reads it as a sequence of LEGS, each a change in what the
// ball is doing: snap, hand, run, pass, kick, fumble, recover. The
// choreographer (choreo.js) lays those legs out in time and invents the other
// twenty-odd bodies around them; nothing here knows about time or bodies.
//
// Field frame (shared with everything downstream): x is yards from the HOME
// goal line (0) to the away goal line (100); end zones are -10..0 and
// 100..110. The home team always attacks +x. A spot like "KC 27" is that
// team's own 27, so its x depends on which side KC is.
//
// The parser never throws and never returns nothing: a line it cannot read
// becomes an 'unknown' action whose one leg moves the ball from the start
// spot to the end spot the feed reports, so the simulation keeps going.

const NAME = String.raw`[A-Z][A-Za-z]{0,2}\.(?:(?:St\.|[Vv]an|den|[Dd]e|[Ll]a|[Ll]e|Du|Da|Di|El|Mc|Mac) )*[A-Z][A-Za-z'\-]+(?: (?:Jr|Sr|III|II|IV)\b\.?)?`;
const SPOT = String.raw`(?:[A-Z]{2,3} -?\d{1,2}|50)`;
const GAP = String.raw`left end|left tackle|left guard|up the middle|right guard|right tackle|right end`;

// Lateral lane of each gap, -1 = offense's far left, +1 = far right.
export const GAP_LANE = {
  'left end': -1, 'left tackle': -0.55, 'left guard': -0.25, 'up the middle': 0,
  'right guard': 0.25, 'right tackle': 0.55, 'right end': 1,
};

const re = (src, flags = '') => new RegExp(src, flags);
const R = {
  formation: /^\(([^)]*)\)\s*/,
  kickoff: re(`^(${NAME}) kicks (onside )?(-?\\d+) yards? from (${SPOT}) to (?:landing zone )?(?:to )?(${SPOT}|end zone|the end zone)`),
  punt: re(`^(${NAME}) punts (-?\\d+) yards? to (${SPOT}|end zone|the end zone)`),
  puntBlocked: re(`^(${NAME}) punt is BLOCKED(?: by (${NAME}))?`),
  fg: re(`^(${NAME}) (\\d+) yard field goal is (GOOD|No Good|BLOCKED)(?: \\((${NAME})\\))?(?:, (Wide Right|Wide Left|Short|Hit Left Upright|Hit Right Upright|Hit Crossbar|Hit Upright))?(, NULLIFIED by Penalty)?`),
  xp: re(`^(${NAME}) extra point is (GOOD|No Good|BLOCKED|Aborted)(?: \\((${NAME})\\))?(?:, (Wide Right|Wide Left|Short|Hit Left Upright|Hit Right Upright|Hit Crossbar|Hit Upright))?`),
  center: re(`^(?:Center|Holder)-(${NAME})`),
  pass: re(`^(${NAME}) pass( incomplete)?(?: (short|deep))?(?: (left|middle|right))?(?: (to|intended for) (${NAME}))?`),
  intercepted: re(`^INTERCEPTED by (${NAME})(?: \\([^)]*\\))?(?: \\[[^\\]]*\\])?(?: at (${SPOT}))?`),
  directSnap: re(`^Direct snap to (${NAME})`),
  skip: re(`^(?:short of landing zone|impetus ends at ${SPOT}|NULLIFIED by Penalty|\\(Virtual Measurement\\)|ATTEMPT (?:SUCCEEDS|FAILS)|TWO-POINT CONVERSION ATTEMPT)\\.?`),
  // An older summary style: "Kevin Coleman Jr. 3 Yd pass from Malik Willis (...)"
  summary: /^([A-Z][A-Za-z.' -]+?) (\d+) Yd (Run|pass from ([A-Z][A-Za-z.' -]+?)|Fumble Return|Interception Return|Kickoff Return|Punt Return)\b(?: \((.*)\))?/,
  isResult: /^is (complete|incomplete)/,
  sack: re(`^(${NAME}) sacked`),
  scramble: re(`^(${NAME}) scrambles(?: (${GAP}))?`),
  kneel: re(`^(${NAME}) kneels`),
  spike: re(`^(${NAME}) spiked the ball`),
  aborted: re(`^(${NAME}) (?:FUMBLES \\(Aborted\\)|Aborted)(?: at (${SPOT}))?`),
  fumbleAt: re(`^(${NAME}) FUMBLES(?: \\((${NAME})\\))? at (${SPOT})`),
  rush: re(`^(${NAME}) (${GAP})`),
  carry: re(`^(${NAME})(?= (?:to |pushed ob |ran ob |for |at ))`),
  lateral: re(`^(?:Lateral|Handoff) to (${NAME})`),
  fumble: re(`^FUMBLES(?: \\((${NAME})\\))?(?: \\[[^\\]]*\\])?`),
  muff: re(`^(${NAME}) MUFFS catch`),
  touched: re(`^touched at (${SPOT})`),
  recovered: re(`^(?:and )?(?:RECOVERED|recovered) by ([A-Z]{2,3})-(${NAME})(?: at (${SPOT}))?`),
  recovers: re(`^and recovers(?: at (${SPOT}))?`),
  ballOob: re(`^ball out of bounds(?: at (${SPOT}))?`),
  fairCatch: re(`^fair catch by (${NAME})`),
  downed: re(`^downed by(?: [A-Z]{2,3}-(${NAME}))?`),
  outOfBounds: /^out of bounds/,
  touchback: /^Touchback(?: to the (?:[A-Z]{2,3} )?\d+)?/,
  touchdown: /^TOUCHDOWN(?! NULLIFIED)/,
  nullified: /^TOUCHDOWN NULLIFIED by Penalty/,
  timeout: /^Timeout #(\d) by ([A-Z]{2,3})/,
  stoppage: /^(Official Timeout|END QUARTER|END GAME|Two-Minute Warning|END OF|End of|Two Minute Warning)/i,
  penalty: re(`(?:PENALTY|Penalty) on ([A-Z]{2,3})(?:-(${NAME}))?, ([^,]+)(?:, (\\d+) yards?)?(?:, (enforced at (${SPOT})|enforced between downs|declined|offsetting|enforced at [^.]*))?([^.]*?- No Play)?`, 'g'),
};

// ---------------------------------------------------------------- context --

// Learns which abbreviation is which side. The feed's own team abbreviations
// ("BAL") are not always the ones in its sentences ("BLT"), but every play's
// start spot is given both as text ("BLT 23") and as an x, so the mapping
// falls out of the data.
export function gameContext(game) {
  const home = game.home, away = game.away;
  const alias = new Map([[home.abbr, home.id], [away.abbr, away.id]]);
  for (const p of game.plays) {
    for (const s of [p.start, p.end]) {
      const m = s?.text?.match(/^([A-Z]{2,3}) (\d{1,2})$/);
      if (!m || !Number.isFinite(s.yardLine) || alias.has(m[1])) continue;
      const n = +m[1 + 1];
      if (n === 50) continue;
      if (s.yardLine === n) alias.set(m[1], home.id);
      else if (s.yardLine === 100 - n) alias.set(m[1], away.id);
    }
  }
  const fuzzy = a => {
    let best = null, score = -1;
    for (const t of [home, away]) {
      let s = 0;
      while (s < a.length && s < t.abbr.length && a[s] === t.abbr[s]) s++;
      s += [...a].filter(c => t.abbr.includes(c)).length * 0.1;
      if (s > score) { score = s; best = t.id; }
    }
    return best;
  };
  const teamOf = abbr => {
    if (!alias.has(abbr)) alias.set(abbr, fuzzy(abbr));
    return alias.get(abbr);
  };
  const spotX = str => {
    if (!str) return null;
    if (str === '50') return 50;
    if (/end zone/.test(str)) return null;
    const m = str.match(/^([A-Z]{2,3}) (-?\d{1,2})$/);
    if (!m) return null;
    return teamOf(m[1]) === home.id ? +m[2] : 100 - +m[2];
  };
  const dir = teamId => (teamId === home.id ? 1 : -1);
  const other = teamId => (teamId === home.id ? away.id : home.id);
  return { game, home, away, alias, teamOf, spotX, dir, other, roster: game.roster || {} };
}

// ------------------------------------------------------------------ clean --

function clean(text) {
  let t = ` ${text} `;
  // A reversed ruling restates the play as it stands after the review.
  const rev = t.lastIndexOf('REVERSED.');
  if (rev >= 0) t = t.slice(rev + 'REVERSED.'.length);
  t = t
    .replace(re(`\\*\\*\\s*Injury Update:\\s*(?:[A-Z]{2,3}-)?(?:${NAME})?[^.*]*\\.?`, 'gi'), '')
    .replace(/The Replay Official reviewed.*?(?:Upheld|upheld|confirmed|stands)\.?/g, '')
    .replace(/The play was challenged by.*?(?:Upheld|upheld|confirmed|stands)\.?/g, '')
    .replace(/(?:^|(?<=\.))\s*[A-Z][a-z]+(?: [A-Z][a-z0-9]+)* challenged the .*?(?:Upheld|upheld|confirmed|stands)\.?/g, ' ')
    .replace(/\d+-second runoff\.?/g, '')
    .replace(/The ruling on the field (?:stands|is confirmed)\.?/g, '')
    .replace(/The [a-z ]+ was assisted by replay\.?/g, '')
    .replace(/\(Timeout #\d\.?\)/g, '')
    .replace(/\(didn't try to advance\)/g, '')
    .replace(re(`(?:[A-Z]{2,3}-)?${NAME} was injured during the play\\.?`, 'g'), '')
    .replace(re(`(?:${NAME}(?:,| and) )*${NAME} reported in as eligible\\.?`, 'g'), '')
    .replace(/Direction is (?:Inside|Outside)[^.]*\.?/g, '');
  return t.replace(/\s+/g, ' ').trim();
}

// --------------------------------------------------------------- penalties --

function parsePenalties(s, ctx) {
  const out = [];
  for (const m of s.matchAll(R.penalty)) {
    const [, abbr, player, foul, yards, how, , noPlay] = m;
    out.push({
      team: ctx.teamOf(abbr),
      player: player || null,
      foul: foul.trim(),
      yards: yards ? +yards : 0,
      declined: /declined/.test(how || ''),
      offsetting: /offsetting/.test(how || ''),
      enforcedX: ctx.spotX(m[6]),
      noPlay: !!noPlay || /No Play/.test(m[0]),
    });
  }
  return out;
}

// ------------------------------------------------------------------- legs --

// Reads what comes after someone has the ball: " to KC 33 for 6 yards
// (D.Lawrence)." Returns the leg's end and how it ended.
function carryTail(s, ctx, who, fromX) {
  const out = { toX: null, yards: null, td: false, oob: false, tacklers: [], pressure: [], touchback: false, rest: s };
  const dir = ctx.dir(who.team);
  for (let guard = 0; guard < 12; guard++) {
    let m;
    if ((m = s.match(re(`^,? (to|pushed ob at|ran ob at|sacked at|sacked ob at|at) (${SPOT})`)))) {
      out.toX = ctx.spotX(m[2]);
      if (/ob/.test(m[1])) out.oob = true;
    } else if ((m = s.match(/^ (?:to )?(?:the )?end zone/))) {
      out.toX = dir > 0 ? 104 : -4;
    } else if ((m = s.match(/^,? for (-?\d+) yards?/))) {
      out.yards = +m[1];
    } else if ((m = s.match(/^,? for no gain/))) {
      out.yards = 0;
    } else if ((m = s.match(/^,? TOUCHDOWN NULLIFIED by Penalty/))) {
      out.nullified = true;
    } else if ((m = s.match(/^,? TOUCHDOWN/))) {
      out.td = true;
    } else if ((m = s.match(/^ \(([^)]*)\)/))) {
      out.tacklers.push(...names(m[1]));
    } else if ((m = s.match(/^ \[([^\]]*)\]/))) {
      out.pressure.push(...names(m[1]));
    } else if ((m = s.match(/^,? Touchback\.?/))) {
      out.touchback = true;
    } else break;
    s = s.slice(m[0].length);
  }
  if (out.toX == null) {
    if (out.td) out.toX = dir > 0 ? 100 + Math.min(4, Math.max(1, (out.yards ?? 1) * 0.05)) : -Math.min(4, Math.max(1, (out.yards ?? 1) * 0.05));
    else if (out.yards != null) out.toX = fromX + dir * out.yards;
    else out.toX = fromX;
  }
  if (out.td) out.toX = dir > 0 ? Math.max(out.toX, 100.5) : Math.min(out.toX, -0.5);
  out.rest = s;
  return out;
}

const names = list => list.split(/[;,]\s*/).map(n => n.trim()).filter(n => /^[A-Z][A-Za-z]{0,2}\./.test(n));

function parseLegs(text, ctx, offense, los) {
  const legs = [];
  const defense = ctx.other(offense);
  let s = text;
  let x = los;
  let holder = null; // { name, team }
  let lastKick = null;
  let unparsed = '';
  const who = (name, team) => ({ name, team });
  const teamByName = (name, fallback) => {
    const r = ctx.roster[name];
    return r ? r.teamId : fallback;
  };

  for (let guard = 0; guard < 40 && s; guard++) {
    s = s.replace(/^[\s.,;]+/, '');
    if (!s) break;
    let m;

    if ((m = s.match(R.formation))) { s = s.slice(m[0].length); continue; }

    if ((m = s.match(R.kickoff))) {
      const kicker = who(m[1], offense);
      const fromX = ctx.spotX(m[4]) ?? x;
      const recv = ctx.other(offense);
      let toX = ctx.spotX(m[5]);
      if (toX == null) toX = ctx.dir(offense) > 0 ? 105 : -5;
      legs.push({ k: 'kick', kind: m[2] ? 'onside' : 'kickoff', who: kicker, fromX, toX, yards: +m[3] });
      lastKick = legs.at(-1);
      x = toX; holder = null;
      s = s.slice(m[0].length);
      // whoever carries next is the receiving team unless stated
      holder = { name: null, team: recv };
      continue;
    }
    if ((m = s.match(R.punt))) {
      const fromX = x - ctx.dir(offense) * 14;
      let toX = ctx.spotX(m[3]);
      if (toX == null) toX = ctx.dir(offense) > 0 ? 105 : -5;
      legs.push({ k: 'snap', to: 'punter' });
      legs.push({ k: 'kick', kind: 'punt', who: who(m[1], offense), fromX, toX, yards: +m[2] });
      lastKick = legs.at(-1);
      x = toX;
      holder = { name: null, team: ctx.other(offense) };
      s = s.slice(m[0].length);
      continue;
    }
    if ((m = s.match(R.puntBlocked))) {
      const fromX = x - ctx.dir(offense) * 14;
      legs.push({ k: 'snap', to: 'punter' });
      legs.push({ k: 'kick', kind: 'punt', who: who(m[1], offense), fromX, toX: fromX - ctx.dir(offense) * 3, yards: 0, result: 'blocked', blockedBy: m[2] || null });
      lastKick = legs.at(-1);
      x = lastKick.toX;
      holder = null;
      s = s.slice(m[0].length);
      continue;
    }
    if ((m = s.match(R.fg)) || (m = s.match(R.xp))) {
      const isXp = /extra point/.test(m[0]);
      const d = ctx.dir(offense);
      const goal = d > 0 ? 110 : -10;
      // A field goal's yardage is measured from the hold to the posts.
      const fromX = isXp ? (d > 0 ? 77 : 23) : goal - d * +m[2];
      const result = m[3] === 'GOOD' ? 'good' : m[3] === 'BLOCKED' ? 'blocked' : 'nogood';
      legs.push({ k: 'snap', to: 'holder' });
      legs.push({ k: 'kick', kind: isXp ? 'xp' : 'fg', who: who(m[1], offense), fromX, toX: result === 'blocked' ? fromX + d * 2 : goal, yards: isXp ? 33 : +m[2], result, miss: m[5] || null, blockedBy: m[4] || null });
      lastKick = legs.at(-1);
      x = lastKick.toX;
      s = s.slice(m[0].length);
      continue;
    }
    if ((m = s.match(R.center)) || (m = s.match(R.skip))) { s = s.slice(m[0].length); continue; }
    if ((m = s.match(R.directSnap))) {
      const r = who(m[1], offense);
      legs.push({ k: 'snap', to: 'direct', who: r });
      holder = r;
      s = s.slice(m[0].length);
      continue;
    }
    if (!legs.length && (m = s.match(R.summary))) {
      const short = full => {
        const w = full.replace(/ (Jr|Sr|II|III|IV)\.?$/, '').split(' ');
        return `${w[0][0]}.${w.slice(1).join(' ')}`;
      };
      const scorer = who(short(m[1]), offense);
      const toX = ctx.dir(offense) > 0 ? 101 : -1;
      legs.push({ k: 'snap', to: 'qb' });
      if (m[4]) {
        legs.push({ k: 'pass', who: who(short(m[4]), offense), target: scorer, depth: +m[2] > 15 ? 'deep' : 'short', side: 'middle', result: 'complete', fromX: x, gain: toX });
        legs.push({ k: 'run', who: scorer, fromX: null, toX, td: true, tacklers: [], afterCatch: true });
      } else {
        legs.push({ k: 'hand', to: scorer });
        legs.push({ k: 'run', who: scorer, fromX: x, toX, td: true, tacklers: [], lane: 0 });
      }
      x = toX; holder = scorer;
      s = '';
      continue;
    }

    if ((m = s.match(R.pass))) {
      const passer = who(m[1], holder?.team ?? offense);
      const target = m[6] ? who(m[6], passer.team) : null;
      const leg = { k: 'pass', who: passer, target, depth: m[3] || 'short', side: m[4] || 'middle', result: m[2] ? 'incomplete' : 'complete', fromX: x };
      if (!legs.some(l => l.k === 'snap')) legs.push({ k: 'snap', to: 'qb' });
      s = s.slice(m[0].length);
      let r;
      if ((r = s.match(/^ (is (complete|incomplete))/))) { leg.result = r[2]; s = s.slice(r[0].length); }
      const s2 = s.replace(/^\.?\s*/, '');
      if ((r = s2.match(R.intercepted))) {
        s = s2.slice(r[0].length);
        leg.result = 'intercepted';
        const by = who(r[1], ctx.other(passer.team));
        leg.by = by;
        const atX = ctx.spotX(r[2]);
        leg.atX = atX ?? x + ctx.dir(passer.team) * (leg.depth === 'deep' ? 25 : 8);
        legs.push(leg);
        x = leg.atX;
        holder = by;
        continue;
      }
      if (leg.result === 'incomplete') {
        let tail;
        while ((tail = s.match(/^ (\(([^)]*)\)|\[([^\]]*)\])/))) {
          if (tail[2]) leg.defenders = names(tail[2]);
          if (tail[3]) leg.pressure = names(tail[3]);
          s = s.slice(tail[0].length);
        }
        legs.push(leg);
        x = los; // an incompletion goes back to the previous spot
        continue;
      }
      // complete: the target carries from the catch to the tail's spot
      legs.push(leg);
      const carrier = target || who(null, passer.team);
      const t = carryTail(s, ctx, carrier, x);
      s = t.rest;
      leg.gain = t.toX;
      legs.push({ k: 'run', who: carrier, fromX: null, toX: t.toX, td: t.td, oob: t.oob, tacklers: t.tacklers, afterCatch: true });
      if (t.pressure.length) leg.pressure = t.pressure;
      x = t.toX; holder = carrier;
      continue;
    }
    if ((m = s.match(R.intercepted))) {
      // "pass ... INTERCEPTED" with no target
      const prev = legs.findLast(l => l.k === 'pass');
      const by = who(m[1], defense);
      if (prev) { prev.result = 'intercepted'; prev.by = by; prev.atX = ctx.spotX(m[2]) ?? x; x = prev.atX; }
      holder = by;
      s = s.slice(m[0].length);
      continue;
    }
    if ((m = s.match(R.sack))) {
      const qb = who(m[1], offense);
      if (!legs.some(l => l.k === 'snap')) legs.push({ k: 'snap', to: 'qb' });
      s = s.slice(m[0].length);
      // "sacked" is consumed; carryTail reads " at KC 30 for -7 yards (T)".
      const oob = /^ ob at/.test(s);
      const t = carryTail(s.replace(/^ ob at/, ' at'), ctx, qb, x);
      s = t.rest;
      legs.push({ k: 'sack', who: qb, fromX: x, toX: t.toX, tacklers: t.tacklers, oob });
      x = t.toX; holder = qb;
      continue;
    }
    if ((m = s.match(R.scramble))) {
      const qb = who(m[1], offense);
      if (!legs.some(l => l.k === 'snap')) legs.push({ k: 'snap', to: 'qb' });
      s = s.slice(m[0].length);
      const t = carryTail(s, ctx, qb, x);
      s = t.rest;
      legs.push({ k: 'run', who: qb, fromX: x, toX: t.toX, td: t.td, oob: t.oob, tacklers: t.tacklers, lane: GAP_LANE[m[2]] ?? 0, scramble: true });
      x = t.toX; holder = qb;
      continue;
    }
    if ((m = s.match(R.kneel))) {
      const qb = who(m[1], offense);
      legs.push({ k: 'snap', to: 'qb' });
      s = s.slice(m[0].length);
      const t = carryTail(s, ctx, qb, x);
      s = t.rest;
      legs.push({ k: 'kneel', who: qb, fromX: x, toX: t.toX });
      x = t.toX; holder = qb;
      continue;
    }
    if ((m = s.match(R.spike))) {
      legs.push({ k: 'snap', to: 'qb' });
      legs.push({ k: 'spike', who: who(m[1], offense), fromX: x });
      s = s.slice(m[0].length).replace(/^ to stop the clock/, '');
      continue;
    }
    if ((m = s.match(R.aborted))) {
      const qb = who(m[1], offense);
      legs.push({ k: 'snap', to: 'qb', aborted: true });
      const at = ctx.spotX(m[2]) ?? x;
      if (m[2]) legs.push({ k: 'fumble', who: qb, atX: at, forcedBy: null });
      x = at; holder = m[2] ? null : qb;
      s = s.slice(m[0].length);
      continue;
    }
    if ((m = s.match(R.fumbleAt))) {
      // "J.Majors FUMBLES at PHI 43" after an aborted snap
      const f = who(m[1], holder?.team ?? offense);
      const at = ctx.spotX(m[3]) ?? x;
      legs.push({ k: 'fumble', who: f, atX: at, forcedBy: m[2] || null });
      x = at; holder = null;
      s = s.slice(m[0].length);
      continue;
    }
    if ((m = s.match(R.rush))) {
      const team = holder?.team ?? offense;
      const runner = who(m[1], team);
      if (!legs.some(l => l.k === 'snap')) {
        legs.push({ k: 'snap', to: 'qb' });
        legs.push({ k: 'hand', to: runner });
      }
      s = s.slice(m[0].length);
      const t = carryTail(s, ctx, runner, x);
      s = t.rest;
      legs.push({ k: 'run', who: runner, fromX: x, toX: t.toX, td: t.td, oob: t.oob, tacklers: t.tacklers, lane: GAP_LANE[m[2]] });
      x = t.toX; holder = runner;
      continue;
    }
    if ((m = s.match(R.lateral))) {
      const team = holder?.team ?? offense;
      const runner = who(m[1], team);
      legs.push({ k: 'hand', to: runner, lateral: /Lateral/.test(m[0]) });
      s = s.slice(m[0].length);
      const t = carryTail(s, ctx, runner, x);
      s = t.rest;
      legs.push({ k: 'run', who: runner, fromX: x, toX: t.toX, td: t.td, oob: t.oob, tacklers: t.tacklers });
      x = t.toX; holder = runner;
      continue;
    }
    if ((m = s.match(R.muff))) {
      const r = who(m[1], holder?.team ?? ctx.other(offense));
      legs.push({ k: 'catch', who: r, atX: x, muff: true });
      legs.push({ k: 'fumble', who: r, atX: x, muff: true });
      holder = null;
      s = s.slice(m[0].length);
      continue;
    }
    if ((m = s.match(R.fairCatch))) {
      const r = who(m[1], holder?.team ?? ctx.other(offense));
      if (lastKick) lastKick.result = 'fair';
      legs.push({ k: 'catch', who: r, atX: x, fair: true });
      holder = r;
      s = s.slice(m[0].length);
      continue;
    }
    if ((m = s.match(R.downed))) {
      if (lastKick) lastKick.result = 'downed';
      legs.push({ k: 'dead', atX: x, how: 'downed', by: m[1] || null });
      s = s.slice(m[0].length);
      continue;
    }
    if ((m = s.match(R.outOfBounds))) {
      if (lastKick) lastKick.result = lastKick.result || 'oob';
      legs.push({ k: 'dead', atX: x, how: 'oob' });
      s = s.slice(m[0].length);
      continue;
    }
    if ((m = s.match(R.touchback))) {
      if (lastKick && !lastKick.result) lastKick.result = 'touchback';
      legs.push({ k: 'dead', atX: x, how: 'touchback' });
      s = s.slice(m[0].length);
      continue;
    }
    if ((m = s.match(R.fumble))) {
      const prev = holder || legs.findLast(l => l.who)?.who || who(null, offense);
      legs.push({ k: 'fumble', who: prev, atX: x, forcedBy: m[1] || null });
      holder = null;
      s = s.slice(m[0].length);
      continue;
    }
    if ((m = s.match(R.touched))) {
      const f = legs.findLast(l => l.k === 'fumble');
      if (f) f.touchedX = ctx.spotX(m[1]);
      s = s.slice(m[0].length);
      continue;
    }
    if ((m = s.match(R.recovered))) {
      const team = ctx.teamOf(m[1]);
      const r = who(m[2], team);
      const at = ctx.spotX(m[3]) ?? x;
      legs.push({ k: 'recover', who: r, atX: at });
      x = at; holder = r;
      s = s.slice(m[0].length);
      continue;
    }
    if ((m = s.match(R.recovers))) {
      const f = legs.findLast(l => l.k === 'fumble');
      const r = f?.who?.name ? f.who : who(null, offense);
      const at = ctx.spotX(m[1]) ?? x;
      legs.push({ k: 'recover', who: r, atX: at });
      x = at; holder = r;
      s = s.slice(m[0].length);
      continue;
    }
    if ((m = s.match(R.ballOob))) {
      const at = ctx.spotX(m[1]) ?? x;
      legs.push({ k: 'dead', atX: at, how: 'oob' });
      x = at;
      s = s.slice(m[0].length);
      continue;
    }
    if ((m = s.match(R.nullified))) { s = s.slice(m[0].length); continue; }
    if ((m = s.match(R.touchdown))) {
      const last = legs.findLast(l => l.k === 'run' || l.k === 'recover');
      if (last) last.td = true;
      s = s.slice(m[0].length);
      continue;
    }
    if ((m = s.match(R.carry))) {
      // "N.Remigio pushed ob at KC 42 for 44 yards", "J.Sanker for 87 yards,
      // TOUCHDOWN", or a returner after a kick.
      const team = holder?.team ?? teamByName(m[1], offense);
      const runner = who(m[1], team);
      if (lastKick && !holder?.name && legs.at(-1) === lastKick) {
        legs.push({ k: 'catch', who: runner, atX: x });
        lastKick.result = lastKick.result || 'return';
      } else if (!legs.length) {
        legs.push({ k: 'snap', to: 'qb' });
        legs.push({ k: 'hand', to: runner });
      }
      s = s.slice(m[0].length);
      const t = carryTail(s, ctx, runner, x);
      s = t.rest;
      legs.push({ k: 'run', who: runner, fromX: x, toX: t.toX, td: t.td, oob: t.oob, tacklers: t.tacklers, lane: null });
      x = t.toX; holder = runner;
      continue;
    }
    // Something we do not read. Skip to the next sentence and keep going.
    const stop = s.search(/(?<=[a-z0-9)\]])\. (?=[A-Z(])/);
    unparsed += (unparsed ? ' | ' : '') + (stop >= 0 ? s.slice(0, stop) : s);
    if (stop < 0) break;
    s = s.slice(stop + 2);
  }
  return { legs, endX: x, unparsed };
}

// -------------------------------------------------------------- the play --

export function parsePlay(play, ctx) {
  const text = clean(play.text || '');
  const offense = play.start?.teamId || play.driveTeam || ctx.home.id;
  const defense = ctx.other(offense);
  const startX = Number.isFinite(play.start?.yardLine) ? play.start.yardLine : 50;
  const endXFeed = Number.isFinite(play.end?.yardLine) ? play.end.yardLine : null;
  const base = {
    id: play.id, seq: play.seq, type: play.type, text: play.text, call: text,
    offense, defense, los: startX, dir: ctx.dir(offense),
    period: play.period, clock: play.clock, wallclock: play.wallclock,
    down: play.start?.down || 0, distance: play.start?.distance || 0,
    homeScore: play.homeScore, awayScore: play.awayScore,
    legs: [], after: [], penalties: [], noPlay: false,
    shotgun: /Shotgun/.test(text), noHuddle: /No Huddle/.test(text),
    endX: endXFeed ?? startX, nextX: endXFeed, unparsed: '',
  };

  // Stoppages carry no ball movement.
  let m;
  if ((m = text.match(R.timeout))) return { ...base, kind: 'timeout', team: ctx.teamOf(m[2]), number: +m[1] };
  if (R.stoppage.test(text) || /^(End|END)/.test(play.type) || /Timeout|Two-minute|Two Minute|Warning/.test(play.type) && !/Return|Pass|Rush|Kick/.test(play.type)) {
    return { ...base, kind: 'stoppage', label: text };
  }

  // Penalties are reported after the play they were called on.
  const pi = text.search(/(?:PENALTY|Penalty) on /);
  let action = pi >= 0 ? text.slice(0, pi) : text;
  if (pi >= 0) base.penalties = parsePenalties(text.slice(pi), ctx);
  base.noPlay = base.penalties.some(p => p.noPlay && !p.declined);

  // Extra point / two-point try after a touchdown.
  const tdEnd = action.search(/TOUCHDOWN(?! NULLIFIED)\.? /);
  let afterText = '';
  if (tdEnd >= 0) {
    const cut = action.indexOf(' ', tdEnd + 'TOUCHDOWN'.length);
    afterText = action.slice(cut + 1);
    action = action.slice(0, cut);
  }
  const twoPt = afterText.match(/TWO-POINT CONVERSION ATTEMPT\. (.*?)\.? ATTEMPT (SUCCEEDS|FAILS)/);
  if (twoPt) base.after.push({ kind: 'twopt', good: twoPt[2] === 'SUCCEEDS', text: twoPt[1] });
  const xp = afterText.match(re(R.xp.source.slice(1)));
  if (xp) base.after.push({ kind: 'xp', kicker: xp[1], good: xp[2] === 'GOOD', miss: xp[4] || null });

  const { legs, endX, unparsed } = parseLegs(action, ctx, offense, startX);
  base.legs = legs;
  base.unparsed = unparsed;
  if (Number.isFinite(endX)) base.endX = endX;

  // The play's kind is what the first ball-moving leg did.
  const first = legs.find(l => l.k !== 'snap' && l.k !== 'hand');
  const kick = legs.find(l => l.k === 'kick');
  if (kick) base.kind = kick.kind === 'onside' ? 'kickoff' : kick.kind;
  else if (legs.some(l => l.k === 'pass')) base.kind = 'pass';
  else if (legs.some(l => l.k === 'sack')) base.kind = 'sack';
  else if (legs.some(l => l.k === 'kneel')) base.kind = 'kneel';
  else if (legs.some(l => l.k === 'spike')) base.kind = 'spike';
  else if (legs.some(l => l.k === 'run')) base.kind = legs.find(l => l.k === 'run').scramble ? 'scramble' : 'rush';
  else if (first?.k === 'fumble') base.kind = 'rush';
  else if (!legs.length && base.penalties.length) base.kind = 'penalty';
  else base.kind = 'unknown';

  if (base.kind === 'unknown' && !legs.length) {
    // Fall back on the feed's own start and end spots.
    const to = endXFeed ?? startX;
    base.legs = [{ k: 'snap', to: 'qb' }, { k: 'run', who: { name: null, team: offense }, fromX: startX, toX: to, tacklers: [] }];
    base.endX = to;
  }
  // A play wiped out by a pre-snap foul: the ball goes where the feed says.
  if (base.kind === 'penalty' && endXFeed != null) base.endX = endXFeed;

  const td = legs.findLast(l => l.td);
  base.touchdown = td ? td.who.team : null;
  base.scoring = play.scoring;
  return base;
}

export function parseGame(game) {
  const ctx = gameContext(game);
  return { ctx, actions: game.plays.map(p => parsePlay(p, ctx)) };
}
