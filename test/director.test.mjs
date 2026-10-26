// The timeline: real-time gaps follow the stadium's wallclock, condensed
// gaps are short, live plays never start before they arrive, and sampling
// a whole game second by second never produces a broken frame.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Director } from '../src/director.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(ROOT, 'data', 'games', '401873022.json');
if (!fs.existsSync(file)) {
  console.log('needs data/games/401873022.json: node tools/fetch.mjs 401873022');
  process.exit(0);
}
const game = JSON.parse(fs.readFileSync(file, 'utf8'));
let fail = 0;
const check = (ok, msg) => { if (!ok) { fail++; console.log('  FAIL ' + msg); } };

// condensed: a whole game in well under real time, every second sampled
{
  const d = new Director(game);
  d.seek(0);
  const last = d.entries.at(-1);
  const total = (last.start + d.duration(d.entries.length - 1) * 1000) / 1000;
  console.log(`condensed game: ${(total / 60).toFixed(1)} min for ${d.entries.length} entries`);
  check(total < 60 * 60, 'condensed game should be under an hour');
  let bad = 0, phases = {};
  for (let t = 0; t < total * 1000; t += 1000) {
    d.vt = t;
    const s = d.sample();
    phases[s.phase] = (phases[s.phase] || 0) + 1;
    if (!s.frame || [...s.frame.pos].some(v => !Number.isFinite(v)) || [...s.frame.ball].some(v => !Number.isFinite(v))) bad++;
    if (!/^\d+:\d\d$/.test(s.clock)) bad++;
  }
  console.log(`  sampled ${Math.round(total)}s: ${JSON.stringify(phases)}, broken frames ${bad}`);
  check(bad === 0, 'every sampled frame should be whole');
  check(d.entries.at(-1).action.homeScore === 20 && d.entries.at(-1).action.awayScore === 3, 'final score carried');
}

// realtime: gaps follow the wallclock
{
  const d = new Director(game);
  d.mode = 'realtime';
  d.seek(0);
  const E = d.entries.filter(e => !e.isTry);
  let near = 0, n = 0;
  for (let i = 1; i < E.length; i++) {
    const w = E[i].action.wallclock - E[i - 1].action.wallclock;
    const g = E[i].start - E[i - 1].start;
    if (!E[i].action.wallclock || !E[i - 1].action.wallclock || w > 240000 || w < 15000) continue;
    n++;
    if (Math.abs(g - w) < 1500) near++;
  }
  console.log(`realtime: ${near}/${n} snap-to-snap gaps match the stadium's`);
  check(near / n > 0.9, 'realtime gaps should follow the wallclock');
}

// live: new plays are scheduled after now and after the previous play
{
  const half = { ...game, plays: game.plays.slice(0, 20), status: { ...game.status, state: 'in' } };
  const d = new Director(half);
  d.mode = 'live';
  d.seek(0);
  d.vt = d.entries.at(-1).start + 60000; // far past the last known play
  const before = d.entries.length;
  const added = d.update({ ...game, plays: game.plays.slice(0, 26), status: { ...game.status, state: 'in' } });
  console.log(`live: ${added} new plays appended to ${before}`);
  check(added >= 6, 'update should append the new plays');
  const fresh = d.entries.slice(before);
  check(fresh.every(e => e.start >= d.vt), 'new plays cannot start in the past');
  check(fresh.every((e, k) => k === 0 || e.start > fresh[k - 1].start), 'new plays keep their order');
}

console.log(fail ? `${fail} failed` : 'ok');
process.exit(fail ? 1 : 0);
