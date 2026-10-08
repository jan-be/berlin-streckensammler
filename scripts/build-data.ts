/**
 * Builds data/stations.json from VBB's GTFS timetables (CC BY 4.0).
 *
 *   curl -L -o gtfs.zip https://unternehmen.vbb.de/gtfs && unzip gtfs.zip -d gtfs
 *   curl -L -o gtfs-2024.zip https://unternehmen.vbb.de/fileadmin/user_upload/VBB/Dokumente/API-Datensaetze/gtfs-2024.zip
 *   unzip gtfs-2024.zip -d gtfs-2024
 *   bun scripts/build-data.ts gtfs [gtfs-2024 ...]
 *
 * A station is a named stop ("S+U Alexanderplatz Bhf", "U Alexanderplatz [Tram]"):
 * all the poles and platforms that share the name. Its modes and lines come from
 * the trips that actually stop there.
 *
 * Berlin only (stop IDs with the municipality code 11000), except the S-Bahn,
 * whose whole network counts (Potsdam, Erkner, BER airport, ...): a station
 * outside Berlin is an S-Bahn station only.
 *
 * The current feed covers about two months, so a line closed for construction
 * in that window would take its stations with it. Older feeds (VBB's yearly
 * archive) fill those in, for rail, tram and ferry only: a station must still
 * exist in today's stop list and a line must still run today. Buses come from
 * today's timetable alone; their routes change too often.
 */
import fs from 'fs';
import path from 'path';

const [current, ...archives] = process.argv.slice(2);
if (!current) throw new Error('usage: bun scripts/build-data.ts <current gtfs dir> [archive gtfs dirs]');
const out = path.join(import.meta.dir, '..', 'data', 'stations.json');

type Mode = 'S' | 'U' | 'T' | 'B' | 'R' | 'F';
const ORDER: Mode[] = ['S', 'U', 'R', 'T', 'B', 'F'];
const FROM_ARCHIVE = new Set<Mode>(['S', 'U', 'R', 'T', 'F']);

/** GTFS route_type (basic and extended) → our mode, or null for what we don't collect */
function modeOf(routeType: number): Mode | null {
  if (routeType === 109) return 'S';
  if (routeType === 400 || routeType === 1) return 'U';
  if (routeType === 900 || routeType === 0) return 'T';
  if (routeType === 3 || (routeType >= 700 && routeType < 800)) return 'B';
  if (routeType === 2 || (routeType >= 100 && routeType < 200)) return 'R';
  if (routeType === 4 || routeType === 1000 || routeType === 1200) return 'F';
  return null;
}

/**
 * Replacement services: buses standing in for a train or tram carry its name
 * ("S41", "U8", "RE1", "12"), Berlin's own bus lines never do
 */
const isReplacement = (mode: Mode, name: string) =>
  mode === 'B' && (/^(S|U|RE|RB|FEX|T)\d/i.test(name) || /^\d{1,2}$/.test(name) || /SEV|Ersatz/i.test(name));

/** One CSV line (GTFS: no line breaks inside fields) */
function parseLine(line: string): string[] {
  const out: string[] = [];
  let field = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') { if (line[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(field); field = ''; }
    else field += ch;
  }
  out.push(field.replace(/\r$/, ''));
  return out;
}

function readTable(dir: string, file: string): Record<string, string>[] {
  const lines = fs.readFileSync(path.join(dir, file), 'utf8').replace(/^﻿/, '').split('\n').filter(l => l.trim());
  const head = parseLine(lines[0]);
  return lines.slice(1).map(l => { const r = parseLine(l); return Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])); });
}

/** Stream a big table line by line */
async function eachRow(dir: string, file: string, fn: (row: string[], col: Record<string, number>) => void) {
  const stream = Bun.file(path.join(dir, file)).stream().pipeThrough(new TextDecoderStream());
  let rest = '', col: Record<string, number> | null = null;
  const handle = (l: string) => {
    if (!l.trim()) return;
    const r = parseLine(l);
    if (!col) { col = Object.fromEntries(r.map((h, i) => [h.replace(/^﻿/, ''), i])); return; }
    fn(r, col);
  };
  for await (const chunk of stream) {
    const lines = (rest + chunk).split('\n');
    rest = lines.pop()!;
    lines.forEach(handle);
  }
  handle(rest);
}

