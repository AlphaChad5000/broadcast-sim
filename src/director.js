// The director: puts the game's plays on a clock.
//
// Every play becomes an ENTRY with a start time on a virtual timeline (ms).
// The timeline has three paces:
//
//   realtime   the gap between two snaps is the gap the stadium had (the
//              feed stamps each play with a wallclock), so a game takes as
//              long as the game did -- huddles, timeouts, TV breaks
//   condensed  the next snap comes a few seconds after the last whistle
//   live       plays are scheduled as they ARRIVE from the feed, never
//              earlier than now and never before the previous one is done
//
// Between plays the bodies walk from where the last play left them to where
// the next one lines up (huddle first when there is time). Stoppages
// (timeouts, quarter ends) take a slot on the timeline with no clip.
//
// Clips are built lazily and strictly in order, because the cast and the
// ball's spot across the field carry from one play to the next.

import { parseGame } from './football/parse.js';
import { Cast } from './football/cast.js';
import { choreograph, tryActions, FPS, N_ACTORS, POSE, HASH_Y } from './football/choreo.js';
import { callScript, shortDown } from './football/call.js';

const GAP_CONDENSED = 4.5; // s between whistle+settle and the next snap
const GAP_STOPPAGE = 3.5;
const MAX_REALTIME_GAP = 240; // a long TV break still has to end

export class Director {
  constructor(game) {
    this.mode = 'condensed';
    this.speed = 1;
    this.vt = 0;
    this.entries = [];
    this.cursorIdx = 0;
    this.load(game);
  }

  load(game) {
    this.game = game;
    const { ctx, actions } = parseGame(game);
    this.ctx = ctx;
    this.cast = new Cast(ctx);
    this.entries = [];
    for (const a of actions) this._push(a);
    this.built = 0;
    this.ballY = 0;
  }

  _push(a) {
    this.entries.push({ action: a, clip: undefined, start: null });
    for (const t of tryActions(a, this.ctx)) this.entries.push({ action: t, clip: undefined, start: null, isTry: true, parent: a });
  }

  // Live: merge a fresh copy of the game. New plays append; a play the feed
  // rewrote (it does, after reviews) is re-parsed if it has not played yet.
  update(game) {
    this.game = game;
    const { ctx, actions } = parseGame(game);
    this.ctx = ctx;
    this.cast.ctx = ctx;
    const known = new Map(this.entries.filter(e => !e.isTry).map((e, i) => [e.action.id, i]));
    let added = 0;
    for (const a of actions) {
      const i = known.get(a.id);
      if (i == null) { this._push(a); added++; continue; }
      const e = this.entries.filter(e => !e.isTry)[i];
      if (e.action.text !== a.text && e.clip === undefined) e.action = a;
    }
    if (added) this.schedule(this.entries.length - added);
    return added;
  }

  // ------------------------------------------------------------- clips --

  clip(i) {
    while (this.built <= i && this.built < this.entries.length) {
      const e = this.entries[this.built];
      try {
        e.clip = choreograph(e.action, this.ctx, this.cast, { ballY: this.ballY });
      } catch (err) {
        console.error('choreograph failed', e.action.text, err);
        e.clip = null;
      }
      if (e.clip) {
        this.ballY = e.clip.nextY;
        e.call = callScript(e.action, e.clip, this.ctx);
      }
      this.built++;
    }
    return this.entries[i]?.clip ?? null;
  }

  duration(i) {
    const c = this.clip(i);
    return c ? c.duration : GAP_STOPPAGE;
  }

  // ---------------------------------------------------------- timeline --

  setMode(mode) { this.mode = mode; this.schedule(this.cursorIdx, this.vt); }

