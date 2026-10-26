// Static server + a thin ESPN proxy.
//
//   GET /api/scoreboard[?week=7&year=2026&seasontype=2 | ?dates=20261026]
//   GET /api/game/:id         normalized summary (src/feed.js)
//
// A finished game is written to data/games/<id>.json the first time it is
// asked for and served from disk after that, so replays work offline and
// never hit ESPN again. A live game is always fetched fresh (the browser
// polls it every few seconds) but kept on disk too, so a dropped connection
// mid-game still has something to show.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESPN, normalizeSummary, normalizeScoreboard } from './src/feed.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const GAMES = path.join(ROOT, 'data', 'games');
const PORT = Number(process.env.BROADCAST_PORT || 8060);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

async function espn(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'broadcast-sim/0.1' } });
  if (!res.ok) throw new Error(`ESPN ${res.status} for ${url}`);
  return res.json();
}

export async function loadGame(id, { fresh = false } = {}) {
  const file = path.join(GAMES, `${id}.json`);
  let cached = null;
  try { cached = JSON.parse(await fs.readFile(file, 'utf8')); } catch {}
  if (cached && cached.status.state === 'post' && !fresh) return cached;
  try {
    const game = normalizeSummary(await espn(`${ESPN.summary}?event=${encodeURIComponent(id)}`));
    if (game.plays.length || game.status.state !== 'pre') {
      await fs.mkdir(GAMES, { recursive: true });
      await fs.writeFile(file, JSON.stringify(game));
    }
    return game;
  } catch (err) {
    if (cached) return { ...cached, stale: String(err.message || err) };
    throw err;
  }
}

export function asLive(g, asof) {
  const plays = g.plays.filter(p => p.wallclock != null && p.wallclock <= asof);
  const last = plays.at(-1);
  const done = plays.length === g.plays.length;
  return {
    ...g,
    plays,
    home: { ...g.home, score: last?.homeScore ?? 0 },
    away: { ...g.away, score: last?.awayScore ?? 0 },
    status: { ...g.status, state: done ? 'post' : plays.length ? 'in' : 'pre', detail: done ? g.status.detail : last ? `Q${last.period} ${last.clock}` : 'Pregame' },
    firstWallclock: g.plays.find(p => p.wallclock)?.wallclock ?? null,
  };
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/scoreboard') {
      const q = new URLSearchParams();
      for (const k of ['week', 'year', 'seasontype', 'dates']) if (url.searchParams.get(k)) q.set(k, url.searchParams.get(k));
      return send(res, 200, normalizeScoreboard(await espn(`${ESPN.scoreboard}?${q}`)));
    }
    const m = url.pathname.match(/^\/api\/game\/(\d+)$/);
    if (m && url.searchParams.has('asof')) {
      // a finished game served as if it were live at a moment in its past:
      // only the plays stamped before `asof` exist yet
      return send(res, 200, asLive(await loadGame(m[1]), Number(url.searchParams.get('asof'))));
    }
    if (m) return send(res, 200, await loadGame(m[1], { fresh: url.searchParams.has('fresh') }));
    if (url.pathname === '/api/saved') {
      const files = (await fs.readdir(GAMES).catch(() => [])).filter(f => f.endsWith('.json'));
      const list = [];
      for (const f of files) {
        try {
          const g = JSON.parse(await fs.readFile(path.join(GAMES, f), 'utf8'));
          list.push({ id: g.id, name: g.name, date: g.date, state: g.status.state, home: g.home, away: g.away, plays: g.plays.length });
        } catch {}
      }
      list.sort((a, b) => String(b.date).localeCompare(String(a.date)));
      return send(res, 200, list);
    }

    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT)) return send(res, 403, 'forbidden', 'text/plain');
    const body = await fs.readFile(file);
    send(res, 200, body, TYPES[path.extname(file)] || 'application/octet-stream');
  } catch (err) {
    if (err.code === 'ENOENT') return send(res, 404, 'not found', 'text/plain');
    console.error(err);
    send(res, 502, { error: String(err.message || err) });
  }
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(PORT, () => console.log(`broadcast-sim on http://localhost:${PORT}`));
}
