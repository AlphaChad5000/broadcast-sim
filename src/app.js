// Wires the feed, the director, the broadcast and the graphics together.
//
//   ?game=<espn id>     which game (default: a live one, else the latest final)
//   ?pace=condensed|realtime|live
//   ?play=<n>           start at play n
//   ?cam=broadcast|all22|sky|free
//   ?auto=1             skip the Tune in card (no sound until a click)
//   ?aslive=N           replay a finished game AS IF LIVE, its feed revealed
//                       N times faster than it happened (tests the live path)

import { Director } from './director.js';
import { Broadcast } from './render/scene.js';
import { Sound } from './audio.js';
import { readable, lastName } from './football/call.js';

const $ = s => document.querySelector(s);
const params = new URLSearchParams(location.search);
const POLL_LIVE_MS = 6000;
const POLL_PRE_MS = 30000;

const state = { game: null, director: null, broadcast: null, paused: false, last: performance.now(), lastIdx: -1, lastLt: 0, excitement: 0, week: null };
const sound = new Sound();
window.__sim = state; // for poking at from the console

// --------------------------------------------------------------- data ---

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

async function chooseDefault() {
  const sb = await getJSON('/api/scoreboard').catch(() => ({ games: [] }));
  const live = sb.games.find(g => g.state === 'in');
  if (live) return live.id;
  const finals = sb.games.filter(g => g.state === 'post').sort((a, b) => b.date.localeCompare(a.date));
  if (finals[0]) return finals[0].id;
  const saved = await getJSON('/api/saved').catch(() => []);
  return saved[0]?.id || sb.games[0]?.id;
}

// ------------------------------------------------------------- picker ---

function gameCard(g) {
  const el = document.createElement('button');
  el.className = 'game' + (g.state === 'in' ? ' live' : '');
  const when = g.state === 'pre' ? new Date(g.date).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : g.detail;
  el.innerHTML = `
    <div class="t"><span class="sw" style="background:${g.away.color}"></span>${g.away.abbr}</div><div class="s">${g.state === 'pre' ? '' : g.away.score}</div>
    <div class="t"><span class="sw" style="background:${g.home.color}"></span>${g.home.abbr}</div><div class="s">${g.state === 'pre' ? '' : g.home.score}</div>
    <div class="st">${g.state === 'in' ? '● LIVE · ' : ''}${when || ''}</div>`;
  el.onclick = () => go(g.id);
  return el;
}

async function openPicker(week) {
  $('#picker').classList.add('show');
  const q = week ? `?week=${week}` : '';
  const sb = await getJSON('/api/scoreboard' + q).catch(() => ({ games: [] }));
  state.week = sb.week;
  $('#wkLabel').textContent = sb.week ? `Week ${sb.week}` : 'This week';
  const box = $('#games');
  box.innerHTML = '';
  const order = { in: 0, post: 1, pre: 2 };
  sb.games.sort((a, b) => order[a.state] - order[b.state] || a.date.localeCompare(b.date)).forEach(g => box.appendChild(gameCard(g)));
  const saved = await getJSON('/api/saved').catch(() => []);
  const sv = $('#saved');
  sv.innerHTML = '';
  saved.slice(0, 24).forEach(g => sv.appendChild(gameCard({ ...g, detail: `${g.plays} plays`, state: g.state === 'in' ? 'post' : g.state })));
}

function go(id) {
  const p = new URLSearchParams(location.search);
  p.set('game', id);
  p.delete('play');
  location.search = p.toString();
}

// ---------------------------------------------------------------- boot ---

// ?aslive: the moment in the original game the fake feed has reached
const asLive = Number(params.get('aslive')) || 0;
let asLiveT0 = 0, asLiveBase = 0;
const asof = () => asLiveBase + (Date.now() - asLiveT0) * asLive;
function gameUrl(id, fresh) {
  if (asLive) return `/api/game/${id}?asof=${Math.round(asof())}`;
  return `/api/game/${id}${fresh ? '?fresh=1' : ''}`;
}