const inBerlin = (stopId: string) => stopId.startsWith('de:11000:');
const dhid = (stopId: string) => stopId.split(':').slice(0, 3).join(':');

type Feed = {
  stops: Map<string, { name: string; lat: number; lon: number; parent: string }>;
  /** stop name → mode → line names stopping there */
  served: Map<string, Map<Mode, Set<string>>>;
  /** line key "mode|name" → stop-name sequence (joined by \u0001) → trips */
  patterns: Map<string, Map<string, number>>;
};

/** Which named stops each line serves (a stop counts for a mode if it is in Berlin, or for the S-Bahn anywhere) */
async function loadFeed(dir: string): Promise<Feed> {
  const agencies = new Map(readTable(dir, 'agency.txt').map(a => [a.agency_id, a.agency_name]));
  const routes = new Map<string, { mode: Mode; name: string }>();
  for (const r of readTable(dir, 'routes.txt')) {
    const mode = modeOf(Number(r.route_type));
    if (!mode) continue;
    const name = (r.route_short_name || r.route_long_name).trim();
    // Route type 109 also covers the S-Bahn of Leipzig and Magdeburg
    if (mode === 'S' && !/S-Bahn Berlin/i.test(agencies.get(r.agency_id) ?? '')) continue;
    if (isReplacement(mode, name)) continue;
    routes.set(r.route_id, { mode, name });
  }
  const tripRoute = new Map<string, string>();
  for (const t of readTable(dir, 'trips.txt')) if (routes.has(t.route_id)) tripRoute.set(t.trip_id, t.route_id);
  const stops: Feed['stops'] = new Map();
  for (const s of readTable(dir, 'stops.txt')) stops.set(s.stop_id, { name: s.stop_name, lat: Number(s.stop_lat), lon: Number(s.stop_lon), parent: s.parent_station });

  const served: Feed['served'] = new Map();
  const patterns: Feed['patterns'] = new Map();
  let curTrip = '', cur: { seq: number; name: string }[] = [];
  const flush = () => {
    const rid = tripRoute.get(curTrip);
    if (rid && cur.length) {
      const r = routes.get(rid)!;
      cur.sort((a, b) => a.seq - b.seq);
      const names: string[] = [];
      for (const c of cur) if (names[names.length - 1] !== c.name) names.push(c.name);
      const key = `${r.mode}|${r.name}`;
      const m = patterns.get(key) ?? new Map<string, number>();
      const seq = names.join('\u0001');
      m.set(seq, (m.get(seq) ?? 0) + 1);
      patterns.set(key, m);
    }
    cur = [];
  };
  await eachRow(dir, 'stop_times.txt', (row, c) => {
    const trip = row[c.trip_id];
    if (trip !== curTrip) { flush(); curTrip = trip; }
    const rid = tripRoute.get(trip);
    if (!rid) return;
    // a stop where nobody may board or leave is passed, not visited
    if (row[c.pickup_type] === '1' && row[c.drop_off_type] === '1') return;
    const stopId = row[c.stop_id];
    const s = stops.get(stopId);
    if (!s) return;
    const r = routes.get(rid)!;
    if (!(inBerlin(stopId) || r.mode === 'S')) return;
    let byMode = served.get(s.name);
    if (!byMode) served.set(s.name, (byMode = new Map()));
    let names = byMode.get(r.mode);
    if (!names) byMode.set(r.mode, (names = new Set()));
    names.add(r.name);
    cur.push({ seq: Number(row[c.stop_sequence]), name: s.name });
  });
  flush();
  console.log(`${dir}: ${routes.size} routes, ${served.size} served stop names`);
  return { stops, served, patterns };
}

// ── load ───────────────────────────────────────────────────────────────────
const now = await loadFeed(current);
const old = [];
for (const a of archives) old.push(await loadFeed(a));

// today's stop names, with their poles' positions and IDs (the archive's own positions are ignored)
const today = new Map<string, { pts: { lat: number; lon: number }[]; ids: Map<string, number>; parents: Set<string> }>();
for (const [stopId, s] of now.stops) {
  let t = today.get(s.name);
  if (!t) today.set(s.name, (t = { pts: [], ids: new Map(), parents: new Set() }));
  if (s.lat && s.lon) t.pts.push({ lat: s.lat, lon: s.lon });
  const id = dhid(stopId);
  t.ids.set(id, (t.ids.get(id) ?? 0) + 1);
  if (s.parent) t.parents.add(s.parent);
}
const linesToday = new Set(now.patterns.keys());

