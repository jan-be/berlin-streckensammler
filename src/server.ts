/**
 * One Bun process serves everything: the React app (bundled by Bun from
 * index.html), the station data and a small JSON API over SQLite.
 */
import index from './index.html';
import stationsData from '../data/stations.json';
import { openDb, normalizeCode, MODES, type Mode, type Store } from './db';

const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH = process.env.DB_PATH ?? './local/app.db';
const PROD = process.env.NODE_ENV === 'production';
const COOKIE = 'ss_session';
const COOKIE_MAX_AGE = 400 * 24 * 3600; // the longest browsers keep a cookie

// ── station data: served as is, revalidated by its hash ────────────────────
const dataBody = JSON.stringify(stationsData);
const dataEtag = `"${new Bun.CryptoHasher('sha256').update(dataBody).digest('hex').slice(0, 16)}"`;
const stationIds = new Set((stationsData.stations as unknown[][]).map(s => s[0] as string));
const stationModes = new Map((stationsData.stations as unknown[][]).map(s => [s[0] as string, s[4] as string]));

// ── helpers ────────────────────────────────────────────────────────────────
const json = (body: unknown, init: ResponseInit = {}) =>
  Response.json(body, { ...init, headers: { 'Cache-Control': 'no-store', ...init.headers } });
const error = (status: number, message: string) => json({ error: message }, { status });

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}
const sessionCookie = (token: string) =>
  `${COOKIE}=${token}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax${PROD ? '; Secure' : ''}`;
const clearCookie = `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${PROD ? '; Secure' : ''}`;

/** A visit's date: what the phone says today is, else today in Berlin */
const berlinToday = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
const validDate = (d: unknown): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d));

/** Only JSON bodies: a form on another site cannot post here with the cookie */
async function body(req: Request): Promise<Record<string, unknown> | null> {
  if (!(req.headers.get('content-type') ?? '').includes('application/json')) return null;
  try { const b = await req.json(); return b && typeof b === 'object' ? b as Record<string, unknown> : null; } catch { return null; }
}

/** Sign-in attempts per address: the codes are unguessable, this just keeps the log quiet */
const attempts = new Map<string, { n: number; since: number }>();
function tooManyAttempts(req: Request, server: Bun.Server<unknown>): boolean {
  const ip = req.headers.get('cf-connecting-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? server.requestIP(req)?.address ?? '?';
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || now - a.since > 15 * 60_000) { attempts.set(ip, { n: 1, since: now }); return false; }
  a.n++;
  return a.n > 20;
}

export function createServer(store: Store, port = PORT) {
  const me = (req: Request) => store.userForToken(readCookie(req, COOKIE));

  return Bun.serve({
    port,
    development: !PROD && { hmr: true, console: true },
    routes: {
      '/api/health': () => new Response('ok'),

      '/api/data': req => {
        if (req.headers.get('if-none-match') === dataEtag) return new Response(null, { status: 304, headers: { ETag: dataEtag } });
        return new Response(dataBody, { headers: { 'Content-Type': 'application/json', ETag: dataEtag, 'Cache-Control': 'no-cache' } });
      },

      // Who am I, and what have I collected? No account yet: an empty list
      '/api/me': req => {
        const u = me(req);
        if (!u) return json({ code: null, visits: [] });
        return json({ code: u.code, visits: store.visits(u.id).map(v => [v.station, v.mode, v.date]) });
      },

      // Collect a station in a mode (the first one creates the account)
      '/api/visits': {
        PUT: async req => {
          const b = await body(req);
          if (!b) return error(415, 'JSON expected');
          const { station, mode, date } = b as { station?: string; mode?: Mode; date?: string };
          if (typeof station !== 'string' || !stationIds.has(station)) return error(400, 'unknown station');
          if (!MODES.includes(mode as Mode) || !stationModes.get(station)!.includes(mode!)) return error(400, 'mode not served at this station');
          const on = validDate(date) ? date : berlinToday();
          let u = me(req);
          const headers: Record<string, string> = {};
          if (!u) {
            const created = store.createUser();
            u = { id: created.id, code: created.code };
            headers['Set-Cookie'] = sessionCookie(created.token);
          }
          store.setVisit(u.id, station, mode!, on);
          return json({ ok: true, code: u.code, date: on }, { headers });
        },
        DELETE: async req => {
          const b = await body(req);
          if (!b) return error(415, 'JSON expected');
          const u = me(req);
          if (!u) return json({ ok: true });
          const { station, mode } = b as { station?: string; mode?: Mode };
          if (typeof station !== 'string' || !MODES.includes(mode as Mode)) return error(400, 'station and mode expected');
          store.deleteVisit(u.id, station, mode!);
          return json({ ok: true });
        },
      },

      // Sign in on this device with the code from another one. What this
      // device collected so far moves over to that account.
      '/api/login': {
        POST: async (req, server) => {
          if (tooManyAttempts(req, server)) return error(429, 'too many attempts, try again later');
          const b = await body(req);
          const code = typeof b?.code === 'string' ? normalizeCode(b.code) : null;
          if (!code) return error(400, 'invalid code');
          const target = store.userByCode(code);
          if (!target) return error(404, 'no account with this code');
          const current = me(req);
          if (current && current.id !== target.id) store.mergeInto(current.id, target.id);
          const oldToken = readCookie(req, COOKIE);
          if (oldToken) store.deleteSession(oldToken);
          const token = store.createSession(target.id);
          return json({ ok: true }, { headers: { 'Set-Cookie': sessionCookie(token) } });
        },
      },

      '/api/logout': {
        POST: async req => {
          const token = readCookie(req, COOKIE);
          if (token) store.deleteSession(token);
          return json({ ok: true }, { headers: { 'Set-Cookie': clearCookie } });
        },
      },

      // Everything about this account, gone
      '/api/account': {
        DELETE: async req => {
          if (!(await body(req))) return error(415, 'JSON expected');
          const u = me(req);
          if (u) store.deleteUser(u.id);
          return json({ ok: true }, { headers: { 'Set-Cookie': clearCookie } });
        },
      },

      '/api/*': () => error(404, 'not found'),

      // the app for every other path (it has its own little router)
      '/*': index,
    },
    error(e) {
      console.error(e);
      return error(500, 'server error');
    },
  });
}

if (import.meta.main) {
  const store = openDb(DB_PATH);
  const server = createServer(store);
  console.log(`berlin-streckensammler on ${server.url} (db ${DB_PATH}, ${stationIds.size} stations, data ${stationsData.feedDate})`);
  const stop = () => { server.stop(); store.db.close(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