async function boot() {
  const id = params.get('game') || await chooseDefault();
  if (!id) { openPicker(); return; }
  if (asLive) {
    const full = await getJSON(`/api/game/${id}`);
    asLiveBase = (full.plays.find(p => p.wallclock)?.wallclock ?? Date.now()) - 60000;
    asLiveT0 = Date.now();
  }
  const game = await getJSON(gameUrl(id));
  state.game = game;
  document.title = `${game.away.abbr} @ ${game.home.abbr} · Broadcast Sim`;
  $('#title').textContent = `${game.away.full} at ${game.home.full}${game.venue ? ' · ' + game.venue : ''}`;
  const d = state.director = new Director(game);
  const b = state.broadcast = new Broadcast($('#stage'), game);
  b.setMode(params.get('cam') || 'broadcast');
  fitInset();
  for (const btn of document.querySelectorAll('[data-cam]')) btn.classList.toggle('on', btn.dataset.cam === b.mode);

  // pace: live games go live, everything else replays condensed
  const st = game.status.state;
  const pace = params.get('pace') || (st === 'post' ? 'condensed' : 'live');
  d.mode = pace;
  $('#pace').value = pace;
  let start = Number(params.get('play')) || 0;
  if (pace === 'live' && !params.get('play') && d.entries.length) {
    // join at the start of the drive in progress, then catch up
    const drive = game.plays.at(-1)?.driveId;
    const ids = new Set(game.plays.filter(p => p.driveId === drive).map(p => p.id));
    const k = d.entries.findIndex(e => ids.has(e.action.id));
    if (k >= 0) start = k;
  }
  d.seek(Math.min(start, Math.max(0, d.entries.length - 1)));
  buildFeed();
  setStatus();

  // the card that gets a click (browsers need one before sound)
  $('#tuneTitle').textContent = `${game.away.full} at ${game.home.full}`;
  $('#tuneSub').textContent = st === 'in' ? `Live · ${game.status.detail}` : st === 'pre' ? `Kickoff ${new Date(game.date).toLocaleString([], { weekday: 'long', hour: 'numeric', minute: '2-digit' })}` : `${game.status.detail} · ${game.away.abbr} ${game.away.score}, ${game.home.abbr} ${game.home.score} · ${d.entries.length} plays`;
  if (params.get('auto') === '1') state.paused = false;
  else {
    state.paused = true;
    $('#tunein').classList.add('show');
  }
  updatePlayButton();
  requestAnimationFrame(loop);
  if (st !== 'post') poll();
}

async function poll() {
  const g = state.game;
  const delay = asLive ? 2000 : g.status.state === 'pre' ? POLL_PRE_MS : POLL_LIVE_MS;
  setTimeout(async () => {
    try {
      const fresh = await getJSON(gameUrl(g.id, true));
      const wasEmpty = !state.director.entries.length;
      state.game = fresh;
      const added = state.director.update(fresh);
      if (wasEmpty && state.director.entries.length) state.director.seek(0);
      if (added) buildFeed();
      setStatus();
    } catch (err) {
      console.warn('poll failed', err);
    }
    if (state.game.status.state !== 'post') poll();
  }, delay);
}

function setStatus() {
  const s = $('#status');
  const st = state.game.status.state;
  const d = state.director;
  s.className = 'pill';
  if (st === 'pre') { s.textContent = 'PREGAME'; s.classList.add('wait'); }
  else if (d.mode === 'live') { s.textContent = st === 'in' ? 'LIVE' : 'FINAL'; if (st === 'in') s.classList.add('live'); }
  else s.textContent = d.mode === 'realtime' ? 'REPLAY · REAL TIME' : 'REPLAY';
}

// ---------------------------------------------------------------- feed ---

