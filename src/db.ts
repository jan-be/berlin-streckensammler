/**
 * The app's only state: who collected which station in which mode, and when.
 *
 * There are no names, e-mail addresses or passwords. A visitor's first visit
 * creates an account identified by a random sync code (shown in the app, for
 * signing in on another device) and a session cookie for this browser.
 */
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'fs';
import { dirname, resolve } from 'path';

export type Mode = 'S' | 'U' | 'R' | 'T' | 'B' | 'F';
export const MODES: Mode[] = ['S', 'U', 'R', 'T', 'B', 'F'];
export type Visit = { station: string; mode: Mode; date: string };

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I: it gets typed in by hand

/** 16 characters from a 32-letter alphabet = 80 random bits, as XXXX-XXXX-XXXX-XXXX */
export function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const chars = [...bytes].map(b => CODE_ALPHABET[b % 32]);
  return [0, 4, 8, 12].map(i => chars.slice(i, i + 4).join('')).join('-');
}

/** What a person typed back into the canonical code: case, spaces and dashes don't matter */
export function normalizeCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length !== 16 || [...s].some(c => !CODE_ALPHABET.includes(c))) return null;
  return [0, 4, 8, 12].map(i => s.slice(i, i + 4)).join('-');
}

const sha256 = (s: string) => new Bun.CryptoHasher('sha256').update(s).digest('hex');

export function openDb(path: string) {
  if (path !== ':memory:') {
    try { mkdirSync(dirname(resolve(path)), { recursive: true }); } catch (e) { if ((e as { code?: string }).code !== 'EEXIST') throw e; }
  }
  const db = new Database(path, { create: true });
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id         INTEGER PRIMARY KEY,
      code       TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      seen_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS visits (
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      station    TEXT NOT NULL,
      mode       TEXT NOT NULL,
      visited_on TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, station, mode)
    ) WITHOUT ROWID;
  `);

  const q = {
    userBySession: db.query<{ id: number; code: string }, { $h: string }>(
      'SELECT u.id, u.code FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $h'),
    touchSession: db.query('UPDATE sessions SET seen_at = datetime(\'now\') WHERE token_hash = $h AND seen_at < datetime(\'now\', \'-1 day\')'),
    insertUser: db.query<{ id: number }, { $code: string }>('INSERT INTO users (code) VALUES ($code) RETURNING id'),
    userByCode: db.query<{ id: number }, { $code: string }>('SELECT id FROM users WHERE code = $code'),
    insertSession: db.query('INSERT INTO sessions (token_hash, user_id) VALUES ($h, $u)'),
    deleteSession: db.query('DELETE FROM sessions WHERE token_hash = $h'),
    visits: db.query<{ station: string; mode: Mode; date: string }, { $u: number }>(
      'SELECT station, mode, visited_on AS date FROM visits WHERE user_id = $u ORDER BY visited_on DESC, created_at DESC'),
    upsertVisit: db.query(`INSERT INTO visits (user_id, station, mode, visited_on) VALUES ($u, $s, $m, $d)
      ON CONFLICT (user_id, station, mode) DO UPDATE SET visited_on = excluded.visited_on`),
    deleteVisit: db.query('DELETE FROM visits WHERE user_id = $u AND station = $s AND mode = $m'),
    // the earlier date wins when two accounts are merged
    mergeVisits: db.query(`INSERT INTO visits (user_id, station, mode, visited_on, created_at)
      SELECT $to, station, mode, visited_on, created_at FROM visits WHERE user_id = $from
      ON CONFLICT (user_id, station, mode) DO UPDATE SET visited_on = min(visits.visited_on, excluded.visited_on)`),
    deleteUser: db.query('DELETE FROM users WHERE id = $u'),
    countVisits: db.query<{ n: number }, { $u: number }>('SELECT count(*) AS n FROM visits WHERE user_id = $u'),
  };

  return {
    db,
    /** The account behind a session token, or null */
    userForToken(token: string | null | undefined) {
      if (!token) return null;
      const h = sha256(token);
      const u = q.userBySession.get({ $h: h });
      if (u) q.touchSession.run({ $h: h });
      return u ?? null;
    },
    /** A new account and a session for it: returns the session token */
    createUser(): { id: number; code: string; token: string } {
      for (;;) {
        const code = newCode();
        try {
          const { id } = q.insertUser.get({ $code: code })!;
          return { id, code, token: this.createSession(id) };
        } catch (e) {
          if (!String(e).includes('UNIQUE')) throw e; // 2^80 codes: practically never
        }
      }
    },
    createSession(userId: number): string {
      const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
      q.insertSession.run({ $h: sha256(token), $u: userId });
      return token;
    },
    deleteSession(token: string) { q.deleteSession.run({ $h: sha256(token) }); },
    userByCode(code: string) { return q.userByCode.get({ $code: code }) ?? null; },
    visits(userId: number): Visit[] { return q.visits.all({ $u: userId }); },
    setVisit(userId: number, station: string, mode: Mode, date: string) { q.upsertVisit.run({ $u: userId, $s: station, $m: mode, $d: date }); },
    deleteVisit(userId: number, station: string, mode: Mode) { q.deleteVisit.run({ $u: userId, $s: station, $m: mode }); },
    /** Everything `from` collected goes to `to`, and `from` is gone (signing in on a device that already collected) */
    mergeInto(from: number, to: number) {
      if (from === to) return;
      db.transaction(() => {
        q.mergeVisits.run({ $from: from, $to: to });
        q.deleteUser.run({ $u: from });
      })();
    },
    deleteUser(userId: number) { q.deleteUser.run({ $u: userId }); },
    hasVisits(userId: number) { return q.countVisits.get({ $u: userId })!.n > 0; },
  };
}

export type Store = ReturnType<typeof openDb>;