// station name → mode → lines
const served = new Map<string, Map<Mode, Set<string>>>();
const add = (name: string, mode: Mode, line: string) => {
  let m = served.get(name);
  if (!m) served.set(name, (m = new Map()));
  let s = m.get(mode);
  if (!s) m.set(mode, (s = new Set()));
  s.add(line);
};
for (const [name, byMode] of now.served) for (const [mode, ls] of byMode) for (const l of ls) add(name, mode, l);
// Only where today's timetable has no service of that mode at all (a closure),
// not on top of it: old diversions (U2 trains over U3 tracks in 2025) would
// otherwise add stations to lines that never normally serve them
let filled = 0;
for (const f of old) {
  for (const [name, byMode] of f.served) {
    if (!today.has(name)) continue;
    for (const [mode, ls] of byMode) {
      if (!FROM_ARCHIVE.has(mode) || now.served.get(name)?.has(mode)) continue;
      for (const l of ls) {
        if (!linesToday.has(`${mode}|${l}`)) continue;
        filled++;
        add(name, mode, l);
      }
    }
  }
}
console.log(`archive filled in ${filled} station-line pairs`);

/**
 * Stations closed for longer than any archived timetable reaches back, which
 * still belong to the network (and were visited before). Each continues its
 * line from `after`; `note` is shown with the station.
 */
const CLOSED: { mode: Mode; line: string; after: string; names: string[]; note: string }[] = [
  {
    // closed since 7 Nov 2022 for rebuilding, reopening planned for Aug 2027
    mode: 'U', line: 'U6', after: 'U Kurt-Schumacher-Platz (Berlin)', note: 'U6 closed until 2027',
    names: ['U Scharnweberstr. (Berlin)', 'U Otisstraße (Berlin)', 'U Holzhauser Str. (Berlin)', 'U Borsigwerke (Berlin)', 'U Alt-Tegel (Berlin)'],
  },
];
const notes = new Map<string, string>(); // stop name → note
for (const c of CLOSED) {
  for (const name of c.names) {
    if (!today.has(name)) { console.warn(`  closed station not in today's stops: ${name}`); continue; }
    if (served.get(name)?.get(c.mode)?.has(c.line)) continue; // running again
    add(name, c.mode, c.line);
    notes.set(name, c.note);
  }
  // extend the line's patterns by the closed stretch
  const key = `${c.mode}|${c.line}`;
  const pats = now.patterns.get(key);
  if (!pats) continue;
  for (const [p, n] of [...pats]) {
    const seq = p.split('\u0001');
    const open = c.names.filter(nm => notes.has(nm));
    if (seq[seq.length - 1] === c.after) pats.set([...seq, ...open].join('\u0001'), n);
    else if (seq[0] === c.after) pats.set([...open.slice().reverse(), ...seq].join('\u0001'), n);
  }
}

// ── stations ───────────────────────────────────────────────────────────────
const distM = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const displayName = (name: string) =>
  name.replace(/\s*\(Berlin\)/g, '').replace(/^Berlin,\s*/, '').replace(/\s{2,}/g, ' ').trim();

type Station = { id: string; name: string; key: string; lat: number; lon: number; modes: Mode[]; note?: string };
const stations: Station[] = [];
const idOfName = new Map<string, string>();
const usedIds = new Set<string>();
for (const [name, byMode] of served) {
  const t = today.get(name);
  if (!t || !t.pts.length) continue;
  // a stable id: the parent station's, else the stop number most of its poles carry
  let id = [...t.parents].find(p => now.stops.get(p)?.name === name) ?? [...t.ids].sort((a, b) => b[1] - a[1])[0][0];
  id = dhid(id);
  if (usedIds.has(id)) { let k = 2; while (usedIds.has(`${id}~${k}`)) k++; id = `${id}~${k}`; }
  usedIds.add(id);
  idOfName.set(name, id);
  const lat = t.pts.reduce((s, p) => s + p.lat, 0) / t.pts.length;
  const lon = t.pts.reduce((s, p) => s + p.lon, 0) / t.pts.length;
  const spread = Math.max(...t.pts.map(p => distM(p, { lat, lon })));
  if (spread > 1500) console.warn(`  wide: ${name} spreads ${Math.round(spread)} m over ${t.pts.length} poles`);
  stations.push({ id, name: displayName(name), key: name, lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5, modes: ORDER.filter(m => byMode.has(m)), note: notes.get(name) });
}