function buildFeed() {
  const d = state.director;
  const list = $('#feedList');
  list.innerHTML = '';
  let q = 0;
  d.entries.forEach((e, i) => {
    const a = e.action;
    if (a.period !== q) {
      q = a.period;
      const h = document.createElement('li');
      h.className = 'quarter';
      h.textContent = q > 4 ? 'OVERTIME' : `QUARTER ${q}`;
      list.appendChild(h);
    }
    const li = document.createElement('li');
    li.dataset.i = i;
    const stop = a.kind === 'stoppage' || a.kind === 'timeout';
    li.className = stop ? 'stop' : a.scoring || e.isTry ? 'score' : '';
    const meta = e.isTry ? 'TRY' : `${a.clock || ''} ${a.down ? '· ' + ['', '1st', '2nd', '3rd', '4th'][a.down] + ' & ' + a.distance : ''}`;
    li.innerHTML = `<div class="meta"><span>${meta}</span>${a.scoring ? `<span>${state.game.away.abbr} ${a.awayScore} · ${state.game.home.abbr} ${a.homeScore}</span>` : ''}</div>${escapeHtml(readable(e.isTry ? a.call : a.text))}`;
    li.onclick = () => { d.seek(i); state.lastIdx = -1; };
    list.appendChild(li);
  });
  $('#feedCount').textContent = `· ${d.entries.filter(e => !e.isTry).length}`;
}

function highlightFeed(i) {
  const list = $('#feedList');
  for (const li of list.querySelectorAll('li[data-i]')) {
    const k = +li.dataset.i;
    li.classList.toggle('now', k === i);
    li.classList.toggle('future', k > i);
  }
  const cur = list.querySelector(`li[data-i="${i}"]`);
  if (cur && !$('#feed').matches(':hover')) cur.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

const escapeHtml = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ------------------------------------------------------------ graphics ---

let bannerTimer = null;
function banner(big, small, color) {
  const b = $('#banner');
  b.querySelector('.b1').textContent = big;
  b.querySelector('.b2').textContent = small || '';
  b.style.setProperty('--bc', color || '#c8102e');
  b.classList.add('show');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => b.classList.remove('show'), 3200);
}

const teamOf = id => (id === state.game.home.id ? state.game.home : state.game.away);

function updateBug(s) {
  const g = state.game;
  const bug = $('#bug');
  for (const [side, team] of [['away', g.away], ['home', g.home]]) {
    const el = bug.querySelector('.' + side);
    el.style.setProperty('--tc', team.color);
    el.querySelector('.abbr').textContent = team.abbr;
    el.querySelector('.score').textContent = s ? s.score[side] : team.score;
    el.querySelector('.poss').classList.toggle('on', !!s && s.possession === team.id);
  }
  const q = s?.period ?? 0;
  bug.querySelector('.qtr').textContent = q ? (q > 4 ? 'OT' : ['1ST', '2ND', '3RD', '4TH'][q - 1]) : 'PRE';
  bug.querySelector('.time').textContent = s ? s.clock : '';
  const a = s?.action;
  bug.querySelector('.down').textContent = !a ? '' : a.kind === 'kickoff' ? 'KICKOFF' : a.kind === 'xp' ? 'PAT' : s.down || '';
}

function setCall(html) { $('#callText').innerHTML = html; }