  // Starts at entry `from` at virtual time `at`, then lays the rest out.
  schedule(from = 0, at) {
    const E = this.entries;
    if (!E.length) return;
    from = Math.max(0, Math.min(from, E.length - 1));
    let i0 = from;
    if (at != null || from === 0) { E[from].start = at ?? this.vt; i0 = from + 1; }
    for (let i = i0; i < E.length; i++) {
      const prev = E[i - 1], cur = E[i];
      const prevEnd = prev.start + this.duration(i - 1) * 1000;
      let start;
      const wPrev = prev.isTry ? prev.parent.wallclock : prev.action.wallclock;
      const wCur = cur.action.wallclock;
      if (this.mode === 'realtime' && wPrev && wCur && !cur.isTry) {
        const gap = Math.min(MAX_REALTIME_GAP * 1000, Math.max(0, wCur - wPrev));
        start = Math.max(prev.start + gap, prevEnd + 1500);
      } else {
        const g = cur.clip === null || !this._hasClip(i) ? GAP_STOPPAGE : cur.isTry ? 2.5 : GAP_CONDENSED;
        start = prevEnd + g * 1000;
      }
      // live: a play that just arrived cannot have started in the past
      if (this.mode === 'live') start = Math.max(start, this.vt + 800);
      cur.start = start;
    }
  }

  _hasClip(i) {
    const k = this.entries[i].action.kind;
    return k !== 'stoppage' && k !== 'timeout';
  }

  seek(i) {
    this.cursorIdx = i;
    this.clip(i);
    this.schedule(i, this.vt);
  }

  tick(dtMs) {
    this.vt += dtMs * (this.mode === 'live' ? this.catchUp() : this.speed);
  }

  // Live and behind (joined mid-drive, or the feed delivered a batch): run
  // a little fast until the picture is back with the feed.
  catchUp() {
    const queued = this.entries.length - 1 - this.current();
    return queued > 2 ? Math.min(3, 1 + (queued - 2) * 0.25) : 1;
  }

  // The index of the entry on screen now (the last that has started).
  current() {
    const E = this.entries;
    let i = Math.min(this.cursorIdx, E.length - 1);
    while (i + 1 < E.length && E[i + 1].start != null && E[i + 1].start <= this.vt) i++;
    this.cursorIdx = i;
    return i;
  }

  // ------------------------------------------------------------ sample --

  // Everything the renderer and the graphics need for this instant.
  sample() {
    const E = this.entries;
    if (!E.length) return null;
    const i = this.current();
    const e = E[i];
    const lt = (this.vt - e.start) / 1000;
    const clip = this.clip(i);
    // the next entry that has a clip: the formation we walk toward
    let j = i + 1;
    while (j < E.length && !this._hasClip(j)) j++;
    const nextClip = j < E.length ? this.clip(j) : null;
    const nextStart = j < E.length ? E[j].start : null;
    // the last clip at or before i: where the bodies are coming from
    let k = i;
    while (k >= 0 && !E[k].clip) k--;
    const fromClip = k >= 0 ? E[k].clip : null;
    const fromEnd = k >= 0 ? E[k].start + E[k].clip.duration * 1000 : this.vt;

    let frame = null, phase;
    if (clip && lt <= clip.duration) {
      frame = frameAt(clip, lt);
      phase = clip.whistle != null && lt > clip.whistle ? 'post' : lt < clip.snapT ? 'pre' : 'play';
    } else {
      phase = 'between';
      frame = between(fromClip, nextClip, (this.vt - fromEnd) / 1000, nextStart != null ? (nextStart - fromEnd) / 1000 : null, this.ctx);
    }

    // scoreboard state
    const a = e.action;
    const played = clip ? (clip.whistle != null ? lt >= clip.whistle : lt >= clip.duration - 1) : lt > 0.5;
    const scoreFrom = played ? a : prevPlay(E, i)?.action;
    // between plays the graphics already show the next snap's situation
    const shown = this._hasClip(i) && phase !== 'between' ? a : (E[j]?.action ?? a);
    return {
      i, entry: e, action: a, clip, lt, phase, frame,
      next: E[j] || null,
      score: { home: scoreFrom?.homeScore ?? 0, away: scoreFrom?.awayScore ?? 0 },
      period: shown.period,
      clock: phase === 'between' && E[j] && this.mode !== 'realtime' ? clockAt(this, j, 0, null) : clockAt(this, i, lt, clip),
      down: shortDown(shown),
      possession: shown.kind === 'kickoff' ? null : shown.offense,
      los: shown.los,
      firstDownX: shown.down && shown.kind !== 'kickoff' && shown.kind !== 'xp' ? firstDown(shown) : null,
      dir: shown.dir,
      call: e.call || [],
      waitingForFeed: phase === 'between' && j >= E.length,
    };
  }

