// Action -> motion.
//
// The parser says what the BALL did. This file invents everyone else: it
// lines up 22 players and 4 officials, lays the ball's legs out in time, and
// runs a small fixed-step simulation in which the players the description
// NAMES follow exact paths (the passer, the receiver, the runner, the
// tacklers -- they have to be where the words put them) and everyone else
// steers by role: linemen block, rushers rush, corners mirror, the rest
// pursue the ball.
//
// The result is a CLIP: positions for every body at 30 frames a second, the
// ball's path, and a list of events (snap, catch, tackle, flag...) for the
// sound and the broadcast graphics. A clip is a pure function of the action,
// the cast and the starting ball spot, so a play can be scrubbed, replayed
// and seeked without re-simulating anything.
//
// Units are yards. Field frame as in parse.js: x from the home goal line
// (0) to the away goal line (100), y across (+-26.65 to the sidelines).

import { OFF, DEF, S, PREF } from './cast.js';

export const FPS = 30;
export const N_PLAYERS = 22;
export const N_ACTORS = 26; // 22 players + referee, two wing officials, back judge
export const FIELD_Y = 26.65;
export const HASH_Y = 3.08;
export const POSE = { STAND: 0, RUN: 1, STANCE: 2, DOWN: 3, KNEEL: 4, CATCH: 5, THROW: 6, CELEBRATE: 7, KICK: 8, BLOCK: 9, DIVE: 10, SIGNAL: 11 };

const SPEED = { OL: 5.2, DL: 6.2, LB: 7.2, QB: 7.0, RB: 8.2, WR: 8.6, TE: 7.4, DB: 8.4, K: 6.5, REF: 5.5 };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);
const clampY = y => clamp(y, -FIELD_Y + 0.6, FIELD_Y - 0.6);