// fires everything that happened in a clip between two instants
function fireEvents(s, from, to) {
  const clip = s.clip;
  if (!clip) return;
  for (const e of clip.events) {
    if (e.t <= from || e.t > to) continue;
    switch (e.type) {
      case 'snap': sound.thud(0.25); state.excitement = Math.max(state.excitement, 0.18); break;
      case 'tackle': sound.thud(1); break;
      case 'sack': sound.thud(1.2); state.excitement = 0.7; banner('SACK', sackLine(s), teamOf(s.action.defense).color); break;
      case 'kick': sound.kick(); state.excitement = Math.max(state.excitement, 0.35); break;
      case 'catch': if ((e.yards ?? 0) > 15) state.excitement = Math.max(state.excitement, 0.6); break;
      case 'incomplete': state.excitement = Math.max(state.excitement, 0.3); break;
      case 'td': state.excitement = 1; banner('TOUCHDOWN', teamOf(e.team).full.toUpperCase(), teamOf(e.team).color); break;
      case 'interception': state.excitement = 1; banner('INTERCEPTION', teamOf(e.team).full.toUpperCase(), teamOf(e.team).color); break;
      case 'fumble': state.excitement = Math.max(state.excitement, 0.8); break;
      case 'recover': if (e.team !== s.action.offense) banner('TURNOVER', `${teamOf(e.team).name.toUpperCase()} BALL`, teamOf(e.team).color); break;
      case 'good': if (e.kind === 'fg') { state.excitement = 0.8; banner('FIELD GOAL', 'IT IS GOOD', teamOf(s.action.offense).color); } else state.excitement = 0.4; break;
      case 'nogood': state.excitement = 0.6; banner(s.action.kind === 'xp' ? 'NO GOOD' : 'NO GOOD', 'MISSED KICK', '#444'); break;
      case 'blocked': state.excitement = 0.9; banner('BLOCKED', '', teamOf(s.action.defense).color); break;
      case 'flag': banner('FLAG', `${e.foul.toUpperCase()}${e.player ? ' · ' + lastName(e.player).toUpperCase() : ''}`, '#c9a400'); break;
    }
  }
  if (clip.whistle != null && clip.whistle > from && clip.whistle <= to) sound.whistle();
  for (const line of s.call) {
    if (line.t <= from || line.t > to) continue;
    setCall(escapeHtml(line.text));
    sound.say(line.text, line.big);
    if (line.big) state.excitement = Math.max(state.excitement, 0.75);
  }
}

function sackLine(s) {
  const l = s.action.legs.find(l => l.k === 'sack');
  return l?.tacklers?.[0] ? lastName(l.tacklers[0]).toUpperCase() : '';
}

// ---------------------------------------------------------------- loop ---

function loop(now) {
  const dt = Math.min(0.1, (now - state.last) / 1000);
  state.last = now;
  frame(dt);
  requestAnimationFrame(loop);
}

// Steps the show by hand (a hidden tab gets no animation frames):
// __sim.advance(5000) plays five seconds at 30 fps.
state.advance = (ms, step = 33) => { for (let t = 0; t < ms; t += step) frame(step / 1000); };

function frame(dt) {
  const d = state.director;
  if (!state.paused) d.tick(dt * 1000);
  const s = d.sample();
  if (s) {
    if (s.i !== state.lastIdx) {
      // a new entry is on screen
      state.lastIdx = s.i;
      state.lastLt = -1;
      highlightFeed(s.i);
      const a = s.action;
      if (a.kind === 'stoppage' || a.kind === 'timeout') {
        const label = a.kind === 'timeout' ? `TIMEOUT` : readable(a.text).replace(/\.$/, '').toUpperCase();
        banner(label, a.kind === 'timeout' ? teamOf(a.team).full.toUpperCase() : '', a.kind === 'timeout' ? teamOf(a.team).color : '#1d2a44');
        setCall(`<span class="official">${escapeHtml(readable(a.text))}</span>`);
        sound.say(readable(a.text));
      } else if (!s.clip) {
        setCall(`<span class="official">${escapeHtml(readable(a.text))}</span>`);
      }
    }
    if (s.clip && !state.paused) {
      fireEvents(s, state.lastLt, s.lt);
      // after the whistle, the line from the feed itself
      if (s.clip.whistle != null && state.lastLt < s.clip.whistle + 1.2 && s.lt >= s.clip.whistle + 1.2) {
        const cur = $('#callText').innerHTML;
        setCall(`${cur ? cur + '<br>' : ''}<span class="official">“${escapeHtml(readable(s.entry.isTry ? s.action.call : s.action.text))}”</span>`);
      }
    }
    state.lastLt = s.lt;
    if (s.waitingForFeed && d.mode === 'live') $('#status').textContent = state.game.status.state === 'post' ? 'FINAL' : 'LIVE · WAITING FOR THE NEXT PLAY';
  }
  state.excitement *= Math.exp(-dt * 0.45);
  sound.crowd(state.excitement);
  updateBug(s);
  state.broadcast.update(s, dt);
}