// ── lines: stations in order (the longest pattern first, then what else they serve) ─
const COLORS: Record<string, string> = {
  U1: '#7DAD4C', U2: '#DA421E', U3: '#16683D', U4: '#F0D722', U5: '#7E5330', U6: '#8C6DAB', U7: '#528DBA', U8: '#224F86', U9: '#F3791D',
  S1: '#DC6BA6', S15: '#DC6BA6', S2: '#007734', S25: '#007734', S26: '#007734', S3: '#0066AD', S41: '#A23B1E', S42: '#C26A36',
  S45: '#C38737', S46: '#C38737', S47: '#C38737', S5: '#EB7405', S7: '#816DA6', S75: '#816DA6', S8: '#66AA22', S85: '#66AA22', S9: '#992746',
};
const MODE_COLOR: Record<Mode, string> = { S: '#008D4F', U: '#115D91', T: '#C6202B', B: '#95276E', R: '#E2001A', F: '#0098D4' };

type Line = { mode: Mode; name: string; color: string; main: string[]; more: string[] };
const lines: Line[] = [];
for (const key of linesToday) {
  const [mode, name] = key.split('|') as [Mode, string];
  const pats = new Map(now.patterns.get(key));
  if (FROM_ARCHIVE.has(mode)) for (const f of old) for (const [p, n] of f.patterns.get(key) ?? []) pats.set(p, (pats.get(p) ?? 0) + n);
  const seqs = [...pats].map(([p, n]) => {
    const ids: string[] = [];
    for (const stopName of p.split('\u0001')) {
      const id = idOfName.get(stopName);
      if (!id || !served.get(stopName)?.get(mode)?.has(name)) continue;
      if (ids[ids.length - 1] !== id) ids.push(id);
    }
    return { ids, n };
  }).filter(s => s.ids.length);
  if (!seqs.length) continue;
  // the line as it runs: the longest of its regular patterns; rare ones (a one-off
  // diversion, a depot run) only fill in what else it serves
  const busiest = Math.max(...seqs.map(s => s.n));
  const regular = (s: { n: number }) => s.n >= 0.1 * busiest;
  seqs.sort((a, b) => Number(regular(b)) - Number(regular(a)) || b.ids.length - a.ids.length || b.n - a.n);
  const main = seqs[0].ids;
  const seen = new Set(main);
  const more: string[] = [];
  for (const s of seqs.slice(1)) for (const id of s.ids) if (!seen.has(id)) { seen.add(id); more.push(id); }
  lines.push({ mode, name, color: COLORS[name] ?? MODE_COLOR[mode], main, more });
}
lines.sort((a, b) => ORDER.indexOf(a.mode) - ORDER.indexOf(b.mode) || a.name.localeCompare(b.name, 'de', { numeric: true }));

// ── write ──────────────────────────────────────────────────────────────────
stations.sort((a, b) => a.name.localeCompare(b.name, 'de'));
const index = new Map(stations.map((s, i) => [s.id, i]));
const feedDate = fs.statSync(path.join(current, 'stops.txt')).mtime.toISOString().slice(0, 10);
const data = {
  source: 'VBB Verkehrsverbund Berlin-Brandenburg GmbH, GTFS, CC BY 4.0',
  feedDate,
  // [id, name, lat, lon, modes, note?]
  stations: stations.map(s => (s.note ? [s.id, s.name, s.lat, s.lon, s.modes.join(''), s.note] : [s.id, s.name, s.lat, s.lon, s.modes.join('')])),
  // [mode, name, color, stations in order, other stations it serves]
  lines: lines.map(l => [l.mode, l.name, l.color, l.main.map(id => index.get(id)), l.more.map(id => index.get(id))]),
};
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(data));

const count = (m: Mode) => stations.filter(s => s.modes.includes(m)).length;
console.log(`stations ${stations.length}: ` + ORDER.map(m => `${m} ${count(m)}`).join(', '));
console.log(`lines ${lines.length}: ` + ORDER.map(m => `${m} ${lines.filter(l => l.mode === m).length}`).join(', '));
console.log(`wrote ${out} (${Math.round(fs.statSync(out).size / 1024)} KB)`);
