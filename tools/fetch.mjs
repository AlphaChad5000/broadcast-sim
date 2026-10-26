// Pull games to data/games/ so they replay offline.
//
//   node tools/fetch.mjs 401873022 401873009      specific games
//   node tools/fetch.mjs --week 7 [--year 2026]    every game in a week
//   node tools/fetch.mjs                           this week's scoreboard

import { ESPN, normalizeScoreboard } from '../src/feed.js';
import { loadGame } from '../server.mjs';

const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };

let ids = args.filter(a => /^\d{6,}$/.test(a) && !['--week', '--year'].some(k => opt(k) === a));
if (!ids.length) {
  const q = new URLSearchParams();
  if (opt('--week')) q.set('week', opt('--week'));
  if (opt('--year')) q.set('year', opt('--year'));
  q.set('seasontype', opt('--seasontype') || '2');
  const sb = normalizeScoreboard(await (await fetch(`${ESPN.scoreboard}?${q}`)).json());
  ids = sb.games.filter(g => g.state !== 'pre').map(g => g.id);
  console.log(`week ${sb.week}: ${ids.length} games started or finished`);
}

for (const id of ids) {
  try {
    const g = await loadGame(id, { fresh: true });
    console.log(`${id}  ${g.away.abbr} ${g.away.score} @ ${g.home.abbr} ${g.home.score}  ${g.status.detail}  ${g.plays.length} plays`);
  } catch (err) {
    console.log(`${id}  failed: ${err.message}`);
  }
}