// ------------------------------------------------------------ controls ---

// keep the action centred in the part of the screen the feed does not cover
function fitInset() {
  const f = $('#feed');
  const open = !f.classList.contains('hidden') && getComputedStyle(f).display !== 'none';
  state.broadcast?.setInset(open ? f.offsetWidth + 12 : 0);
}

function updatePlayButton() { $('#play').innerHTML = state.paused ? '&#x25B6;' : '&#x23F8;'; }

function step(delta) {
  const d = state.director;
  let i = d.current() + delta;
  // skip stoppages when stepping
  while (i > 0 && i < d.entries.length - 1 && !d._hasClip(i)) i += Math.sign(delta);
  i = Math.max(0, Math.min(d.entries.length - 1, i));
  d.seek(i);
  state.lastIdx = -1;
  window.speechSynthesis?.cancel();
}

function wire() {
  $('#play').onclick = () => { state.paused = !state.paused; updatePlayButton(); };
  $('#prev').onclick = () => step(-1);
  $('#next').onclick = () => step(1);
  $('#pace').onchange = e => { state.director.setMode(e.target.value); setStatus(); };
  $('#speed').onchange = e => { state.director.speed = Number(e.target.value); };
  for (const btn of document.querySelectorAll('[data-cam]')) {
    btn.onclick = () => {
      state.broadcast.setMode(btn.dataset.cam);
      for (const b of document.querySelectorAll('[data-cam]')) b.classList.toggle('on', b === btn);
    };
  }
  $('#voice').onclick = e => { sound.voice = !sound.voice; e.target.classList.toggle('on', sound.voice); if (!sound.voice) window.speechSynthesis?.cancel(); };
  $('#mute').onclick = e => {
    if (!sound.ctx) sound.start(); else sound.setEnabled(!sound.enabled);
    e.target.classList.toggle('on', sound.enabled);
  };
  $('#feedBtn').onclick = e => {
    $('#feed').classList.toggle('hidden');
    const open = !$('#feed').classList.contains('hidden');
    e.target.classList.toggle('on', open);
    fitInset();
  };
  window.addEventListener('resize', fitInset);
  $('#gamesBtn').onclick = () => openPicker();
  $('#picker').onclick = e => { if (e.target.id === 'picker') $('#picker').classList.remove('show'); };
  $('#wkPrev').onclick = () => openPicker(Math.max(1, (state.week || 2) - 1));
  $('#wkNext').onclick = () => openPicker((state.week || 0) + 1);
  $('#goId').onclick = () => { const v = $('#gameId').value.trim(); if (v) go(v); };
  $('#tuneBtn').onclick = () => {
    sound.start();
    $('#mute').classList.add('on');
    $('#tunein').classList.remove('show');
    state.paused = false;
    updatePlayButton();
  };
  $('#tunePick').onclick = () => { $('#tunein').classList.remove('show'); openPicker(); };
  window.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.code === 'Space') { e.preventDefault(); $('#play').click(); }
    else if (e.code === 'ArrowLeft') step(-1);
    else if (e.code === 'ArrowRight') step(1);
    else if (e.key === 'v') $('#voice').click();
    else if (e.key === 'm') $('#mute').click();
    else if (e.key === 'f') $('#feedBtn').click();
    else if ('1234'.includes(e.key)) document.querySelectorAll('[data-cam]')[+e.key - 1].click();
  });
}

wire();
boot().catch(err => {
  console.error(err);
  setCall(`Could not load the game: ${escapeHtml(String(err.message || err))}`);
  openPicker();
});
