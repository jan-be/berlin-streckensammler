/** The station file (scripts/build-data.ts) decoded into objects the app works with */
export type Mode = 'S' | 'U' | 'R' | 'T' | 'B' | 'F';
export const MODES: Mode[] = ['S', 'U', 'R', 'T', 'B', 'F'];

export type Station = {
  id: string;
  name: string;
  lat: number;
  lon: number;
  modes: Mode[];
  note?: string;
  /** search form of the name (see normalize) */
  key: string;
  /** lines per mode, filled from the lines */
  lines: Partial<Record<Mode, Line[]>>;
};

export type Line = {
  id: string; // "U|U8"
  mode: Mode;
  name: string;
  color: string;
  /** stations in order along the line */
  main: Station[];
  /** other stations it serves (branches, short workings) */
  more: Station[];
};

export type Network = {
  feedDate: string;
  source: string;
  stations: Station[];
  byId: Map<string, Station>;
  lines: Line[];
  linesByMode: Record<Mode, Line[]>;
  /** stations per mode */
  count: Record<Mode, number>;
};

type Raw = {
  feedDate: string;
  source: string;
  stations: [string, string, number, number, string, string?][];
  lines: [Mode, string, string, number[], number[]][];
};

export function decode(raw: Raw): Network {
  const stations: Station[] = raw.stations.map(([id, name, lat, lon, modes, note]) => ({
    id, name, lat, lon, note, modes: modes.split('') as Mode[], key: normalize(name), lines: {},
  }));
  const lines: Line[] = raw.lines.map(([mode, name, color, main, more]) => ({
    id: `${mode}|${name}`, mode, name, color, main: main.map(i => stations[i]), more: more.map(i => stations[i]),
  }));
  for (const l of lines) for (const s of [...l.main, ...l.more]) (s.lines[l.mode] ??= []).push(l);
  const linesByMode = Object.fromEntries(MODES.map(m => [m, lines.filter(l => l.mode === m)])) as Record<Mode, Line[]>;
  const count = Object.fromEntries(MODES.map(m => [m, stations.filter(s => s.modes.includes(m)).length])) as Record<Mode, number>;
  return { feedDate: raw.feedDate, source: raw.source, stations, byId: new Map(stations.map(s => [s.id, s])), lines, linesByMode, count };
}

/**
 * The form names are matched in: lower case, umlauts and ß spelled out the
 * same way whether typed as ä or ae, "Straße"/"Strasse"/"Str." alike, and the
 * S/U/S+U prefixes and "Bhf" left out (nobody types them).
 */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/ß/g, 'ss')
    .replace(/ae/g, 'a').replace(/oe/g, 'o').replace(/ue/g, 'u')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\bs\+u\b|^s\s|^u\s|\bbhf\b|\bbahnhof\b/g, ' ')
    .replace(/strasse\b|str\b\.?/g, 'str')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Stations matching what was typed, best first: every word typed must start a
 * word of the name (or appear in it); a name starting with the query wins, then
 * stations with more modes (big interchanges before the bus stop of the same name).
 */
export function search(stations: Station[], query: string, mode: Mode | null, limit = 40): Station[] {
  const q = normalize(query);
  if (!q) return [];
  const words = q.split(' ');
  const scored: { s: Station; score: number }[] = [];
  for (const s of stations) {
    if (mode && !s.modes.includes(mode)) continue;
    const nameWords = s.key.split(' ');
    let score = 0;
    let ok = true;
    for (const w of words) {
      if (nameWords.some(n => n === w)) score += 3;
      else if (nameWords.some(n => n.startsWith(w))) score += 2;
      else if (s.key.includes(w)) score += 1;
      else { ok = false; break; }
    }
    if (!ok) continue;
    if (s.key.startsWith(q)) score += 4;
    if (s.key === q) score += 4;
    score += s.modes.filter(m => m !== 'B').length * 0.5;
    scored.push({ s, score });
  }
  scored.sort((a, b) => b.score - a.score || a.s.name.length - b.s.name.length || a.s.name.localeCompare(b.s.name, 'de'));
  return scored.slice(0, limit).map(x => x.s);
}

/** Metres between two points (haversine) */
export function distance(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function nearest(stations: Station[], at: { lat: number; lon: number }, mode: Mode | null, limit = 20) {
  return stations
    .filter(s => !mode || s.modes.includes(mode))
    .map(s => ({ s, d: distance(at, s) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, limit);
}
