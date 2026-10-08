import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openDb, cleanName } from './db';

describe('names', () => {
  test('are trimmed and checked', () => {
    expect(cleanName('  Jan   B. ')).toBe('Jan B.');
    expect(cleanName('Zoë')).toBe('Zoë');
    expect(cleanName('x')).toBeNull();
    expect(cleanName('<script>')).toBeNull();
    expect(cleanName('a'.repeat(31))).toBeNull();
  });
  test('are unique regardless of case and accents', () => {
    const s = openDb(':memory:');
    const a = s.createUser(), b = s.createUser();
    expect(s.setName(a.id, 'Zoë')).toBe(true);
    expect(s.nameFree('zoe')).toBe(false);
    expect(s.nameFree('zoe', a.id)).toBe(true); // its own name
    expect(s.setName(b.id, 'ZOE')).toBe(false);
  });
});

describe('store', () => {
  test('visits are kept per station and mode', () => {
    const s = openDb(':memory:');
    const u = s.createUser();
    const token = s.createSession(u.id);
    expect(s.userForToken(token)?.id).toBe(u.id);
    s.setVisit(u.id, 'a', 'U', '2026-10-01');
    s.setVisit(u.id, 'a', 'S', '2026-10-02');
    s.setVisit(u.id, 'a', 'U', '2026-10-03'); // same pair again: new date
    expect(s.visits(u.id)).toEqual([
      { station: 'a', mode: 'U', date: '2026-10-03' },
      { station: 'a', mode: 'S', date: '2026-10-02' },
    ]);
    s.deleteVisit(u.id, 'a', 'S');
    expect(s.visits(u.id).length).toBe(1);
  });

  test('merging keeps the earlier date and removes the anonymous user', () => {
    const s = openDb(':memory:');
    const account = s.createUser(), anon = s.createUser();
    const anonToken = s.createSession(anon.id);
    s.setVisit(account.id, 'a', 'U', '2026-09-01');
    s.setVisit(anon.id, 'a', 'U', '2026-10-01');
    s.setVisit(anon.id, 'b', 'S', '2026-10-02');
    s.mergeInto(anon.id, account.id);
    expect(s.visits(account.id).sort((x, y) => x.station.localeCompare(y.station))).toEqual([
      { station: 'a', mode: 'U', date: '2026-09-01' },
      { station: 'b', mode: 'S', date: '2026-10-02' },
    ]);
    expect(s.userForToken(anonToken)).toBeNull();
  });

  test('the user handle is made once', () => {
    const s = openDb(':memory:');
    const u = s.createUser();
    const h = s.handle(u.id, 'first');
    expect(h).toBe('first');
    expect(s.handle(u.id)).toBe('first');
  });

  test('passkeys: the last one stays', () => {
    const s = openDb(':memory:');
    const u = s.createUser();
    s.addPasskey(u.id, { id: 'k1', publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ['internal'], backedUp: true });
    expect(s.removePasskey(u.id, 'k1')).toBe(false);
    s.addPasskey(u.id, { id: 'k2', publicKey: new Uint8Array([4]), counter: 0, backedUp: false });
    expect(s.passkey('k1')!.publicKey).toEqual(new Uint8Array([1, 2, 3]));
    expect(s.passkey('k1')!.transports).toEqual(['internal']);
    s.usePasskey('k2', 7);
    expect(s.passkey('k2')!.counter).toBe(7);
    expect(s.removePasskey(u.id, 'k1')).toBe(true);
    expect(s.passkeys(u.id).map(p => p.id)).toEqual(['k2']);
  });

  test('deleting the user deletes visits, sessions and passkeys', () => {
    const s = openDb(':memory:');
    const u = s.createUser();
    const token = s.createSession(u.id);
    s.setVisit(u.id, 'a', 'U', '2026-10-01');
    s.addPasskey(u.id, { id: 'k', publicKey: new Uint8Array([1]), counter: 0, backedUp: false });
    s.deleteUser(u.id);
    expect(s.userForToken(token)).toBeNull();
    expect(s.visits(u.id)).toEqual([]);
    expect(s.passkey('k')).toBeNull();
  });
});

describe('migration from the sync-code schema', () => {
  test('keeps users, sessions and visits; drops the codes', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ss-')), 'old.db');
    const old = new Database(path, { create: true });
    old.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), seen_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE visits (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, station TEXT NOT NULL, mode TEXT NOT NULL,
        visited_on TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (user_id, station, mode)) WITHOUT ROWID;
      INSERT INTO users (id, code) VALUES (7, 'AAAA-BBBB-CCCC-DDDD');
      INSERT INTO sessions (token_hash, user_id) VALUES ('h', 7);
      INSERT INTO visits (user_id, station, mode, visited_on) VALUES (7, 'x', 'U', '2026-10-08');
    `);
    old.close();
    const s = openDb(path);
    expect(s.user(7)).toEqual({ id: 7, name: null, handle: null });
    expect(s.visits(7)).toEqual([{ station: 'x', mode: 'U', date: '2026-10-08' }]);
    const cols = (s.db.query('PRAGMA table_info(users)').all() as { name: string }[]).map(c => c.name);
    expect(cols).not.toContain('code');
    expect((s.db.query('SELECT count(*) AS n FROM sessions').get() as { n: number }).n).toBe(1);
    s.db.close();
    // opening again changes nothing
    const again = openDb(path);
    expect(again.visits(7).length).toBe(1);
  });
});
