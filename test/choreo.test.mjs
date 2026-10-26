// Every saved play, choreographed. Checks that the motion is sane: no NaN,
// the ball ends where the words say, nobody outruns a human for long, and
// a clip is cheap enough to build while the previous one is playing.
//
//   node test/choreo.test.mjs [--show]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGame } from '../src/football/parse.js';
import { Cast } from '../src/football/cast.js';
import { choreograph, tryActions, FPS, N_PLAYERS } from '../src/football/choreo.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(ROOT, 'data', 'games');
const show = process.argv.includes('--show');
if (!fs.existsSync(dir) || !fs.readdirSync(dir).some(f => f.endsWith('.json'))) {
  console.log('no saved games in data/games; pull some first: node tools/fetch.mjs --week 7');
  process.exit(0);
}

let clips = 0, crashes = 0, nans = 0, offEnd = 0, checked = 0, fast = 0, ms = 0, worstMs = 0;
const misses = [];
const durs = [];
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
  const game = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const { ctx, actions } = parseGame(game);
  const cast = new Cast(ctx);
  let ballY = 0;
  for (const a of actions) {
    for (const act of [a, ...tryActions(a, ctx)]) {
      let clip;
      const t0 = performance.now();
      try {
        clip = choreograph(act, ctx, cast, { ballY });
      } catch (err) {
        crashes++;
        misses.push(['crash', `${err.stack.split('\n').slice(0, 3).join(' / ')}  <<  ${act.text}`]);
        continue;
      }
      const el = performance.now() - t0;
      if (!clip) continue;
      ms += el; worstMs = Math.max(worstMs, el);
      clips++;
      durs.push(clip.duration);
      ballY = clip.nextY;
      if (clip.pos.some(v => !Number.isFinite(v)) || clip.ball.some(v => !Number.isFinite(v))) {
        nans++;
        misses.push(['NaN', act.text]);
        continue;
      }
      // where did the ball end up
      // the ball where the whistle blew (afterwards players run it out)
      const F = clip.frames;
      const wf = Math.min(F - 1, Math.round((clip.whistle ?? clip.duration) * FPS));
      const bx = clip.ball[wf * 4];
      const incomplete = act.legs.some(l => l.k === 'pass' && l.result === 'incomplete');
      const plain = !act.penalties.length && ['rush', 'pass', 'sack', 'scramble', 'kneel'].includes(act.kind) && !act.touchdown && !incomplete;
      if (plain) {
        checked++;
        if (Math.abs(bx - act.endX) > 1.5) {
          offEnd++;
          misses.push(['ball', `ends ${bx.toFixed(1)} want ${act.endX}: ${act.text}`]);
        }
      }
      // sustained superhuman speed (> 11.5 yd/s, ~23.5 mph, for 4+ frames)
      for (let i = 0; i < N_PLAYERS; i++) {
        let run = 0;
        for (let k = 1; k < F; k++) {
          const o = (k * clip.n + i) * 4, p = ((k - 1) * clip.n + i) * 4;
          const v = Math.hypot(clip.pos[o] - clip.pos[p], clip.pos[o + 1] - clip.pos[p + 1]) * FPS;
          run = v > 11.5 ? run + 1 : 0;
          if (run === 4) { fast++; misses.push(['fast', `${act.kind} actor ${i}: ${act.text}`]); break; }
        }
      }
    }
  }
}
durs.sort((a, b) => a - b);
const pct = (n, d) => ((100 * n) / Math.max(1, d)).toFixed(2) + '%';
console.log(`clips ${clips}  crashes ${crashes}  NaN ${nans}  ball off its spot ${offEnd}/${checked} (${pct(offEnd, checked)})  superhuman bursts ${fast} (${pct(fast, clips)} of clips)`);
console.log(`duration median ${durs[durs.length >> 1]?.toFixed(1)}s  p95 ${durs[Math.floor(durs.length * 0.95)]?.toFixed(1)}s  build ${(ms / Math.max(1, clips)).toFixed(1)}ms avg, ${worstMs.toFixed(0)}ms worst`);
if (show) {
  const byKind = {};
  for (const [k, t] of misses) (byKind[k] ||= []).push(t);
  for (const [k, list] of Object.entries(byKind)) {
    console.log(`\n[${k}] ${list.length}`);
    for (const t of list.slice(0, 25)) console.log('   ' + t);
  }
}
const ok = crashes === 0 && nans === 0 && offEnd / Math.max(1, checked) < 0.01 && fast / Math.max(1, clips) < 0.02;
console.log(ok ? 'ok' : 'FAIL');
process.exit(ok ? 0 : 1);
