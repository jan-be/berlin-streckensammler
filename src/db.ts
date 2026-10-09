/**
 * The app's only state: who was at which station, in which mode, when, and
 * (optionally) what they did there. Every visit is its own entry; a station
 * counts as collected in a mode from its first.
 *
 * Collecting needs no account: the first station collected creates an
 * anonymous user with a session cookie for this browser. Creating an account
 * gives that user a name and a passkey; from then on the passkey signs in on
 * any device. Signing in on a device that collected anonymously moves its
 * stations into the account. There are no passwords and no e-mail addresses.
 */
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'fs';
import { dirname, resolve } from 'path';

export type Mode = 'S' | 'U' | 'R' | 'T' | 'B' | 'F';
export const MODES: Mode[] = ['S', 'U', 'R', 'T', 'B', 'F'];
/** One visit of a station in a mode: a journal entry */
export type Entry = { id: number; station: string; mode: Mode; date: string; note: string | null };
export const NOTE_MAX = 500;
export type User = { id: number; name: string | null; handle: string | null; passkeyId?: string | null };
export type Passkey = {
  id: string; userId: number; publicKey: Uint8Array; counter: number; transports: string[];
  backedUp: boolean; aaguid: string | null; createdAt: string; lastUsedAt: string | null;
};

export const NAME_MIN = 2, NAME_MAX = 30;

/** A display name as stored: trimmed, inner spaces collapsed; null if it isn't one */
export function cleanName(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const s = input.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (s.length < NAME_MIN || s.length > NAME_MAX) return null;
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._'-]*$/u.test(s)) return null;
  return s;
}
/** Names are unique regardless of case and accents */
const nameKey = (name: string) => name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const sha256 = (s: string) => new Bun.CryptoHasher('sha256').update(s).digest('hex');
const randomToken = (bytes = 32) => Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('base64url');
/** A WebAuthn user handle: 32 random bytes, base64url */
export const newHandle = () => randomToken(32);

/** Schema changes, in order; user_version counts how many have run */
const MIGRATIONS: string[] = [
  // 1: the first schema (accounts were a random sync code then)
  `CREATE TABLE IF NOT EXISTS users (
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
   ) WITHOUT ROWID;`,
  // 2: accounts with a name and passkeys; the sync codes go (their users stay, anonymous)
  `CREATE TABLE users_new (
     id         INTEGER PRIMARY KEY,
     name       TEXT,
     name_key   TEXT UNIQUE,
     handle     TEXT UNIQUE,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   INSERT INTO users_new (id, created_at) SELECT id, created_at FROM users;
   DROP TABLE users;
   ALTER TABLE users_new RENAME TO users;
   CREATE TABLE passkeys (
     id           TEXT PRIMARY KEY,
     user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     public_key   BLOB NOT NULL,
     counter      INTEGER NOT NULL DEFAULT 0,
     transports   TEXT NOT NULL DEFAULT '[]',
     backed_up    INTEGER NOT NULL DEFAULT 0,
     aaguid       TEXT,
     created_at   TEXT NOT NULL DEFAULT (datetime('now')),
     last_used_at TEXT
   );
   CREATE INDEX passkeys_user ON passkeys(user_id);
   -- which passkey signed this session in (shown as the current one)
   ALTER TABLE sessions ADD COLUMN passkey_id TEXT;`,
  // 3: a journal: any number of visits per station and mode, each with an optional note
  `CREATE TABLE entries (
     id         INTEGER PRIMARY KEY,
     user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     station    TEXT NOT NULL,
     mode       TEXT NOT NULL,
     visited_on TEXT NOT NULL,
     note       TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX entries_user ON entries(user_id, visited_on);
   INSERT INTO entries (user_id, station, mode, visited_on, created_at)
     SELECT user_id, station, mode, visited_on, created_at FROM visits ORDER BY visited_on, created_at;
   DROP TABLE visits;`,
];