function rng(seedStr) {
  let h = 2166136261;
  for (const c of String(seedStr)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------- formations --
// (s, v): s along the offense's attack direction from the line (negative =
// offense's backfield), v to the offense's LEFT.

function offenseForm(shotgun) {
  return [
    [-1.0, 2.6], [-0.9, 1.3], [-0.6, 0], [-0.9, -1.3], [-1.0, -2.6],
    [shotgun ? -5.0 : -1.3, 0], [shotgun ? -5.0 : -7.0, shotgun ? -1.8 : 0],
    [-1.1, -4.0], [-1.0, 18], [-1.6, -17], [-1.6, 9.5],
  ];
}
const DEFENSE_FORM = [
  [1.0, 3.8], [1.0, 1.0], [1.0, -1.1], [1.0, -3.8],
  [4.6, 4.5], [5.0, 0.3], [4.6, -4.5],
  [6.5, 17.5], [6.5, -16.5], [12, 8], [13, -8],
];
const PUNT_FORM = [
  [-1.0, 2.6], [-0.9, 1.3], [-0.6, 0], [-0.9, -1.3], [-1.0, -2.6],
  [-14.5, 0], [-5.0, 0.9], [-1.2, -3.8], [-1.0, 21], [-1.0, -21], [-1.2, 3.8],
];
const PUNT_RETURN_FORM = [
  [1.0, 3.2], [1.0, 1.0], [1.0, -1.0], [1.0, -3.2],
  [4.0, 3.5], null /* returner */, [4.0, -3.5],
  [1.0, 19.5], [1.0, -19.5], [9, 6], [9, -6],
];
const PLACE_FORM = [
  [-0.9, 2.6], [-0.85, 1.3], [-0.6, 0], [-0.85, -1.3], [-0.9, -2.6],
  [-9.6, 2.2], [-7.0, 0.2], [-1.0, -3.9], [-1.5, 5.4], [-1.5, -5.4], [-1.0, 3.9],
];
const PLACE_BLOCK_FORM = [
  [1.0, 3.0], [1.0, 1.0], [1.0, -1.0], [1.0, -3.0],
  [1.2, 5.0], [1.2, 0.0], [1.2, -5.0], [1.4, 7.2], [1.4, -7.2], [8, 3], [8, -3],
];

// ------------------------------------------------------------------- sim --

class Body {
  constructor(i, team, slot, kind, speed) {
    Object.assign(this, { i, team, slot, kind, maxSpeed: speed });
    this.x = 0; this.y = 0; this.vx = 0; this.vy = 0; this.h = 0;
    this.phases = []; // {t0, t1?, type: 'path'|'seek'|'hold', ...}
    this.poses = [];  // {t0, t1, pose}
    this.face = 0;    // default facing (radians) when idle
    this.contact = 0;
  }
  phase(p) { this.phases.push(p); this.phases.sort((a, b) => a.t0 - b.t0); }
  pose(t0, t1, pose) { this.poses.push({ t0, t1, pose }); }
  activePhase(t) {
    let a = null;
    for (const p of this.phases) if (p.t0 <= t + 1e-6) a = p; else break;
    return a;
  }
  poseAt(t) {
    for (let k = this.poses.length - 1; k >= 0; k--) {
      const p = this.poses[k];
      if (t >= p.t0 && t < p.t1) return p.pose;
    }
    return null;
  }
}

function pathPoint(pts, f) {
  // f in [0,1] along the polyline by length
  let total = 0;
  const seg = [];
  for (let k = 1; k < pts.length; k++) {
    const d = dist(pts[k - 1][0], pts[k - 1][1], pts[k][0], pts[k][1]);
    seg.push(d); total += d;
  }
  if (total < 1e-6) return pts[pts.length - 1];
  let want = f * total;
  for (let k = 0; k < seg.length; k++) {
    if (want <= seg[k] || k === seg.length - 1) {
      const u = seg[k] ? clamp(want / seg[k], 0, 1) : 1;
      return [lerp(pts[k][0], pts[k + 1][0], u), lerp(pts[k][1], pts[k + 1][1], u)];
    }
    want -= seg[k];
  }
  return pts[pts.length - 1];
}

const EASE = {
  linear: u => u,
  smooth: u => u * u * (3 - 2 * u),
  out: u => 1 - (1 - u) * (1 - u),            // starts at speed, arrives slowing
  in: u => u * u,                              // starts from rest
  run: u => (u < 0.25 ? 2 * u * u : 0.125 + (u - 0.25) * (0.875 / 0.75)), // accelerate then hold speed
};

// --------------------------------------------------------------- the play --

class Play {
  constructor(action, ctx, cast, opts) {
    this.a = action;
    this.ctx = ctx;
    this.cast = cast;
    this.rand = rng(action.id || action.text);
    this.dir = action.dir;
    this.los = action.los;
    this.by = clamp(opts.ballY ?? 0, -HASH_Y, HASH_Y);
    this.off = action.offense;
    this.def = action.defense;
    this.bodies = [];
    this.events = [];
    this.labels = [];
    this.ball = []; // phases: {t0, type:'held', who} | {t0, t1, type:'flight', from, to, apex, toWho?} | {t0, type:'rest', x, y, z}
    this.whistle = Infinity;
    this.end = 6;
    this.units = { [this.off]: 'off', [this.def]: 'def' };
    this.live = { carrier: -1, flight: null, thrown: false, passPlay: false, runPlay: false, kickPlay: false };
    this.firstDownX = null;
  }

  base(team) { return team === this.ctx.home.id ? 0 : 11; }
  actor(team, slot) { return this.bodies[this.base(team) + slot]; }
  // world position for formation coordinates
  at(s, v) { return [this.los + this.dir * s, clampY(this.by + this.dir * v)]; }
  // offense-relative coordinates of a world point
  rel(x, y) { return [(x - this.los) * this.dir, (y - this.by) * this.dir]; }

  event(t, type, extra = {}) { this.events.push({ t, type, ...extra }); }
  label(body, t0, t1, name) {
    if (!body || !name) return;
    const r = this.ctx.roster[name];
    const last = name.replace(/^[A-Z][A-Za-z]{0,2}\./, '');
    this.labels.push({ actor: body.i, t0, t1, text: last.toUpperCase(), jersey: r?.jersey || '' });
  }

  setupBodies(offUnit, defUnit) {
    this.units = { [this.off]: offUnit, [this.def]: defUnit };
    for (const [team, unit] of [[this.ctx.home.id, null], [this.ctx.away.id, null]]) {
      void unit;
      const u = this.units[team];
      for (let slot = 0; slot < 11; slot++) {
        const role = (u === 'off' || u === 'kick') ? OFF[slot] : DEF[slot];
        const kind = /^(LT|LG|C|RG|RT)$/.test(role) ? 'OL' : /^(DE|DT)/.test(role) ? 'DL' : /^LB/.test(role) ? 'LB'
          : role === 'QB' ? 'QB' : role === 'RB' ? 'RB' : role === 'TE' ? 'TE' : /^WR/.test(role) ? 'WR' : 'DB';
        this.bodies[this.base(team) + slot] = new Body(this.base(team) + slot, team, slot, kind, SPEED[kind] * (0.95 + this.rand() * 0.1));
      }
    }
    for (let k = 0; k < 4; k++) {
      const b = new Body(N_PLAYERS + k, 'ref', k, 'REF', SPEED.REF);
      this.bodies.push(b);
    }
  }

  placeForm(team, form, flip) {
    // flip: formation written from the defense's side (s positive downfield)
    for (let slot = 0; slot < 11; slot++) {
      const f = form[slot];
      if (!f) continue;
      const b = this.actor(team, slot);
      [b.x, b.y] = this.at(f[0], f[1]);
      b.home = [b.x, b.y];
      b.face = flip ? (this.dir > 0 ? Math.PI : 0) : (this.dir > 0 ? 0 : Math.PI);
      b.h = b.face;
    }
  }

  placeOfficials() {
    const r = this.bodies.slice(N_PLAYERS);
    [r[0].x, r[0].y] = this.at(-12, 4);
    [r[1].x, r[1].y] = [this.los, FIELD_Y + 1.6];
    [r[2].x, r[2].y] = [this.los, -FIELD_Y - 1.6];
    [r[3].x, r[3].y] = this.at(22, 0);
    for (const b of r) { b.home = [b.x, b.y]; b.face = Math.atan2(this.by - b.y, this.los - b.x); b.h = b.face; }
    // officials follow the ball at a walk-to-jog, the wing officials along their sideline
    r[0].phase({ t0: 0, type: 'seek', fn: () => { const [bx, by] = this.ballXY(); return [bx - this.dir * 10, clampY(by + 5)]; }, speed: 0.6 });
    r[1].phase({ t0: 0, type: 'seek', fn: () => [this.ballXY()[0], FIELD_Y + 1.6], speed: 0.85 });
    r[2].phase({ t0: 0, type: 'seek', fn: () => [this.ballXY()[0], -FIELD_Y - 1.6], speed: 0.85 });
    r[3].phase({ t0: 0, type: 'seek', fn: () => { const [bx, by] = this.ballXY(); return [bx + this.dir * 12, clampY(by * 0.5)]; }, speed: 0.7 });
  }

  // Who a named player is, as a body.
  bodyFor(who, fallbackSlot) {
    if (!who) return null;
    const slot = who.name ? this.slots.get(`${who.team}|${who.name}`) : undefined;
    return this.actor(who.team, slot ?? fallbackSlot);
  }

  // live ball position during simulation
  ballXY() { return [this.live.bx ?? this.los, this.live.by ?? this.by]; }

  // A path that ends exactly at (x, y) at t1, starting from wherever the body
  // is at t0.
  path(body, t0, t1, pts, ease = 'run') {
    if (!body) return;
    t0 = Math.max(0, t0);
    t1 = Math.max(t1, t0 + 0.05);
    body.phase({ t0, t1, type: 'path', pts, ease });
  }
  seek(body, t0, fn, speed = 1) {
    if (!body) return;
    body.phase({ t0, type: 'seek', fn, speed });
    if (t0 === 0) body.defaultSeek = { fn, speed };
  }
  // Be at (x, y) at exactly t1, but play your position until you have to
  // break for it: a tackler pursues like everyone else, then closes.
  arrive(body, t0, t1, x, y) {
    if (!body) return;
    // never cut off a scripted move already planned for this body
    for (const p of body.phases) if (p.type !== 'seek' && p.t0 < t1) t0 = Math.max(t0, Math.min(p.t1 ?? p.t0, t1 - 0.1));
    body.phase({ t0, t1: Math.max(t1, t0 + 0.1), type: 'arrive', x, y });
  }
  hold(body, t0) { if (body) body.phase({ t0, type: 'hold' }); }
}

// --------------------------------------------------------------- casting --

function castPlay(P) {
  const a = P.a;
  const wants = [];
  const unitOf = team => P.units[team];
  const add = (who, pref, keep) => { if (who?.name) wants.push({ name: who.name, team: who.team, unit: unitOf(who.team), pref, keep }); };
  const sidePref = side => side === 'left' ? [S.WR1, S.WR3, S.TE, S.RB, S.WR2]
    : side === 'right' ? [S.WR2, S.TE, S.RB, S.WR3, S.WR1] : [S.WR3, S.TE, S.RB, S.WR1, S.WR2];
  const tacklePref = (x) => {
    const depth = (x - a.los) * P.dir;
    return depth < 2 ? PREF.line : depth < 9 ? PREF.box : PREF.deep;
  };
  for (const l of a.legs) {
    const u = l.who ? unitOf(l.who.team) : null;
    if (l.k === 'kick') add(l.who, PREF.kicker);
    if (l.k === 'pass') {
      add(l.who, PREF.passer);
      if (l.target) add(l.target, sidePref(l.side), 2);
      if (l.by) add(l.by, PREF.cover);
      for (const n of l.defenders || []) add({ name: n, team: P.ctx.other(l.who.team) }, PREF.cover);
      for (const n of l.pressure || []) add({ name: n, team: P.ctx.other(l.who.team) }, PREF.line);
    }
    if (l.k === 'sack' || l.k === 'kneel' || l.k === 'spike') add(l.who, PREF.passer);
    // a back who also catches passes lines up at back when he gets the ball
    if (l.k === 'hand') add(l.to, unitOf(l.to?.team) === 'off' ? PREF.rusher : PREF.any, 1);
    if (l.k === 'catch') add(l.who, unitOf(l.who.team) === 'ret' ? PREF.returner : PREF.any);
    if (l.k === 'run') {
      const unit = unitOf(l.who.team);
      add(l.who, l.scramble ? PREF.passer : unit === 'off' ? PREF.rusher : unit === 'ret' ? PREF.returner : PREF.any, unit === 'off' && l.lane != null ? 1 : undefined);
    }
    if (l.k === 'recover') add(l.who, PREF.any);
    if (l.k === 'snap' && l.who) add(l.who, [S.QB, S.RB, S.TE]);
    for (const n of l.tacklers || []) {
      const team = P.ctx.other(l.who.team);
      add({ name: n, team }, unitOf(team) === 'kick' ? [0, 1, 3, 4, 7, 8, 9, 10, 6, 2] : unitOf(team) === 'off' ? PREF.target : tacklePref(l.toX ?? a.los));
    }
  }
  for (const p of a.penalties || []) {
    if (!p.player || !unitOf(p.team)) continue;
    add({ name: p.player, team: p.team }, unitOf(p.team) === 'off' ? [S.RT, S.LT, S.RG, S.LG, S.C, S.TE] : PREF.line);
  }
  P.slots = P.cast.assign(wants);
}

// --------------------------------------------------------- default roles --

// Everyone not on a script steers by what their position does on this kind
// of play. These run every frame against the live state.
function defaultRoles(P) {
  const L = P.live;
  const offB = P.bodies.filter(b => b.team === P.off);
  const defB = P.bodies.filter(b => b.team === P.def);
  const qb = P.actor(P.off, S.QB);
  const towardBall = (b, r = 2.2) => {
    // pursue the ball carrier but hold a ring around him until the whistle:
    // the named tacklers are the ones who arrive
    const c = L.carrier >= 0 ? P.bodies[L.carrier] : null;
    const [bx, by] = c ? [c.x + c.vx * 0.35, c.y + c.vy * 0.35] : P.ballXY();
    if (L.flight) return L.flight;
    const dx = b.x - bx, dy = b.y - by;
    const d = Math.hypot(dx, dy) || 1;
    const ring = L.whistled ? 1.6 + (b.slot % 3) * 0.7 : r;
    return d < ring ? [b.x, b.y] : [bx + (dx / d) * ring, by + (dy / d) * ring];
  };
  const matchDL = { 0: S.DE1, 1: S.DT1, 2: S.DT1, 3: S.DT2, 4: S.DE2 };

  for (const b of offB) {
    const role = OFF[b.slot];
    if (b.kind === 'OL') {
      const m = P.actor(P.def, matchDL[b.slot]);
      P.seek(b, 0, () => {
        if (L.t < L.snap) return b.home;
        if (L.whistled) return [b.x, b.y];
        const [hx, hy] = b.home;
        if (L.passPlay && !L.thrown) {
          // set back, stay between the man and the quarterback
          const tx = clamp((m.x + qb.x) / 2, Math.min(hx, hx - P.dir * 2.2), Math.max(hx, hx - P.dir * 2.2));
          return [tx, lerp(hy, m.y, 0.5)];
        }
        return [m.x + P.dir * 0.5, lerp(m.y, hy, 0.3)];
      }, L.passPlay ? 0.55 : 0.8);
    } else if (role === 'QB') {
      P.seek(b, 0, () => b.home, 0.4);
    } else if (role === 'RB' || role === 'TE') {
      P.seek(b, 0, () => {
        if (L.t < L.snap) return b.home;
        if (L.passPlay && !L.thrown) return [qb.x + P.dir * 1.2, qb.y + (role === 'RB' ? -1.5 : -3) * P.dir];
        return towardBall(b, 3.5);
      }, 0.7);
    } else {
      // receivers: a generic route on passes, block downfield on runs
      const breakIn = P.rand() < 0.5;
      const depth = 6 + P.rand() * 12;
      P.seek(b, 0, () => {
        if (L.t < L.snap) return b.home;
        if (L.passPlay && !L.thrown) {
          const [hx, hy] = b.home;
          const stem = [hx + P.dir * depth, hy];
          const gone = (b.x - hx) * P.dir;
          if (gone < depth - 0.5) return [stem[0] + P.dir * 2, hy];
          return [b.x + P.dir * 2, hy + (breakIn ? -1 : 1) * Math.sign(hy - P.by || 1) * 8];
        }
        if (L.passPlay && L.thrown && L.flight) return [lerp(b.x, L.flight[0], 0.5), lerp(b.y, L.flight[1], 0.5)];
        // block the nearest defender to the ball carrier
        let best = null, bd = 1e9;
        for (const d of defB) { const dd = dist(d.x, d.y, b.x, b.y); if (dd < bd) { bd = dd; best = d; } }
        return best ? [best.x - P.dir * 0.8, best.y] : b.home;
      }, 0.85);
    }
  }

  for (const b of defB) {
    const role = DEF[b.slot];
    const mark = role === 'CB1' ? P.actor(P.off, S.WR1) : role === 'CB2' ? P.actor(P.off, S.WR2) : null;
    P.seek(b, 0, () => {
      if (L.t < L.snap) return b.home;
      if (L.whistled) return towardBall(b);
      if (b.kind === 'DL') {
        if (L.passPlay && !L.thrown) return [qb.x, qb.y];
        return towardBall(b, 1.4);
      }
      if (L.passPlay && !L.thrown && !L.scramble) {
        if (mark) return [mark.x + P.dir * 1.8, mark.y + (mark.y > 0 ? -0.6 : 0.6)];
        const [hx, hy] = b.home;
        return b.kind === 'LB' ? [hx + P.dir * 5, hy] : [hx + P.dir * 6, hy * 0.8];
      }
      if (L.t < L.snap + 0.35) return b.home; // read
      return towardBall(b);
    }, b.kind === 'DL' ? 0.9 : 1);
  }
}

// ------------------------------------------------------------------ legs --

// Lays out the legs after the snap. `st` is { t, holder (Body), x, y }.
function runLegs(P, legs, st) {
  const a = P.a;
  const L = P.live;
  for (let k = 0; k < legs.length; k++) {
    const l = legs[k];
    const next = legs[k + 1];
    switch (l.k) {
      case 'snap': break;
      case 'hand': {
        const to = P.bodyFor(l.to, S.RB);
        if (!to || to === st.holder) break;
        const qb = st.holder;
        const lane = (legs.find(x => x.k === 'run')?.lane ?? 0);
        // mesh point: a step or two behind the line, toward the run's side
        const [mx, my] = l.lateral ? [qb.x - P.dir * 1.5, qb.y + lane * 3] : P.at(a.shotgun ? -4.5 : -3.4, lane * 1.5);
        const tMesh = st.t + (a.shotgun ? 0.55 : 0.75);
        P.path(qb, st.t, tMesh, [[mx + P.dir * 0.3, my + 0.6 * P.dir]], 'smooth');
        // a man lined up wide comes across in motion before the snap
        const far = dist(to.home[0], to.home[1], mx, my);
        P.path(to, Math.min(P.a.shotgun ? st.t : st.t - 0.15, tMesh - far / 7), tMesh, [[mx, my]], 'smooth');
        // the quarterback carries out his fake
        P.path(qb, tMesh, tMesh + 1.4, [[mx - P.dir * 2.5, my - lane * 4 - 1.5 * P.dir]], 'out');
        P.ball.push({ t0: tMesh, type: 'held', who: to.i });
        P.event(tMesh, 'handoff');
        st.t = tMesh; st.holder = to; st.x = mx; st.y = my;
        L.runPlay = true;
        break;
      }
      case 'run': {
        // an unnamed carrier is whoever has it
        const runner = l.who?.name ? P.bodyFor(l.who, S.RB) : (st.holder || P.bodyFor(l.who, S.RB));
        if (!runner) break;
        if (st.holder && runner !== st.holder) {
          // a handoff the words did not mention
          P.path(runner, Math.max(0, st.t - 0.5), st.t + 0.1, [[st.x - P.ctx.dir(runner.team) * 0.6, st.y + 0.5]], 'smooth');
          st.t += 0.1;
        }
        if (st.holder !== runner) { P.ball.push({ t0: st.t, type: 'held', who: runner.i }); st.holder = runner; }
        layRun(P, l, st, runner, next);
        break;
      }
      case 'pass': layPass(P, l, st, legs[k + 1]); break;
      case 'sack': laySack(P, l, st, next); break;
      case 'kneel': {
        const qb = st.holder || P.actor(P.off, S.QB);
        qb.pose(st.t + 0.2, 99, POSE.KNEEL);
        P.path(qb, st.t, st.t + 0.3, [[qb.home[0] - P.dir * 0.8, qb.home[1]]], 'smooth');
        st.t += 1.1;
        whistle(P, st.t);
        P.event(st.t - 0.6, 'kneel');
        break;
      }
      case 'spike': {
        const qb = st.holder || P.actor(P.off, S.QB);
        const tThrow = st.t + 0.35;
        qb.pose(tThrow - 0.1, tThrow + 0.3, POSE.THROW);
        const [gx, gy] = [qb.home[0] + P.dir * 1.2, qb.home[1]];
        P.ball.push({ t0: tThrow, t1: tThrow + 0.2, type: 'flight', to: [gx, gy, 0.1], apex: 0 });
        P.ball.push({ t0: tThrow + 0.2, t1: tThrow + 1.0, type: 'bounce', to: [gx + P.dir * 2, gy + 0.6], hops: 2, height: 0.9 });
        P.event(tThrow, 'spike');
        st.t = tThrow + 0.5;
        whistle(P, st.t);
        break;
      }
      case 'fumble': {
        const carrier = st.holder;
        const t = st.t;
        const to = next?.k === 'recover' ? next.atX : l.atX;
        const via = l.touchedX;
        const ty = clampY((carrier?.y ?? P.by) + (P.rand() - 0.5) * 6);
        const pts = via != null ? [[via, (st.y + ty) / 2], [to, ty]] : [[to, ty]];
        let t0 = t;
        for (const [px, py] of pts) {
          const d = Math.max(1.2, dist(st.x, st.y, px, py));
          const t1 = t0 + 0.35 + d * 0.11;
          P.ball.push({ t0, t1, type: 'bounce', to: [px, py], hops: Math.min(4, 1 + Math.floor(d / 3)), height: 0.9 });
          st.x = px; st.y = py; t0 = t1;
        }
        if (carrier && !l.muff) { carrier.pose(t, t + 1.6, POSE.DOWN); }
        if (l.forcedBy) {
          const f = P.bodyFor({ name: l.forcedBy, team: P.ctx.other(carrier?.team ?? P.off) }, S.LB2);
          if (f && carrier && !f.scripted) { f.pose(t, t + 1.4, POSE.DOWN); }
        }
        P.event(t, 'fumble');
        st.t = t0; st.holder = null; L.loose = true;
        if (!next || next.k !== 'recover') {
          P.ball.push({ t0, type: 'rest', x: st.x, y: st.y, z: 0.15 });
          whistle(P, t0 + 0.3);
        }
        break;
      }
      case 'recover': {
        const who = P.bodyFor(l.who, S.LB2);
        if (!who) break;
        const tArr = st.t;
        // dive onto the ball as it stops
        P.arrive(who, Math.max(0, (P.snapT ?? 0) + 0.2), tArr, st.x, st.y);
        who.pose(tArr - 0.25, tArr + 0.9, POSE.DIVE);
        P.ball.push({ t0: tArr, type: 'held', who: who.i });
        P.event(tArr, 'recover', { team: who.team });
        P.label(who, tArr - 1, tArr + 4, l.who.name);
        st.holder = who; st.t = tArr + (next?.k === 'run' || next?.k === 'pass' ? 0.6 : 0.3);
        if (!next || (next.k !== 'run' && next.k !== 'pass' && next.k !== 'hand')) whistle(P, tArr + 0.4);
        L.loose = false;
        break;
      }
      case 'catch': {
        // kick caught by a returner (or muffed)
        const who = P.bodyFor(l.who, 5);
        if (!who) break;
        st.holder = l.muff ? null : who;
        if (!l.muff) P.ball.push({ t0: st.t, type: 'held', who: who.i });
        P.label(who, st.t - 2, st.t + 6, l.who.name);
        who.pose(st.t - 0.4, st.t + 0.15, POSE.CATCH);
        if (l.fair) {
          P.event(st.t, 'fair');
          whistle(P, st.t + 0.2);
        }
        break;
      }
      case 'dead': {
        if (l.how === 'touchback' && st.holder) st.holder.pose(st.t + 0.2, 99, POSE.KNEEL);
        if (!st.holder) P.ball.push({ t0: st.t, type: 'rest', x: st.x, y: st.y, z: 0.15 });
        whistle(P, st.t + 0.3);
        P.event(st.t, l.how);
        break;
      }
      case 'kick': break; // laid out by the kick builders
    }
  }
}

// A carry from where the runner is to the leg's end spot.
function layRun(P, l, st, runner, next) {
  const L = P.live;
  const a = P.a;
  const d = P.ctx.dir(runner.team);
  const fromX = st.x, fromY = st.y;
  let toX = l.toX;
  // where across the field: the lane for runs from the backfield, drift otherwise
  let toY;
  const yards = (toX - fromX) * d;
  const firstRun = l.lane != null && Math.abs(fromX - a.los) < 9 && runner.team === a.offense;
  const pts = [];
  if (firstRun) {
    const laneY = P.by + P.dir * (l.lane * (Math.abs(l.lane) > 0.9 ? 9 : 6.5));
    const holeX = a.los + P.dir * 0.8;
    const holeY = clampY(laneY);
    if (yards > 1) pts.push([holeX, holeY]);
    else pts.push([a.los - P.dir * 0.2 + (toX - a.los) * 0.4, lerp(fromY, holeY, 0.8)]);
    toY = clampY(holeY + (P.rand() - 0.5) * Math.min(14, Math.abs(yards) * 0.5) + (Math.abs(l.lane) > 0.5 ? Math.sign(l.lane) * P.dir * Math.min(8, Math.abs(yards) * 0.2) : 0));
  } else {
    toY = clampY(fromY + (P.rand() - 0.5) * Math.min(16, Math.abs(yards) * 0.6));
  }
  if (l.oob) toY = Math.sign(toY - (P.rand() - 0.5) * 0.01 || 1) * (FIELD_Y + 0.4);
  if (l.td) toY = clampY(toY * 0.8);
  // a long run gets a cut in the middle
  if (Math.abs(yards) > 12 && !l.oob) {
    const mx = lerp(fromX, toX, 0.45);
    pts.push([mx, clampY(lerp(fromY, toY, 0.45) + (P.rand() - 0.5) * 8)]);
  }
  pts.push([toX, toY]);
  // time: runners top out near 8.5 yd/s, short gains are a grind into bodies
  let len = 0, px = fromX, py = fromY;
  for (const [x, y] of pts) { len += dist(px, py, x, y); px = x; py = y; }
  const pace = Math.abs(yards) > 15 ? 7.8 : Math.abs(yards) > 6 ? 6.6 : 5.2;
  const dur = Math.max(0.7, len / pace + (Math.abs(yards) < 3 ? 0.5 : 0.15));
  const t0 = st.t, t1 = st.t + dur;
  P.path(runner, t0, t1, pts, 'run');
  L.runPlay = L.runPlay || runner.team === a.offense;
  if (l.who?.name) P.label(runner, t0 - 0.8, t1 + 2.5, l.who.name);
  P.event(t0, 'run', { actor: runner.i });

  const tackled = !l.td && !l.oob && next?.k !== 'fumble' && next?.k !== 'hand';
  let tacklers = (l.tacklers || []).map(n => P.bodyFor({ name: n, team: P.ctx.other(runner.team) }, null)).filter(Boolean);
  if (tackled && !tacklers.length && !(next && next.k === 'dead')) {
    // nobody named: the nearest plausible defender makes it
    const depth = (toX - a.los) * P.dir;
    const team = P.ctx.other(runner.team);
    const slot = P.units[team] === 'kick' ? [0, 4, 7, 8][Math.floor(P.rand() * 4)]
      : depth < 2 ? [S.DT1, S.DE1, S.DE2][Math.floor(P.rand() * 3)] : depth < 9 ? [S.LB1, S.LB2, S.LB3][Math.floor(P.rand() * 3)] : [S.S1, S.S2, S.CB1][Math.floor(P.rand() * 3)];
    tacklers = [P.actor(team, slot)];
  }
  // tacklers converge on the end spot from their side
  tacklers.forEach((tk, n) => {
    if (tk === runner) return;
    const ang = Math.atan2(tk.home[1] - toY, tk.home[0] - toX) + (n - (tacklers.length - 1) / 2) * 0.9;
    const ex = toX + Math.cos(ang) * 0.7, ey = clampY(toY + Math.sin(ang) * 0.7);
    P.arrive(tk, Math.min(P.snapT + 0.25, t1 - 0.3), t1, ex, ey);
    tk.scripted = true;
    if (!l.oob) tk.pose(t1 - 0.12, t1 + 1.3, POSE.DIVE);
    P.label(tk, t1 - 0.9, t1 + 2.5, (l.tacklers || [])[n]);
  });
  if (tackled) {
    runner.pose(t1, t1 + 1.4, POSE.DOWN);
    P.event(t1, 'tackle', { yards, x: toX });
    whistle(P, t1);
  } else if (l.oob) {
    P.path(runner, t1, t1 + 0.7, [[toX + d * 1.5, Math.sign(toY) * (FIELD_Y + 2.5)]], 'out');
    P.event(t1, 'oob');
    whistle(P, t1);
  } else if (l.td) {
    P.path(runner, t1, t1 + 0.9, [[toX + d * 2.5, toY]], 'out');
    runner.pose(t1 + 0.7, 99, POSE.CELEBRATE);
    P.event(t1, 'td', { team: runner.team });
    whistle(P, t1 + 0.2);
    // teammates come to celebrate
    for (const b of P.bodies) {
      if (b.team !== runner.team || b === runner || P.rand() > 0.5) continue;
      const cx = toX + d * 1.5 + (P.rand() - 0.5) * 4, cy = clampY(toY + (P.rand() - 0.5) * 6);
      const far = dist(b.home[0], b.home[1], cx, cy);
      if (far < 40) P.arrive(b, t1 + 0.3, t1 + 0.6 + far / 6, cx, cy);
    }
  }
  st.t = t1; st.x = toX; st.y = toY;
  if (next?.k === 'fumble') runner.pose(t1, t1 + 1.3, POSE.DOWN);
}

function layPass(P, l, st, next) {
  const L = P.live;
  const a = P.a;
  L.passPlay = true;
  const qb = st.holder || P.bodyFor(l.who, S.QB);
  const deep = l.depth === 'deep';
  // drop
  const drop = a.shotgun ? 1.6 : deep ? 7 : 5;
  const [dx, dy] = [qb.home[0] - P.dir * drop, qb.home[1]];
  const tSet = st.t + (a.shotgun ? 0.7 : 1.2);
  P.path(qb, st.t, tSet, [[dx, dy]], 'smooth');
  const tThrow = tSet + (deep ? 1.1 : 0.55) + P.rand() * 0.5;
  P.path(qb, tSet, tThrow, [[dx + P.dir * 0.8, dy + (P.rand() - 0.5) * 1.5]], 'smooth');
  qb.pose(tThrow - 0.25, tThrow + 0.35, POSE.THROW);
  if (l.who?.name) P.label(qb, st.t - 0.6, tThrow + 1.5, l.who.name);
  P.event(tThrow, 'throw');

  // where it is going
  const target = l.target ? P.bodyFor(l.target, S.WR1) : null;
  const sideV = l.side === 'left' ? 1 : l.side === 'right' ? -1 : 0;
  let catchX, catchY;
  const gainX = next?.k === 'run' && next.afterCatch ? next.toX : null;
  if (l.result === 'intercepted') {
    catchX = l.atX;
  } else if (gainX != null) {
    const gain = (gainX - a.los) * P.dir;
    const air = deep ? clamp(gain * 0.85, 15, 60) : clamp(Math.round(gain * 0.55), -3, 11);
    catchX = a.los + P.dir * Math.min(air, gain);
    if (next.td && (catchX - (P.dir > 0 ? 100 : 0)) * P.dir > 0) catchX = P.dir > 0 ? Math.min(catchX, 108) : Math.max(catchX, -8);
  } else {
    catchX = a.los + P.dir * (deep ? 22 + P.rand() * 18 : 4 + P.rand() * 7);
  }
  // keep the catch inside the field of play
  catchX = clamp(catchX, -9, 109);
  catchY = clampY(P.by + P.dir * sideV * (sideV ? 9 + P.rand() * 9 : (P.rand() - 0.5) * 6));
  // a receiver can only get so far before the ball arrives: pull the catch
  // toward his side of the field until the route is runnable
  if (target && l.result !== 'intercepted') {
    const tGuess = tThrow + 0.3 + dist(dx, dy, catchX, catchY) / (deep ? 21 : 18);
    for (let k = 0; k < 12; k++) {
      const need = dist(target.home[0], target.home[1], catchX, catchY) / Math.max(0.5, tGuess - P.snapT);
      if (need < 8.6) break;
      catchY = lerp(catchY, target.home[1], 0.25);
    }
  }
  const throwFrom = [dx + P.dir * 0.8, dy];
  const airDist = dist(throwFrom[0], throwFrom[1], catchX, catchY);
  const tCatch = tThrow + 0.3 + airDist / (deep ? 21 : 18);
  const apex = deep ? 4 + airDist * 0.12 : 0.6 + airDist * 0.06;
  const catchZ = l.result === 'incomplete' ? 0.9 : 1.25;

  // the target runs to the catch point
  if (target) {
    const [hx, hy] = target.home;
    const air = (catchX - hx) * P.dir;
    const stemX = air > 4 ? hx + P.dir * (air - Math.min(5, air * 0.35)) : hx + P.dir * Math.max(0.5, air * 0.5);
    const pts = [[stemX, lerp(hy, catchY, 0.25)], [catchX, catchY]];
    P.path(target, P.snapT + 0.05, tCatch, pts, 'run');
    target.scripted = true;
    if (l.target.name) P.label(target, P.snapT, tCatch + 3.5, l.target.name);
  }
  L.passTarget = [catchX, catchY];
  P.ball.push({ t0: tThrow, t1: tCatch, type: 'flight', to: [catchX, catchY, catchZ], apex, spiral: true });
  P.flightWindows.push([tThrow, tCatch, catchX, catchY]);

  // pressure: a rusher the words name gets to the quarterback as he throws
  for (const n of l.pressure || []) {
    const r = P.bodyFor({ name: n, team: P.ctx.other(qb.team) }, S.DE1);
    if (!r) continue;
    P.arrive(r, P.snapT + 0.2, tThrow + 0.12, throwFrom[0] + P.dir * 0.7, throwFrom[1] + 0.5);
    r.pose(tThrow + 0.05, tThrow + 1.2, POSE.DIVE);
    r.scripted = true;
    qb.pose(tThrow + 0.3, tThrow + 1.4, POSE.DOWN);
    P.label(r, tThrow - 0.5, tThrow + 2, n);
  }

  if (l.result === 'complete') {
    target?.pose(tCatch - 0.25, tCatch + 0.1, POSE.CATCH);
    P.ball.push({ t0: tCatch, type: 'held', who: (target || qb).i });
    P.event(tCatch, 'catch', { yards: ((gainX ?? catchX) - a.los) * P.dir });
    st.t = tCatch; st.holder = target; st.x = catchX; st.y = catchY;
    L.thrownAt = tThrow;
    return;
  }
  if (l.result === 'intercepted') {
    const by = P.bodyFor(l.by, S.CB1);
    if (by) {
      P.arrive(by, P.snapT + 0.3, tCatch, catchX - P.dir * 0.4, catchY + 0.3);
      by.scripted = true;
      by.pose(tCatch - 0.25, tCatch + 0.15, POSE.CATCH);
      P.label(by, tThrow, tCatch + 5, l.by.name);
    }
    if (target) target.pose(tCatch - 0.2, tCatch + 0.4, POSE.DIVE);
    P.ball.push({ t0: tCatch, type: 'held', who: (by || qb).i });
    P.event(tCatch, 'interception', { team: by?.team });
    st.t = tCatch; st.holder = by; st.x = catchX; st.y = catchY;
    L.turnover = true;
    return;
  }
  // incomplete: the ball gets there and hits the turf
  if (target) target.pose(tCatch - 0.2, tCatch + 0.5, POSE.DIVE);
  (l.defenders || []).forEach(n => {
    const d = P.bodyFor({ name: n, team: P.ctx.other(qb.team) }, S.CB1);
    if (!d) return;
    P.arrive(d, P.snapT + 0.3, tCatch + 0.05, catchX + P.dir * 0.6, catchY - 0.4);
    d.scripted = true;
    d.pose(tCatch - 0.15, tCatch + 0.6, POSE.DIVE);
    P.label(d, tCatch - 1, tCatch + 2, n);
  });
  const land = [catchX + P.dir * (1 + P.rand() * 3), clampY(catchY + (P.rand() - 0.5) * 3)];
  P.ball.push({ t0: tCatch, t1: tCatch + 0.9, type: 'bounce', to: land, hops: 2, height: 0.8 });
  P.ball.push({ t0: tCatch + 0.9, type: 'rest', x: land[0], y: land[1], z: 0.15 });
  P.event(tCatch, 'incomplete');
  whistle(P, tCatch + 0.4);
  st.t = tCatch; st.holder = null;
}

function laySack(P, l, st, next) {
  const L = P.live;
  const a = P.a;
  L.passPlay = true;
  const qb = st.holder || P.bodyFor(l.who, S.QB);
  const drop = a.shotgun ? 1.6 : 6;
  const tSet = st.t + (a.shotgun ? 0.7 : 1.2);
  const [dx, dy] = [qb.home[0] - P.dir * drop, qb.home[1]];
  P.path(qb, st.t, tSet, [[dx, dy]], 'smooth');
  const tSack = tSet + 1.3 + P.rand() * 1.1;
  const sy = clampY(dy + (P.rand() - 0.5) * 5);
  P.path(qb, tSet, tSack, [[lerp(dx, l.toX, 0.5), lerp(dy, sy, 0.5) + 0.8], [l.toX, sy]], 'smooth');
  qb.pose(tSack, tSack + 1.6, POSE.DOWN);
  if (l.who?.name) P.label(qb, st.t, tSack + 2, l.who.name);
  const names = l.tacklers?.length ? l.tacklers : [null];
  names.forEach((n, k) => {
    const r = n ? P.bodyFor({ name: n, team: P.ctx.other(qb.team) }, S.DE1) : P.actor(P.ctx.other(qb.team), k ? S.DE2 : S.DE1);
    if (!r) return;
    P.arrive(r, P.snapT + 0.15, tSack, l.toX + P.dir * 0.6 * (k ? -1 : 1), sy + 0.6 + k * 0.5);
    r.scripted = true;
    r.pose(tSack - 0.12, tSack + 1.4, POSE.DIVE);
    if (n) P.label(r, tSack - 1.2, tSack + 2.5, n);
  });
  P.event(tSack, 'sack', { yards: (l.toX - a.los) * P.dir });
  if (next?.k !== 'fumble') whistle(P, tSack);
  st.t = tSack; st.x = l.toX; st.y = sy; st.holder = qb;
}

function whistle(P, t) {
  if (t < P.whistle) P.whistle = t;
}

// --------------------------------------------------------------- builders --

function snap(P, st, tSnap, to) {
  const c = P.actor(P.off, S.C);
  const rec = to || P.actor(P.off, S.QB);
  P.snapT = tSnap;
  P.live.snap = tSnap;
  // hold the ball on the ground at the line until the snap
  P.ball.push({ t0: 0, type: 'rest', x: P.los - P.dir * 0.1, y: P.by, z: 0.15 });
  const recAt = [rec.home[0], rec.home[1]];
  const dt = dist(c.home[0], c.home[1], recAt[0], recAt[1]) / 16 + 0.05;
  P.ball.push({ t0: tSnap, t1: tSnap + dt, type: 'flight', from: [P.los, P.by, 0.3], to: [recAt[0], recAt[1], 1.0], apex: 0.2 });
  P.ball.push({ t0: tSnap + dt, type: 'held', who: rec.i });
  for (const b of P.bodies) {
    if (b.team === P.off && b.kind !== 'WR' && b.kind !== 'QB') b.pose(0.2, tSnap, POSE.STANCE);
    if (b.team === P.def && b.kind === 'DL') b.pose(0.2, tSnap, POSE.STANCE);
  }
  P.event(tSnap, 'snap');
  st.t = tSnap + dt; st.holder = rec; st.x = recAt[0]; st.y = recAt[1];
}

function buildScrimmage(P) {
  const a = P.a;
  P.setupBodies('off', 'def');
  P.placeForm(P.off, offenseForm(a.shotgun || a.kind === 'scramble' && P.rand() < 0.7), false);
  P.placeForm(P.def, DEFENSE_FORM, true);
  P.placeOfficials();
  castPlay(P);
  defaultRoles(P);
  P.live.passPlay = a.kind === 'pass' || a.kind === 'sack' || a.kind === 'scramble';
  const st = { t: 0, holder: null, x: P.los, y: P.by };
  const direct = a.legs.find(l => l.k === 'snap' && l.who);
  snap(P, st, 1.1, direct ? P.bodyFor(direct.who, S.RB) : null);
  if (a.kind === 'scramble') {
    // drop, look, then go
    const qb = st.holder;
    const tSet = st.t + 1.0;
    P.path(qb, st.t, tSet, [[qb.home[0] - P.dir * 2, qb.home[1]]], 'smooth');
    st.t = tSet + 0.6 + P.rand() * 0.8; st.x = qb.home[0] - P.dir * 2; st.y = qb.home[1];
    P.path(qb, tSet, st.t, [[st.x + P.dir * 0.3, st.y + (P.rand() - 0.5) * 3]], 'smooth');
    P.live.scramble = true;
  }
  runLegs(P, a.legs, st);
  P.end = Math.max(P.whistle === Infinity ? st.t + 0.5 : P.whistle, st.t) + 2.2;
}

function buildPreSnapFoul(P) {
  const a = P.a;
  P.setupBodies('off', 'def');
  P.placeForm(P.off, offenseForm(a.shotgun), false);
  P.placeForm(P.def, DEFENSE_FORM, true);
  P.placeOfficials();
  castPlay(P);
  defaultRoles(P);
  P.live.snap = 99;
  P.snapT = 99;
  P.ball.push({ t0: 0, type: 'rest', x: P.los - P.dir * 0.1, y: P.by, z: 0.15 });
  for (const b of P.bodies) if (b.team !== 'ref' && (b.kind === 'OL' || b.kind === 'DL')) b.pose(0.2, 1.6, POSE.STANCE);
  // the flagged player flinches
  const pen = a.penalties.find(p => !p.declined) || a.penalties[0];
  if (pen) {
    const team = pen.team;
    const slot = pen.player ? undefined : (team === P.off ? S.RT : S.DE1);
    const who = pen.player ? P.bodyFor({ name: pen.player, team }, team === P.off ? S.RT : S.DE1) : P.actor(team, slot);
    const fwd = P.ctx.dir(team);
    if (who) {
      P.path(who, 1.4, 1.8, [[who.home[0] + fwd * 1.3, who.home[1]]], 'smooth');
      P.path(who, 2.6, 3.6, [[who.home[0], who.home[1]]], 'smooth');
    }
  }
  whistle(P, 1.9);
  P.end = 4.2;
}

function buildKickoff(P) {
  const a = P.a;
  const kick = a.legs.find(l => l.k === 'kick');
  P.los = kick.fromX;
  P.by = 0;
  P.setupBodies('kick', 'ret');
  // kicking team: the kicker behind the ball, ten across the receiving 40
  const d = P.dir;
  const cover = [-22, -17.5, -12.5, -7.5, -2.5, 2.5, 7.5, 12.5, 17.5, 22];
  let c = 0;
  for (let slot = 0; slot < 11; slot++) {
    const b = P.actor(P.off, slot);
    if (slot === 5) [b.x, b.y] = P.at(-7, -2);
    else [b.x, b.y] = P.at(25, cover[c++]);
    b.home = [b.x, b.y]; b.face = d > 0 ? 0 : Math.PI; b.h = b.face;
  }
  const landX = kick.toX;
  const landS = (landX - P.los) * d;
  const blockers = [-20, -14, -8.5, -3, 3, 8.5, 14, 20, -11, 11];
  c = 0;
  for (let slot = 0; slot < 11; slot++) {
    const b = P.actor(P.def, slot);
    if (slot === 5) [b.x, b.y] = P.at(Math.min(landS, 75) - 2, 0);
    else if (slot === 6) [b.x, b.y] = P.at(Math.min(landS, 75) - 6, 8);
    else if (c < 8) [b.x, b.y] = P.at(31.5, blockers[c++]);
    else [b.x, b.y] = P.at(42, blockers[c++]);
    b.home = [b.x, b.y]; b.face = d > 0 ? Math.PI : 0; b.h = b.face;
  }
  P.placeOfficials();
  castPlay(P);
  const kicker = P.actor(P.off, 5);
  const tKick = 1.6;
  P.snapT = tKick; P.live.snap = tKick;
  P.path(kicker, 0.3, tKick, [[P.los - d * 0.4, 0.2]], 'in');
  kicker.pose(tKick - 0.15, tKick + 0.3, POSE.KICK);
  if (kick.who?.name) P.label(kicker, 0, tKick + 2, kick.who.name);
  P.ball.push({ t0: 0, type: 'rest', x: P.los, y: 0, z: 0.35 });
  const yards = Math.abs(landX - P.los);
  const hang = kick.kind === 'onside' ? 1.2 : 2.6 + yards * 0.022;
  const landY = clampY((P.rand() - 0.5) * 10);
  const caught = a.legs.some(l => l.k === 'catch' && !l.muff) || a.legs.some(l => l.k === 'run');
  const ret = returner(P);
  P.ball.push({ t0: tKick, t1: tKick + hang, type: 'flight', to: [landX, landY, caught ? 1.3 : 0.15], apex: kick.kind === 'onside' ? 1.2 : 14 + yards * 0.1, kick: true });
  P.event(tKick, 'kick');
  const tLand = tKick + hang;
  P.path(ret, tKick, tLand - 0.2, [[landX, landY]], 'smooth');
  // coverage holds until the ball is caught or lands, then goes
  for (let slot = 0; slot < 11; slot++) {
    if (slot === 5) continue;
    const b = P.actor(P.off, slot);
    P.seek(b, 0, () => (P.live.t < tLand ? b.home : pursue(P, b, 2.2)), 1);
    const r = P.actor(P.def, slot);
    if (slot === 6) { P.seek(r, 0, () => (P.live.t < tLand ? r.home : [P.ballXY()[0] - d * 4, P.ballXY()[1] + 2]), 0.8); continue; }
    P.seek(r, 0, () => {
      if (P.live.t < tLand) return r.home;
      // block the nearest coverage man
      let best = null, bd = 1e9;
      for (const k of P.bodies) if (k.team === P.off) { const dd = dist(k.x, k.y, r.x, r.y); if (dd < bd) { bd = dd; best = k; } }
      return best ? [best.x + d * 0.7, best.y] : r.home;
    }, 0.9);
  }
  P.seek(kicker, tKick + 0.4, () => pursue(P, kicker, 6), 0.6);
  const st = { t: tLand, holder: null, x: landX, y: landY };
  if (!caught) P.ball.push({ t0: tLand, type: 'rest', x: landX, y: landY, z: 0.15 });
  // no catch leg in the words: the returner fields it
  const legs = a.legs.slice(a.legs.indexOf(kick) + 1);
  if (caught && !legs.some(l => l.k === 'catch')) legs.unshift({ k: 'catch', who: legs.find(l => l.k === 'run')?.who || { name: null, team: P.def }, atX: landX });
  runLegs(P, legs, st);
  if (kick.result === 'touchback' && !legs.length) whistle(P, tLand + 0.4);
  P.end = Math.max(P.whistle === Infinity ? st.t + 1 : P.whistle, st.t) + 2.2;
}

// The body the words say fields the kick (slot 5 when they do not say).
function returner(P) {
  const l = P.a.legs.find(l => (l.k === 'catch' || l.k === 'run') && l.who?.team === P.def);
  return l?.who?.name ? P.bodyFor(l.who, 5) : P.actor(P.def, 5);
}

function pursue(P, b, ring) {
  const L = P.live;
  if (L.flight) return L.flight;
  const c = L.carrier >= 0 ? P.bodies[L.carrier] : null;
  const [bx, by] = c ? [c.x + c.vx * 0.3, c.y + c.vy * 0.3] : P.ballXY();
  const dx = b.x - bx, dy = b.y - by;
  const d = Math.hypot(dx, dy) || 1;
  const r = L.whistled ? ring + 1.5 : ring;
  return d < r ? [b.x, b.y] : [bx + (dx / d) * r, by + (dy / d) * r];
}

function buildPunt(P) {
  const a = P.a;
  const kick = a.legs.find(l => l.k === 'kick');
  P.setupBodies('kick', 'ret');
  P.placeForm(P.off, PUNT_FORM, false);
  P.placeForm(P.def, PUNT_RETURN_FORM, true);
  const d = P.dir;
  const landX = kick.toX;
  const deepMan = P.actor(P.def, 5);
  const landY = clampY(P.by + (P.rand() - 0.5) * 12);
  [deepMan.x, deepMan.y] = [clamp(landX + d * 4, -8, 108), landY];
  deepMan.home = [deepMan.x, deepMan.y]; deepMan.face = d > 0 ? Math.PI : 0; deepMan.h = deepMan.face;
  P.placeOfficials();
  castPlay(P);
  const ret = returner(P);
  const punter = P.actor(P.off, 5);
  const st = { t: 0, holder: null, x: P.los, y: P.by };
  snap(P, st, 1.1, punter);
  const tKick = st.t + 1.2;
  P.path(punter, st.t, tKick, [[punter.home[0] + d * 2.2, punter.home[1]]], 'smooth');
  punter.pose(tKick - 0.15, tKick + 0.35, POSE.KICK);
  if (kick.who?.name) P.label(punter, 0, tKick + 2, kick.who.name);
  P.event(tKick, 'kick');
  const blocked = kick.result === 'blocked';
  const fromX = punter.home[0] + d * 2.2;
  const yards = Math.abs(landX - fromX);
  const hang = blocked ? 0.5 : 3.2 + yards * 0.022;
  const caught = !blocked && (a.legs.some(l => l.k === 'catch' && !l.muff) || kick.result === 'return');
  const tLand = tKick + hang;
  const oob = kick.result === 'oob';
  const restY = oob ? Math.sign(landY || 1) * (FIELD_Y + 1) : landY;
  P.ball.push({ t0: tKick, t1: tLand, type: 'flight', to: [landX, oob ? Math.sign(landY || 1) * FIELD_Y : landY, caught ? 1.3 : 0.15], apex: blocked ? 1.5 : 13 + yards * 0.12, kick: true });
  const fair = kick.result === 'fair';
  P.path(ret, tKick, tLand - 0.3, [[landX, landY]], 'smooth');
  if (fair) ret.pose(tKick + 0.8, tLand - 0.4, POSE.SIGNAL);
  // gunners and coverage release at the kick; the rest block then follow
  for (let slot = 0; slot < 11; slot++) {
    const b = P.actor(P.off, slot);
    if (slot === 5) { P.seek(b, tKick + 0.5, () => pursue(P, b, 8), 0.5); continue; }
    const gunner = slot === 8 || slot === 9;
    P.seek(b, 0, () => {
      if (P.live.t < P.snapT + (gunner ? 0 : 1.1)) return gunner && P.live.t > P.snapT ? [b.x + d * 3, b.y] : b.home;
      if (fair && P.live.t > tLand) return [b.x, b.y];
      return pursue(P, b, gunner ? 2 : 3);
    }, gunner ? 1 : 0.85);
    const r = P.actor(P.def, slot);
    if (slot === 5) continue;
    P.seek(r, 0, () => {
      if (P.live.t < P.snapT) return r.home;
      if (slot <= 3 && P.live.t < tKick + 0.3) return [punter.x, punter.y];
      if (slot === 7 || slot === 8) { const g = P.actor(P.off, slot + 1); return [g.x + d * 1, g.y]; }
      let best = null, bd = 1e9;
      for (const k of P.bodies) if (k.team === P.off) { const dd = dist(k.x, k.y, r.x, r.y); if (dd < bd) { bd = dd; best = k; } }
      return best ? [best.x + d * 0.7, best.y] : r.home;
    }, 0.85);
  }
  st.t = tLand; st.x = landX; st.y = restY;
  if (!caught && !blocked) {
    // it lands and rolls, or goes out, or into the end zone
    const roll = oob ? 0 : (kick.result === 'touchback' ? 6 : 2 + P.rand() * 4);
    const rx = landX + d * roll;
    P.ball.push({ t0: tLand, t1: tLand + 1.2, type: 'bounce', to: [rx, restY], hops: 3, height: 1.4 });
    P.ball.push({ t0: tLand + 1.2, type: 'rest', x: rx, y: restY, z: 0.15 });
    st.t = tLand + 1.2; st.x = rx;
    if (kick.result === 'downed') {
      const g = P.actor(P.off, 8);
      P.arrive(g, P.snapT + 1, st.t + 0.2, rx - d * 0.5, restY + 0.4);
      g.pose(st.t + 0.1, st.t + 1, POSE.KNEEL);
    }
    if (!a.legs.some(l => l.k === 'dead')) whistle(P, st.t + 0.2);
  }
  if (blocked) {
    const blocker = P.actor(P.def, S.DT1);
    P.path(blocker, P.snapT, tKick, [[fromX + d * 1.2, P.by]], 'run');
    blocker.pose(tKick - 0.2, tKick + 0.5, POSE.CATCH);
    P.event(tKick, 'blocked');
  }
  const legs = a.legs.slice(a.legs.indexOf(kick) + 1);
  if (caught && !legs.some(l => l.k === 'catch')) legs.unshift({ k: 'catch', who: legs.find(l => l.k === 'run')?.who || { name: null, team: P.def }, atX: landX });
  runLegs(P, legs, st);
  P.end = Math.max(P.whistle === Infinity ? st.t + 1 : P.whistle, st.t) + 2.2;
}

function buildPlaceKick(P) {
  const a = P.a;
  const kick = a.legs.find(l => l.k === 'kick');
  const d = P.dir;
  // the line is 7 yards in front of the hold
  P.los = kick.fromX + d * 7;
  if (kick.kind === 'xp') P.by = 0;
  P.setupBodies('kick', 'def');
  P.placeForm(P.off, PLACE_FORM, false);
  P.placeForm(P.def, PLACE_BLOCK_FORM, true);
  P.placeOfficials();
  castPlay(P);
  defaultRoles(P);
  const holder = P.actor(P.off, 6);
  const kicker = P.actor(P.off, 5);
  const st = { t: 0, holder: null, x: P.los, y: P.by };
  snap(P, st, 1.1, holder);
  holder.pose(0.3, 99, POSE.KNEEL);
  const tKick = st.t + 0.9;
  P.path(kicker, st.t + 0.1, tKick, [[kick.fromX - d * 0.5, P.by + 0.4]], 'in');
  kicker.pose(tKick - 0.15, tKick + 0.4, POSE.KICK);
  if (kick.who?.name) P.label(kicker, 0, tKick + 3.5, kick.who.name);
  P.ball.push({ t0: st.t + 0.15, type: 'rest', x: kick.fromX, y: P.by + 0.2, z: 0.3 });
  P.event(tKick, 'kick');
  const goalX = d > 0 ? 110 : -10;
  const yards = Math.abs(goalX - kick.fromX);
  let toY = 0, toZ = 4.5 + yards * 0.04, overX = goalX + d * 6, landZ = 0.15;
  const miss = kick.miss || '';
  if (kick.result === 'good') toY = (P.rand() - 0.5) * 2.4;
  else if (/Right/.test(miss)) toY = -d * (3.6 + P.rand() * 1.5);
  else if (/Left/.test(miss)) toY = d * (3.6 + P.rand() * 1.5);
  else if (/Short/.test(miss)) { toZ = 2.4; overX = goalX - d * 1.5; }
  else if (/Upright|Crossbar/.test(miss)) { toY = /Left/.test(miss) ? d * 3.08 : -d * 3.08; }
  const flight = 0.6 + yards / 26;
  if (kick.result === 'blocked') {
    const bl = P.actor(P.def, S.LB2);
    P.path(bl, P.snapT, tKick, [[P.los + d * 0.3, P.by]], 'run');
    bl.pose(tKick - 0.2, tKick + 0.5, POSE.CATCH);
    const bx = P.los - d * 3, byy = clampY(P.by + (P.rand() - 0.5) * 8);
    P.ball.push({ t0: tKick, t1: tKick + 0.4, type: 'flight', to: [P.los, P.by, 1.9], apex: 0.5 });
    P.ball.push({ t0: tKick + 0.4, t1: tKick + 1.6, type: 'bounce', to: [bx, byy], hops: 3, height: 1.2 });
    P.ball.push({ t0: tKick + 1.6, type: 'rest', x: bx, y: byy, z: 0.15 });
    P.event(tKick + 0.4, 'blocked');
    whistle(P, tKick + 1.8);
  } else {
    // through (or past) the posts, then down behind them
    const tPosts = tKick + flight;
    const yAt = toY;
    P.ball.push({ t0: tKick, t1: tPosts, type: 'flight', to: [goalX, yAt, toZ], apex: 3 + yards * 0.06, kick: true, endOver: true });
    P.ball.push({ t0: tPosts, t1: tPosts + 0.7, type: 'flight', to: [overX, yAt * 1.15, landZ], apex: 0.4 });
    P.ball.push({ t0: tPosts + 0.7, type: 'rest', x: overX, y: yAt * 1.15, z: 0.15 });
    P.event(tPosts, kick.result === 'good' ? 'good' : 'nogood', { kind: kick.kind });
    whistle(P, tPosts + 0.3);
    if (kick.result === 'good') {
      const refs = P.bodies.slice(N_PLAYERS);
      for (const r of [refs[3]]) { P.path(r, tKick, tPosts - 0.4, [[goalX + d * 1.5, 0]], 'smooth'); r.pose(tPosts, tPosts + 2.4, POSE.SIGNAL); }
    }
  }
  P.end = P.whistle + 2.4;
}

// A flag for any accepted foul: an official tosses it toward the spot.
function addFlag(P) {
  const pen = P.a.penalties.find(p => !p.declined && !p.offsetting) || P.a.penalties.find(p => !p.declined);
  if (!pen) return;
  const ref = P.bodies[N_PLAYERS + (P.rand() < 0.5 ? 1 : 2)];
  const t = P.a.kind === 'penalty' ? 1.75 : Math.min(P.whistle === Infinity ? P.end - 2 : P.whistle - 0.3, P.snapT + 1.6);
  const fx = pen.enforcedX ?? P.los;
  P.flag = { t, from: [ref.home[0], ref.home[1]], to: [fx + (P.rand() - 0.5) * 3, clampY(P.by + (P.rand() - 0.5) * 8)] };
  P.event(t, 'flag', { foul: pen.foul, team: pen.team, player: pen.player, yards: pen.yards, noPlay: pen.noPlay });
  P.end = Math.max(P.end, t + 3);
}

// ---------------------------------------------------------------- the run --

// One step of steering toward a target, within the body's limits.
function steer(b, tgt, speed, t, L, dt, P) {
  const dx = tgt[0] - b.x, dy = tgt[1] - b.y;
  const d = Math.hypot(dx, dy);
  let vmax = b.maxSpeed * (speed ?? 1) * (L.whistled ? 0.45 : 1) * (t < L.snap ? 0.6 : 1);
  if (b.contact > 0) vmax *= 0.35;
  // arrive: slow down near the target
  const want = d > 0.05 ? Math.min(vmax, d * 2.2) : 0;
  const tvx = d > 0.05 ? (dx / d) * want : 0, tvy = d > 0.05 ? (dy / d) * want : 0;
  const acc = 11 * dt;
  b.vx += clamp(tvx - b.vx, -acc, acc);
  b.vy += clamp(tvy - b.vy, -acc, acc);
  void P;
  return [b.x + b.vx * dt, b.y + b.vy * dt];
}

function simulate(P) {
  const F = Math.ceil(P.end * FPS) + 1;
  const N = P.bodies.length;
  const pos = new Float32Array(F * N * 4);
  const ball = new Float32Array(F * 4);
  const dt = 1 / FPS;
  const L = P.live;
  L.snap = L.snap ?? P.snapT ?? 1;
  const ballPhases = P.ball.slice().sort((a, b) => a.t0 - b.t0);
  const ballFrom = new Map(); // phase -> start position (resolved at runtime)
  let lastBall = [P.los, P.by, 0.15];

  for (const b of P.bodies) b.pathStart = new Map();

  for (let f = 0; f < F; f++) {
    const t = f * dt;
    L.t = t;
    L.whistled = t >= P.whistle;
    // ball state first (uses last frame's bodies)
    let bp = null;
    for (const p of ballPhases) if (p.t0 <= t + 1e-6) bp = p; else break;
    L.flight = null;
    L.carrier = -1;
    let bx = lastBall[0], by = lastBall[1], bz = lastBall[2], spin = 0;
    if (bp) {
      if (bp.type === 'held') {
        const h = P.bodies[bp.who];
        L.carrier = h.i;
        bx = h.x + Math.cos(h.h) * 0.35; by = h.y + Math.sin(h.h) * 0.35; bz = 1.05;
        if (h.poseNow === POSE.DOWN || h.poseNow === POSE.DIVE) bz = 0.35;
        if (h.poseNow === POSE.KNEEL) bz = 0.6;
      } else if (bp.type === 'rest') {
        bx = bp.x; by = bp.y; bz = bp.z;
      } else {
        if (!ballFrom.has(bp)) ballFrom.set(bp, bp.from || lastBall.slice());
        const from = ballFrom.get(bp);
        const u = clamp((t - bp.t0) / Math.max(1e-3, bp.t1 - bp.t0), 0, 1);
        if (bp.type === 'flight') {
          bx = lerp(from[0], bp.to[0], u); by = lerp(from[1], bp.to[1], u);
          bz = lerp(from[2], bp.to[2], u) + 4 * (bp.apex || 0) * u * (1 - u);
          spin = bp.kick ? 2 : 1;
          if (t < bp.t1 && bp.t1 - bp.t0 > 0.25) L.flight = [bp.to[0], bp.to[1]];
          L.thrown = L.thrown || !!bp.spiral;
        } else if (bp.type === 'bounce') {
          bx = lerp(from[0], bp.to[0], u); by = lerp(from[1], bp.to[1], u);
          const hops = bp.hops || 2;
          const ph = u * hops;
          const k = Math.floor(ph), fr = ph - k;
          bz = 0.15 + (bp.height || 1) * Math.pow(0.55, k) * 4 * fr * (1 - fr);
          spin = 3;
        }
      }
    }
    L.bx = bx; L.by = by;
    lastBall = [bx, by, bz];
    ball[f * 4] = bx; ball[f * 4 + 1] = by; ball[f * 4 + 2] = bz; ball[f * 4 + 3] = spin;

    // bodies
    for (const b of P.bodies) {
      const ph = b.activePhase(t);
      let nx = b.x, ny = b.y;
      if (ph?.type === 'path') {
        if (!b.pathStart.has(ph)) b.pathStart.set(ph, [b.x, b.y]);
        const start = b.pathStart.get(ph);
        const u = clamp((t - ph.t0) / (ph.t1 - ph.t0), 0, 1);
        [nx, ny] = pathPoint([start, ...ph.pts], (EASE[ph.ease] || EASE.run)(u));
        b.vx = (nx - b.x) / dt; b.vy = (ny - b.y) / dt;
      } else if (ph?.type === 'arrive') {
        const rem = ph.t1 - t;
        const dx = ph.x - b.x, dy = ph.y - b.y;
        const d = Math.hypot(dx, dy);
        if (rem <= dt * 1.01) {
          if (rem > -dt) { nx = ph.x; ny = ph.y; b.vx = dx / dt; b.vy = dy / dt; }
          else { b.vx *= 0.8; b.vy *= 0.8; nx = b.x + b.vx * dt; ny = b.y + b.vy * dt; }
        } else {
          const need = d / rem;
          if (!ph.committed && need < b.maxSpeed * 0.72 && b.defaultSeek) {
            [nx, ny] = steer(b, b.defaultSeek.fn(t) || [b.x, b.y], b.defaultSeek.speed, t, L, dt, P);
          } else {
            ph.committed = true;
            const tvx = (dx / (d || 1)) * need, tvy = (dy / (d || 1)) * need;
            b.vx = lerp(b.vx, tvx, 0.3); b.vy = lerp(b.vy, tvy, 0.3);
            nx = b.x + b.vx * dt; ny = b.y + b.vy * dt;
          }
        }
      } else if (ph?.type === 'seek' && !(L.whistled && t > P.whistle + 1.2)) {
        [nx, ny] = steer(b, ph.fn(t) || [b.x, b.y], ph.speed, t, L, dt, P);
      } else {
        // hold: coast to a stop
        b.vx *= 0.85; b.vy *= 0.85;
        nx = b.x + b.vx * dt; ny = b.y + b.vy * dt;
      }
      b.nx = nx; b.ny = ny;
    }
    // bodies do not pass through each other (scripted ones push, never yield)
    for (const b of P.bodies) b.contact = 0;
    for (let i = 0; i < N_PLAYERS; i++) {
      const A = P.bodies[i];
      for (let j = i + 1; j < N_PLAYERS; j++) {
        const B = P.bodies[j];
        const dx = B.nx - A.nx, dy = B.ny - A.ny;
        const d2 = dx * dx + dy * dy;
        if (d2 > 0.81 || d2 < 1e-8) continue;
        const d = Math.sqrt(d2);
        if (A.team !== B.team && t > L.snap) { A.contact++; B.contact++; }
        const push = Math.min(0.06, (0.9 - d) / 2);
        const ux = dx / d, uy = dy / d;
        const fixed = X => { const p = X.activePhase(t); return p?.type === 'path' || p?.type === 'arrive' && p.committed; };
        const aFixed = fixed(A), bFixed = fixed(B);
        if (aFixed && bFixed) continue;
        if (aFixed) { B.nx += ux * push * 2; B.ny += uy * push * 2; }
        else if (bFixed) { A.nx -= ux * push * 2; A.ny -= uy * push * 2; }
        else { A.nx -= ux * push; A.ny -= uy * push; B.nx += ux * push; B.ny += uy * push; }
      }
    }
    for (const b of P.bodies) {
      b.x = b.nx; b.y = b.ny;
      const sp = Math.hypot(b.vx, b.vy);
      let want = b.face;
      if (sp > 0.6) want = Math.atan2(b.vy, b.vx);
      else if (t > L.snap) want = Math.atan2(by - b.y, bx - b.x);
      let dh = want - b.h;
      while (dh > Math.PI) dh -= 2 * Math.PI;
      while (dh < -Math.PI) dh += 2 * Math.PI;
      b.h += dh * Math.min(1, dt * 9);
      let pose = b.poseAt(t);
      if (pose == null) pose = sp > 1.3 ? POSE.RUN : POSE.STAND;
      if (pose === POSE.STAND && b.contact && t > L.snap && !L.whistled) pose = POSE.BLOCK;
      b.poseNow = pose;
      const o = (f * N + b.i) * 4;
      pos[o] = b.x; pos[o + 1] = b.y; pos[o + 2] = b.h; pos[o + 3] = pose + Math.min(0.99, sp / 10);
    }
    // a held ball is in this frame's hands, not last frame's
    if (bp?.type === 'held') {
      const h = P.bodies[bp.who];
      const z = h.poseNow === POSE.DOWN || h.poseNow === POSE.DIVE ? 0.35 : h.poseNow === POSE.KNEEL ? 0.6 : 1.05;
      const hx = h.x + Math.cos(h.h) * 0.35, hy = h.y + Math.sin(h.h) * 0.35;
      ball[f * 4] = hx; ball[f * 4 + 1] = hy; ball[f * 4 + 2] = z;
      lastBall = [hx, hy, z];
      L.bx = hx; L.by = hy;
    }
  }
  return { pos, ball, frames: F, n: N };
}

// ------------------------------------------------------------------ entry --

export function choreograph(action, ctx, cast, opts = {}) {
  if (!action || action.kind === 'stoppage' || action.kind === 'timeout') return null;
  const P = new Play(action, ctx, cast, opts);
  P.flightWindows = [];
  switch (action.kind) {
    case 'kickoff': buildKickoff(P); break;
    case 'punt': buildPunt(P); break;
    case 'fg': case 'xp': buildPlaceKick(P); break;
    case 'penalty': buildPreSnapFoul(P); break;
    default: buildScrimmage(P);
  }
  if (action.penalties?.length) addFlag(P);
  P.end = Math.min(P.end, 30);
  const sim = simulate(P);
  const finalBall = [sim.ball[(sim.frames - 1) * 4], sim.ball[(sim.frames - 1) * 4 + 1]];
  // where the next snap goes across the field: inside the hashes
  let nextY = clamp(finalBall[1], -HASH_Y, HASH_Y);
  if (action.touchdown || action.kind === 'fg' || action.kind === 'xp' || action.kind === 'kickoff' && action.legs.some(l => l.result === 'touchback')) nextY = 0;
  if (action.noPlay) nextY = P.by;
  return {
    id: action.id,
    kind: action.kind,
    duration: sim.frames / FPS,
    frames: sim.frames,
    n: sim.n,
    pos: sim.pos,
    ball: sim.ball,
    events: P.events.sort((a, b) => a.t - b.t),
    labels: P.labels,
    flag: P.flag || null,
    whistle: Number.isFinite(P.whistle) ? P.whistle : null,
    snapT: P.snapT ?? 0,
    los: P.los,
    by: P.by,
    dir: P.dir,
    nextY,
    teams: P.bodies.map(b => b.team),
    numbers: P.bodies.map(b => (b.team === 'ref' ? '' : cast.number(b.team, P.units[b.team], b.slot))),
    units: P.units,
    ...(opts.debug ? { debug: P } : {}),
  };
}

// The try after a touchdown, as its own action.
export function tryActions(action, ctx) {
  const out = [];
  for (const t of action.after || []) {
    const team = action.touchdown || action.offense;
    const d = ctx.dir(team);
    if (t.kind === 'xp') {
      out.push({
        ...action, id: `${action.id}-xp`, kind: 'xp', offense: team, defense: ctx.other(team), dir: d,
        los: d > 0 ? 85 : 15, legs: [{ k: 'snap', to: 'holder' }, { k: 'kick', kind: 'xp', who: { name: t.kicker, team }, fromX: d > 0 ? 77 : 23, toX: d > 0 ? 110 : -10, yards: 33, result: t.good ? 'good' : 'nogood', miss: t.miss }],
        penalties: [], after: [], noPlay: false, touchdown: null, call: `${t.kicker} extra point is ${t.good ? 'good' : 'no good'}.`,
      });
    }
  }
  return out;
}
