// Every saved game, every play, through the parser. The feed reports where
// each play ended; the parser works it out from the words alone. They must
// agree, and the parser must read (nearly) every line.
//
//   node test/parse.test.mjs           pass/fail
//   node test/parse.test.mjs --show    print the misses

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGame } from '../src/football/parse.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(ROOT, 'data', 'games');
const show = process.argv.includes('--show');
if (!fs.existsSync(dir) || !fs.readdirSync(dir).some(f => f.endsWith('.json'))) {
  console.log('no saved games in data/games; pull some first: node tools/fetch.mjs --week 7');
  process.exit(0);
}

let total = 0, unknown = 0, unparsed = 0, checked = 0, mismatched = 0;
const kinds = {};
const misses = [];
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
  const game = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const { actions } = parseGame(game);
  for (const a of actions) {
    total++;
    kinds[a.kind] = (kinds[a.kind] || 0) + 1;
    if (a.kind === 'unknown') { unknown++; misses.push(['unknown', a.text]); }
    if (a.unparsed) { unparsed++; misses.push(['unparsed', `${a.unparsed}   <<  ${a.text}`]); }
    for (const l of a.legs) {
      for (const k of ['fromX', 'toX', 'atX']) {
        if (k in l && l[k] != null && !Number.isFinite(l[k])) misses.push(['NaN', `${l.k}.${k} in ${a.text}`]);
      }
    }
    // Spot check: plays with no penalty that did not score and did not end
    // in a touchback (the feed's end spot is then the next play's).
    const plain = !a.penalties.length && !a.scoring && a.nextX != null &&
      !['stoppage', 'timeout', 'penalty', 'unknown', 'xp'].includes(a.kind) &&
      !a.legs.some(l => l.result === 'touchback' || l.how === 'touchback' || l.k === 'kick' && l.kind === 'fg');
    if (plain) {
      checked++;
      if (Math.abs(a.endX - a.nextX) > 0.5) {
        mismatched++;
        misses.push(['spot', `parsed ${a.endX} feed ${a.nextX}: ${a.text}`]);
      }
    }
  }
}

const pct = (n, d) => ((100 * n) / Math.max(1, d)).toFixed(2) + '%';
console.log(`plays ${total}  unknown ${unknown} (${pct(unknown, total)})  partly unread ${unparsed} (${pct(unparsed, total)})  spot misses ${mismatched}/${checked} (${pct(mismatched, checked)})`);
console.log(Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join('  '));
if (show) for (const [k, t] of misses) console.log(`  [${k}] ${t}`);

const nan = misses.filter(m => m[0] === 'NaN').length;
const ok = nan === 0 && unknown / total < 0.005 && unparsed / total < 0.01 && mismatched / checked < 0.01;
if (!ok) { console.log('FAIL'); process.exit(1); }
console.log('ok');