  progress() {
    const E = this.entries;
    return { i: this.cursorIdx, n: E.length };
  }
}

function prevPlay(E, i) {
  for (let k = i - 1; k >= 0; k--) if (E[k].action.homeScore != null) return E[k];
  return null;
}

function firstDown(a) {
  const fx = a.los + a.dir * a.distance;
  if (fx >= 100 || fx <= 0) return null; // goal to go
  return fx;
}

function parseClock(s) {
  const m = /^(\d+):(\d+)/.exec(s || '');
  return m ? +m[1] * 60 + +m[2] : null;
}

// The game clock runs during plays and, in the real-time pace, between
// them; it never runs past the next play's stamped clock.
function clockAt(d, i, lt, clip) {
  const E = d.entries;
  const e = E[i];
  const c0 = parseClock(e.action.clock);
  if (c0 == null) return e.action.clock || '';
  let next = null;
  for (let k = i + 1; k < E.length; k++) {
    if (E[k].action.period !== e.action.period) break;
    const c = parseClock(E[k].action.clock);
    if (c != null) { next = c; break; }
  }
  let c = c0;
  if (clip && lt > clip.snapT) c = c0 - Math.min(lt - clip.snapT, (clip.whistle ?? clip.duration) - clip.snapT);
  if (next != null) c = Math.max(c, next);
  c = Math.max(0, c);
  const mm = Math.floor(c / 60), ss = Math.floor(c % 60);
  return `${mm}:${String(ss).padStart(2, '0')}`;
}

// ------------------------------------------------------------ sampling --

// Positions/poses/ball at clip time t (linear between frames).
export function frameAt(clip, t) {
  const f = Math.max(0, Math.min(clip.frames - 1, t * FPS));
  const f0 = Math.floor(f), f1 = Math.min(clip.frames - 1, f0 + 1), u = f - f0;
  const n = clip.n;
  const pos = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const a = (f0 * n + i) * 4, b = (f1 * n + i) * 4;
    pos[i * 4] = clip.pos[a] + (clip.pos[b] - clip.pos[a]) * u;
    pos[i * 4 + 1] = clip.pos[a + 1] + (clip.pos[b + 1] - clip.pos[a + 1]) * u;
    let dh = clip.pos[b + 2] - clip.pos[a + 2];
    while (dh > Math.PI) dh -= 2 * Math.PI;
    while (dh < -Math.PI) dh += 2 * Math.PI;
    pos[i * 4 + 2] = clip.pos[a + 2] + dh * u;
    pos[i * 4 + 3] = u < 0.5 ? clip.pos[a + 3] : clip.pos[b + 3];
  }
  const ball = new Float32Array(4);
  for (let k = 0; k < 4; k++) ball[k] = clip.ball[f0 * 4 + k] + (clip.ball[f1 * 4 + k] - clip.ball[f0 * 4 + k]) * u;
  // ball velocity for orientation
  const g = Math.min(clip.frames - 1, f0 + 2);
  const vel = [(clip.ball[g * 4] - clip.ball[f0 * 4]) * FPS / Math.max(1, g - f0), (clip.ball[g * 4 + 1] - clip.ball[f0 * 4 + 1]) * FPS / Math.max(1, g - f0), (clip.ball[g * 4 + 2] - clip.ball[f0 * 4 + 2]) * FPS / Math.max(1, g - f0)];
  const labels = clip.labels.filter(l => t >= l.t0 && t <= l.t1).map(l => ({ ...l, alpha: Math.min(1, (t - l.t0) / 0.3, (l.t1 - t) / 0.4) }));
  let flag = null;
  if (clip.flag && t >= clip.flag.t) {
    const u2 = Math.min(1, (t - clip.flag.t) / 0.7);
    flag = {
      x: clip.flag.from[0] + (clip.flag.to[0] - clip.flag.from[0]) * u2,
      y: clip.flag.from[1] + (clip.flag.to[1] - clip.flag.from[1]) * u2,
      z: 0.05 + 4 * 2.2 * u2 * (1 - u2),
      landed: u2 >= 1,
    };
  }
  return { pos, ball, ballVel: vel, labels, flag, teams: clip.teams, numbers: clip.numbers, kind: clip.kind, t };
}