function migrate(db: Database) {
  const version = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
  // a database from before user_version was kept already has the first schema
  const hasUsers = !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
  let from = version === 0 && hasUsers ? 1 : version;
  if (from >= MIGRATIONS.length) return;
  // Rebuilding a table that others reference: with foreign keys on, dropping
  // the old users table would cascade into sessions and visits
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    for (; from < MIGRATIONS.length; from++) {
      db.transaction(() => {
        db.exec(MIGRATIONS[from]);
        db.exec(`PRAGMA user_version = ${from + 1}`);
      })();
    }
    const broken = db.query('PRAGMA foreign_key_check').all();
    if (broken.length) throw new Error(`foreign keys broken after migrating: ${JSON.stringify(broken.slice(0, 3))}`);
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

export function openDb(path: string) {
  if (path !== ':memory:') {
    try { mkdirSync(dirname(resolve(path)), { recursive: true }); } catch (e) { if ((e as { code?: string }).code !== 'EEXIST') throw e; }
  }
  const db = new Database(path, { create: true });
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  migrate(db);
  db.exec('PRAGMA foreign_keys = ON;');

  const q = {
    userBySession: db.query<User, { $h: string }>(
      'SELECT u.id, u.name, u.handle, s.passkey_id AS passkeyId FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $h'),
    userById: db.query<User, { $u: number }>('SELECT id, name, handle FROM users WHERE id = $u'),
    touchSession: db.query("UPDATE sessions SET seen_at = datetime('now') WHERE token_hash = $h AND seen_at < datetime('now', '-1 day')"),
    insertUser: db.query<{ id: number }, []>('INSERT INTO users DEFAULT VALUES RETURNING id'),
    insertSession: db.query('INSERT INTO sessions (token_hash, user_id, passkey_id) VALUES ($h, $u, $p)'),
    deleteSession: db.query('DELETE FROM sessions WHERE token_hash = $h'),
    nameTaken: db.query<{ id: number }, { $k: string; $u: number }>('SELECT id FROM users WHERE name_key = $k AND id != $u'),
    setName: db.query('UPDATE users SET name = $n, name_key = $k WHERE id = $u'),
    setHandle: db.query('UPDATE users SET handle = $h WHERE id = $u AND handle IS NULL'),
    entries: db.query<Entry, { $u: number }>(
      'SELECT id, station, mode, visited_on AS date, note FROM entries WHERE user_id = $u ORDER BY visited_on DESC, id DESC'),
    entry: db.query<Entry, { $u: number; $id: number }>(
      'SELECT id, station, mode, visited_on AS date, note FROM entries WHERE user_id = $u AND id = $id'),
    addEntry: db.query<{ id: number }, { $u: number; $s: string; $m: string; $d: string; $n: string | null }>(
      'INSERT INTO entries (user_id, station, mode, visited_on, note) VALUES ($u, $s, $m, $d, $n) RETURNING id'),
    updateEntry: db.query('UPDATE entries SET visited_on = $d, note = $n WHERE user_id = $u AND id = $id'),
    deleteEntry: db.query('DELETE FROM entries WHERE user_id = $u AND id = $id'),
    mergeEntries: db.query('UPDATE entries SET user_id = $to WHERE user_id = $from'),
    deleteUser: db.query('DELETE FROM users WHERE id = $u'),
    countEntries: db.query<{ n: number }, { $u: number }>('SELECT count(*) AS n FROM entries WHERE user_id = $u'),
    passkey: db.query<Record<string, unknown>, { $id: string }>('SELECT * FROM passkeys WHERE id = $id'),
    passkeysOf: db.query<Record<string, unknown>, { $u: number }>('SELECT * FROM passkeys WHERE user_id = $u ORDER BY created_at'),
    insertPasskey: db.query(`INSERT INTO passkeys (id, user_id, public_key, counter, transports, backed_up, aaguid)
      VALUES ($id, $u, $pk, $c, $t, $b, $a)`),
    usePasskey: db.query("UPDATE passkeys SET counter = $c, last_used_at = datetime('now') WHERE id = $id"),
    deletePasskey: db.query('DELETE FROM passkeys WHERE id = $id AND user_id = $u'),
  };
  const toPasskey = (r: Record<string, unknown>): Passkey => ({
    id: r.id as string, userId: r.user_id as number, publicKey: new Uint8Array(r.public_key as Uint8Array),
    counter: r.counter as number, transports: JSON.parse(r.transports as string), backedUp: !!r.backed_up,
    aaguid: (r.aaguid as string | null) ?? null,
    createdAt: r.created_at as string, lastUsedAt: (r.last_used_at as string | null) ?? null,
  });

  return {
    db,
    /** The user behind a session token, or null */
    userForToken(token: string | null | undefined): User | null {
      if (!token) return null;
      const h = sha256(token);
      const u = q.userBySession.get({ $h: h });
      if (u) q.touchSession.run({ $h: h });
      return u ?? null;
    },
    user(id: number): User | null { return q.userById.get({ $u: id }) ?? null; },
    /** A new user without a name (collecting before any account) */
    createUser(): User {
      const { id } = q.insertUser.get()!;
      return { id, name: null, handle: null };
    },
    /** A session for the user; `passkeyId`: the passkey it was signed in with */
    createSession(userId: number, passkeyId: string | null = null): string {
      const token = randomToken();
      q.insertSession.run({ $h: sha256(token), $u: userId, $p: passkeyId });
      return token;
    },
    deleteSession(token: string) { q.deleteSession.run({ $h: sha256(token) }); },
    /** Is this name free (for this user)? */
    nameFree(name: string, userId = 0) { return !q.nameTaken.get({ $k: nameKey(name), $u: userId }); },
    /** Set the name; false if another account has it */
    setName(userId: number, name: string): boolean {
      try { q.setName.run({ $n: name, $k: nameKey(name), $u: userId }); return true; } catch (e) {
        if (String(e).includes('UNIQUE')) return false;
        throw e;
      }
    },
    /** The WebAuthn user handle (`fresh` or a new one on first use; it never changes after) */
    handle(userId: number, fresh = newHandle()): string {
      q.setHandle.run({ $h: fresh, $u: userId });
      return q.userById.get({ $u: userId })!.handle!;
    },
    /** The user's journal, newest first */
    entries(userId: number): Entry[] { return q.entries.all({ $u: userId }); },
    entry(userId: number, id: number): Entry | null { return q.entry.get({ $u: userId, $id: id }) ?? null; },
    /** Log a visit; returns its id */
    addEntry(userId: number, e: { station: string; mode: Mode; date: string; note?: string | null }): number {
      return q.addEntry.get({ $u: userId, $s: e.station, $m: e.mode, $d: e.date, $n: e.note || null })!.id;
    },
    /** Change a visit's date and note; false if it isn't the user's */
    updateEntry(userId: number, id: number, e: { date: string; note: string | null }): boolean {
      return q.updateEntry.run({ $u: userId, $id: id, $d: e.date, $n: e.note || null }).changes > 0;
    },
    deleteEntry(userId: number, id: number): boolean { return q.deleteEntry.run({ $u: userId, $id: id }).changes > 0; },
    /** Everything `from` logged goes to `to`, and `from` is gone */
    mergeInto(from: number, to: number) {
      if (from === to) return;
      db.transaction(() => {
        q.mergeEntries.run({ $from: from, $to: to });
        q.deleteUser.run({ $u: from });
      })();
    },
    deleteUser(userId: number) { q.deleteUser.run({ $u: userId }); },
    countEntries(userId: number) { return q.countEntries.get({ $u: userId })!.n; },
    passkey(id: string): Passkey | null { const r = q.passkey.get({ $id: id }); return r ? toPasskey(r) : null; },
    passkeys(userId: number): Passkey[] { return q.passkeysOf.all({ $u: userId }).map(toPasskey); },
    addPasskey(userId: number, p: { id: string; publicKey: Uint8Array; counter: number; transports?: string[]; backedUp: boolean; aaguid?: string }) {
      q.insertPasskey.run({ $id: p.id, $u: userId, $pk: p.publicKey, $c: p.counter, $t: JSON.stringify(p.transports ?? []), $b: p.backedUp ? 1 : 0, $a: p.aaguid ?? null });
    },
    usePasskey(id: string, counter: number) { q.usePasskey.run({ $id: id, $c: counter }); },
    /** Remove one of the user's passkeys; never the last (the account would be locked out) */
    removePasskey(userId: number, id: string): boolean {
      if (q.passkeysOf.all({ $u: userId }).length <= 1) return false;
      q.deletePasskey.run({ $id: id, $u: userId });
      return true;
    },
  };
}

export type Store = ReturnType<typeof openDb>;
