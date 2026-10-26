// The feed: ESPN's game summary reduced to what the simulator reads.
//
// ESPN's public "summary" endpoint carries, for every snap, the line a
// play-by-play announcer reads ("P.Mahomes pass short right to K.Walker to
// KC 33 for 6 yards (D.Lawrence).") plus a little structure around it (down,
// distance, spot, wallclock). The DESCRIPTION is what drives the simulation
// (src/football/parse.js); the structure is only used to check it and to
// fill in what the words leave out.
//
// Pure, no DOM, no fetch: the server normalizes before caching and the
// browser reads the result, so both see the same shape.

export const ESPN = {
  scoreboard: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard',
  summary: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary',
};

function team(c) {
  const t = c.team || {};
  return {
    id: String(t.id ?? c.id),
    abbr: t.abbreviation || '???',
    name: t.shortDisplayName || t.nickname || t.name || t.abbreviation,
    full: t.displayName || t.name,
    location: t.location || '',
    color: '#' + (t.color || '555555'),
    alt: '#' + (t.alternateColor || 'dddddd'),
    logo: t.logos?.[0]?.href || t.logo || null,
    score: Number(c.score ?? 0),
    record: c.record?.[0]?.displayValue || c.records?.[0]?.summary || '',
  };
}

function spot(s) {
  if (!s) return null;
  return {
    teamId: s.team?.id != null ? String(s.team.id) : null,
    yardLine: Number.isFinite(s.yardLine) ? s.yardLine : null,
    down: s.down ?? 0,
    distance: s.distance ?? 0,
    text: s.possessionText || '',
    ddText: s.downDistanceText || '',
  };
}

// "P.Mahomes" -> { jersey, team, pos } from the boxscore. Only players who
// recorded a stat are listed, which covers everyone a description names
// except the odd lineman flagged for a penalty.
function roster(box) {
  const out = {};
  for (const side of box?.players || []) {
    const teamId = String(side.team?.id);
    for (const cat of side.statistics || []) {
      for (const a of cat.athletes || []) {
        const ath = a.athlete || {};
        if (!ath.lastName && !ath.displayName) continue;
        const first = ath.firstName || ath.displayName.split(' ')[0];
        const last = ath.lastName || ath.displayName.split(' ').slice(1).join(' ');
        const key = `${first[0]}.${last}`;
        const entry = out[key] || (out[key] = { teamId, jersey: ath.jersey || '', name: ath.displayName, cats: [] });
        if (!entry.cats.includes(cat.name)) entry.cats.push(cat.name);
      }
    }
  }
  return out;
}

export function normalizeSummary(raw) {
  const header = raw.header || {};
  const comp = header.competitions?.[0] || {};
  const cs = comp.competitors || [];
  const home = team(cs.find(c => c.homeAway === 'home') || cs[0] || {});
  const away = team(cs.find(c => c.homeAway === 'away') || cs[1] || {});
  const st = comp.status || {};

  const plays = [];
  const seen = new Set();
  const drives = [...(raw.drives?.previous || [])];
  if (raw.drives?.current) drives.push(raw.drives.current);
  for (const d of drives) {
    for (const p of d.plays || []) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      plays.push({
        id: String(p.id),
        seq: Number(p.sequenceNumber) || 0,
        type: p.type?.text || '',
        text: (p.text || '').replace(/\s+/g, ' ').trim(),
        period: p.period?.number || 1,
        clock: p.clock?.displayValue || '',
        wallclock: p.wallclock ? Date.parse(p.wallclock) : null,
        start: spot(p.start),
        end: spot(p.end),
        homeScore: p.homeScore ?? 0,
        awayScore: p.awayScore ?? 0,
        scoring: !!p.scoringPlay,
        penalty: !!p.isPenalty,
        turnover: !!p.isTurnover,
        yards: p.statYardage ?? 0,
        driveId: String(d.id),
        driveTeam: d.team?.id != null ? String(d.team.id) : null,
      });
    }
  }
  plays.sort((a, b) => a.seq - b.seq || (a.wallclock ?? 0) - (b.wallclock ?? 0));

  return {
    id: String(header.id || ''),
    name: `${away.full} at ${home.full}`,
    week: header.week ?? null,
    season: header.season?.year ?? null,
    date: comp.date || null,
    venue: raw.gameInfo?.venue?.fullName || '',
    status: {
      state: st.type?.state || 'pre', // pre | in | post
      detail: st.type?.detail || st.type?.shortDetail || '',
      period: st.period ?? 0,
      clock: st.displayClock || '',
      possession: cs.find(c => c.possession)?.id ?? null,
    },
    home, away,
    roster: roster(raw.boxscore),
    plays,
    fetchedAt: Date.now(),
  };
}

export function normalizeScoreboard(raw) {
  return {
    week: raw.week?.number ?? null,
    season: raw.season?.year ?? null,
    seasonType: raw.season?.type ?? null,
    games: (raw.events || []).map(e => {
      const comp = e.competitions?.[0] || {};
      const cs = comp.competitors || [];
      const home = team(cs.find(c => c.homeAway === 'home') || {});
      const away = team(cs.find(c => c.homeAway === 'away') || {});
      return {
        id: String(e.id),
        name: e.name,
        short: e.shortName,
        date: e.date,
        state: e.status?.type?.state || 'pre',
        detail: e.status?.type?.shortDetail || e.status?.type?.detail || '',
        home, away,
      };
    }),
  };
}