// Between two clips: walk from where the last left everyone to where the
// next lines them up. With time to spare the offense huddles first.
function between(from, to, t, gap, ctx) {
  const n = (from || to)?.n ?? N_ACTORS;
  const pos = new Float32Array(n * 4);
  const endOf = c => {
    const o = (c.frames - 1) * c.n * 4;
    return c.pos.subarray(o, o + c.n * 4);
  };
  const startOf = c => c.pos.subarray(0, c.n * 4);
  const A = from ? endOf(from) : to ? startOf(to) : null;
  const B = to ? startOf(to) : A;
  if (!A) return null;
  const teams = (to || from).teams;
  const g = gap ?? Infinity;
  const huddle = Number.isFinite(g) && g > 14 && to && to.kind !== 'kickoff';
  for (let i = 0; i < n; i++) {
    const ax = A[i * 4], ay = A[i * 4 + 1], bx = B[i * 4], by = B[i * 4 + 1];
    let x, y, h, moving = false;
    if (huddle) {
      // offense gathers 8 yards behind the ball, defense near the line; the
      // huddle breaks with 8 seconds to the snap
      const offense = teams[i] === (to.units && Object.keys(to.units).find(k => to.units[k] === 'off' || to.units[k] === 'kick'));
      const ang = (i % 11) / 11 * Math.PI * 2;
      const hx = to.los - to.dir * (offense ? 8 : -6) + Math.cos(ang) * (offense ? 1.6 : 3);
      const hy = to.by + Math.sin(ang) * (offense ? 1.6 : 4);
      const tHud = Math.max(4, g - 12), tBreak = g - 8, tSet = g - 2.5;
      const isRef = teams[i] === 'ref';
      if (isRef) [x, y, moving] = walk(ax, ay, bx, by, t, tSet);
      else if (t < tHud) [x, y, moving] = walk(ax, ay, hx, hy, t, tHud);
      else if (t < tBreak) [x, y] = [hx, hy];
      else [x, y, moving] = walk(hx, hy, bx, by, t - tBreak, tSet - tBreak);
      h = moving ? null : Math.atan2(to.by - y, to.los - x);
    } else {
      const tSet = Number.isFinite(g) ? Math.max(0.5, g - 1.2) : 8;
      [x, y, moving] = walk(ax, ay, bx, by, t, tSet);
      h = moving ? null : (to ? B[i * 4 + 2] : A[i * 4 + 2]);
    }
    pos[i * 4] = x; pos[i * 4 + 1] = y;
    pos[i * 4 + 2] = h ?? Math.atan2(by - ay, bx - ax);
    pos[i * 4 + 3] = moving ? POSE.RUN + 0.25 : POSE.STAND;
  }
  // the ball: where it died, then spotted for the next snap
  let ball;
  if (from && to) {
    const fb = (from.frames - 1) * 4;
    const u = Math.min(1, Math.max(0, (t - 2) / 2.5));
    const sx = to.ball[0], sy = to.ball[1], sz = to.ball[2];
    ball = new Float32Array([from.ball[fb] + (sx - from.ball[fb]) * u, from.ball[fb + 1] + (sy - from.ball[fb + 1]) * u, from.ball[fb + 2] + (sz - from.ball[fb + 2]) * u, 0]);
  } else if (to) ball = to.ball.slice(0, 4);
  else { const fb = (from.frames - 1) * 4; ball = from.ball.slice(fb, fb + 4); }
  void ctx; void HASH_Y;
  return { pos, ball, ballVel: [0, 0, 0], labels: [], flag: null, teams, numbers: (to || from).numbers, kind: 'between', t };
}

function walk(ax, ay, bx, by, t, T) {
  const d = Math.hypot(bx - ax, by - ay);
  if (d < 0.05) return [bx, by, false];
  const speed = Math.max(1.8, d / Math.max(0.5, T));
  const s = Math.min(d, Math.max(0, t) * speed);
  const u = s / d;
  return [ax + (bx - ax) * u, ay + (by - ay) * u, u < 1];
}
