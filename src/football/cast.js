// Who is who on the field.
//
// Each team has eleven bodies on the field at a time. A description names a
// handful of them; the cast decides which body a name belongs to and keeps
// that choice, so the receiver who caught the last ball lines up in the same
// spot on the next snap and the linebacker who keeps making tackles stays
// the same linebacker.
//
// Slots are indices 0..10 within a team. What a slot plays depends on the
// unit on the field:
//
//   offense  LT LG C RG RT QB RB TE WR1 WR2 WR3
//   defense  DE DT DT DE LB LB LB CB CB S S
//   kicking  K  + coverage / punt team (punter, snapper, gunners)
//   return   R  + blockers

export const OFF = ['LT', 'LG', 'C', 'RG', 'RT', 'QB', 'RB', 'TE', 'WR1', 'WR2', 'WR3'];
export const DEF = ['DE1', 'DT1', 'DT2', 'DE2', 'LB1', 'LB2', 'LB3', 'CB1', 'CB2', 'S1', 'S2'];
export const S = Object.fromEntries([...OFF.map((r, i) => [r, i]), ...DEF.map((r, i) => [r, i])]);

// Preference lists: which slots a named player is tried in, best first.
export const PREF = {
  passer: [S.QB],
  rusher: [S.RB, S.WR3, S.TE, S.WR1, S.WR2, S.QB],
  target: [S.WR1, S.WR2, S.WR3, S.TE, S.RB],
  line: [S.DE1, S.DE2, S.DT1, S.DT2, S.LB1, S.LB2, S.LB3],
  box: [S.LB2, S.LB1, S.LB3, S.DE1, S.DE2, S.DT1, S.DT2, S.S1, S.S2],
  deep: [S.S1, S.S2, S.CB1, S.CB2, S.LB1, S.LB3, S.LB2],
  cover: [S.CB1, S.CB2, S.S1, S.S2, S.LB1, S.LB3],
  kicker: [5],
  returner: [5, 6],
  any: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
};

// Generic numbers for bodies nobody has named yet, by slot.
const OFF_NUM = [71, 65, 60, 66, 76, 12, 26, 87, 11, 13, 17];
const DEF_NUM = [91, 97, 95, 99, 54, 50, 56, 24, 21, 31, 37];

export class Cast {
  constructor(ctx) {
    this.ctx = ctx;
    this.units = new Map(); // `${teamId}:${unit}` -> Map(name -> slot)
    this.clock = 0;
    this.lastUsed = new Map(); // `${key}:${slot}` -> clock
  }

  _map(teamId, unit) {
    const k = `${teamId}:${unit}`;
    if (!this.units.has(k)) this.units.set(k, new Map());
    return this.units.get(k);
  }

  // Assigns every named player in `wants` (name, team, unit, pref) to a slot.
  // Names already cast keep their slot unless two collide in one play.
  assign(wants) {
    this.clock++;
    const taken = new Map(); // `${team}:${slot}` -> name
    const out = new Map();
    const key = w => `${w.team}:${w.unit}`;
    const place = (w, slot) => {
      taken.set(`${w.team}:${slot}`, w.name);
      out.set(`${w.team}|${w.name}`, slot);
      const m = this._map(w.team, w.unit);
      for (const [n, s] of m) if (s === slot && n !== w.name) m.delete(n);
      m.set(w.name, slot);
      this.lastUsed.set(`${key(w)}:${slot}`, this.clock);
    };
    // first pass: names that already have a slot in this unit
    const rest = [];
    for (const w of wants) {
      if (!w.name || out.has(`${w.team}|${w.name}`)) continue;
      const s = this._map(w.team, w.unit).get(w.name);
      // `keep` narrows where an old slot still counts: a receiver keeps his
      // spot only if it is on the side the ball is going.
      if (s != null && !taken.has(`${w.team}:${s}`) && w.pref.slice(0, w.keep ?? w.pref.length).includes(s)) place(w, s);
      else rest.push(w);
    }
    // second pass: new names take the first free preferred slot
    for (const w of rest) {
      if (out.has(`${w.team}|${w.name}`)) continue;
      const free = w.pref.filter(s => !taken.has(`${w.team}:${s}`));
      const pool = free.length ? free : PREF.any.filter(s => !taken.has(`${w.team}:${s}`));
      if (!pool.length) continue;
      // the first free preference: where he lines up matters more than
      // keeping whoever had that spot before
      place(w, pool[0]);
    }
    return out;
  }

  // Name and number for a slot, if the unit has someone cast there.
  who(teamId, unit, slot) {
    const m = this._map(teamId, unit);
    for (const [n, s] of m) if (s === slot) {
      const r = this.ctx.roster[n];
      return { name: n, jersey: r?.jersey || '' };
    }
    return null;
  }

  number(teamId, unit, slot) {
    const w = this.who(teamId, unit, slot);
    if (w?.jersey) return w.jersey;
    return String((unit === 'def' || unit === 'ret' ? DEF_NUM : OFF_NUM)[slot]);
  }
}
