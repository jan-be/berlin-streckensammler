import { describe, expect, test } from 'bun:test';
import raw from '../../data/stations.json';
import { decode, normalize, search, nearest } from './data';

const net = decode(raw as any);
const names = (q: string, mode: any = null) => search(net.stations, q, mode, 5).map(s => s.name);

describe('normalize', () => {
  test('umlauts typed either way match', () => {
    expect(normalize('Schönhauser Allee')).toBe(normalize('Schoenhauser Allee'));
    expect(normalize('Görlitzer Bahnhof')).toBe(normalize('goerlitzer bahnhof'));
  });
  test('Straße, Strasse and Str. are the same', () => {
    expect(normalize('Warschauer Straße')).toBe(normalize('Warschauer Str.'));
    expect(normalize('Warschauer Strasse')).toBe(normalize('Warschauer Str.'));
  });
  test('prefixes and Bhf are dropped', () => {
    expect(normalize('S+U Alexanderplatz Bhf')).toBe('alexanderplatz');
    expect(normalize('U Kottbusser Tor')).toBe('kottbusser tor');
  });
});

describe('search', () => {
  test('the interchange comes first', () => {
    expect(names('alexanderplatz')[0]).toBe('S+U Alexanderplatz Bhf');
    expect(names('warschauer str')[0]).toBe('S+U Warschauer Str.');
  });
  test('word starts in any order', () => {
    expect(names('kotti')).toEqual([]); // not a prefix of a word
    expect(names('kott tor')[0]).toBe('U Kottbusser Tor');
  });
  test('restricted to a mode', () => {
    for (const s of search(net.stations, 'hermannstr', 'U', 10)) expect(s.modes).toContain('U');
  });
});

describe('data', () => {
  test('the networks are complete', () => {
    expect(net.count.U).toBe(175);
    expect(net.count.S).toBe(168);
    expect(net.linesByMode.U.map(l => l.name)).toEqual(['U1', 'U2', 'U3', 'U4', 'U5', 'U6', 'U7', 'U8', 'U9']);
  });
  test('a station knows its lines', () => {
    const alex = net.stations.find(s => s.name === 'S+U Alexanderplatz Bhf')!;
    expect(alex.lines.U!.map(l => l.name).sort()).toEqual(['U2', 'U5', 'U8']);
  });
  test('a line passing a station twice lists and counts it once', () => {
    const fr = net.stations.find(s => s.name === 'S+U Friedrichstr. Bhf')!;
    const bus = fr.lines.B!.map(l => l.name);
    expect(bus.length).toBe(new Set(bus).size);
    for (const l of net.lines) expect(l.all.length).toBe(new Set(l.all).size);
  });
  test('nearest to the TV tower is Alexanderplatz', () => {
    expect(nearest(net.stations, { lat: 52.5208, lon: 13.4094 }, 'U', 1)[0].s.name).toMatch(/Alexanderplatz/);
  });
});
