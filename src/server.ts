/**
 * One Bun process serves everything: the React app (bundled by Bun from
 * index.html), the station data and a small JSON API over SQLite.
 */
import index from './index.html';
import stationsData from '../data/stations.json';
import { openDb, MODES, type Mode, type Store } from './db';
import { authRoutes, accountView } from './auth';

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
const error = (status: number, code: string) => json({ error: code }, { status });

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

export function createServer(store: Store, port = PORT) {
  const token = (req: Request) => readCookie(req, COOKIE);
  const me = (req: Request) => store.userForToken(token(req));

  return Bun.serve({
    port,
    development: !PROD && { hmr: true, console: true },
    routes: {
      '/api/health': () => new Response('ok'),

      '/api/data': req => {
        if (req.headers.get('if-none-match') === dataEtag) return new Response(null, { status: 304, headers: { ETag: dataEtag } });
        return new Response(dataBody, { headers: { 'Content-Type': 'application/json', ETag: dataEtag, 'Cache-Control': 'no-cache' } });
      },

      // The account (null while collecting without one) and what was collected
      '/api/me': req => {
        const u = me(req);
        return json({
          account: accountView(store, u),
          visits: u ? store.visits(u.id).map(v => [v.station, v.mode, v.date]) : [],
        });
      },

      // Collect a station in a mode (the first one without an account starts an anonymous collection)
      '/api/visits': {
        PUT: async req => {
          const b = await body(req);
          if (!b) return error(415, 'json_expected');
          const { station, mode, date } = b as { station?: string; mode?: Mode; date?: string };
          if (typeof station !== 'string' || !stationIds.has(station)) return error(400, 'unknown_station');
          if (!MODES.includes(mode as Mode) || !stationModes.get(station)!.includes(mode!)) return error(400, 'mode_not_served');
          const on = validDate(date) ? date : berlinToday();
          let u = me(req);
          const headers: Record<string, string> = {};
          if (!u) {
            u = store.createUser();
            headers['Set-Cookie'] = sessionCookie(store.createSession(u.id));
          }
          store.setVisit(u.id, station, mode!, on);
          return json({ ok: true, date: on }, { headers });
        },
        DELETE: async req => {
          const b = await body(req);
          if (!b) return error(415, 'json_expected');
          const u = me(req);
          if (!u) return json({ ok: true });
          const { station, mode } = b as { station?: string; mode?: Mode };
          if (typeof station !== 'string' || !MODES.includes(mode as Mode)) return error(400, 'station_and_mode_expected');
          store.deleteVisit(u.id, station, mode!);
          return json({ ok: true });
        },
      },

      ...authRoutes({ store, me, token, json, error, body, cookie: sessionCookie }),

      '/api/logout': {
        POST: async req => {
          const t = token(req);
          if (t) store.deleteSession(t);
          return json({ ok: true }, { headers: { 'Set-Cookie': clearCookie } });
        },
      },

      // Everything about this account (or anonymous collection), gone
      '/api/account': {
        DELETE: async req => {
          if (!(await body(req))) return error(415, 'json_expected');
          const u = me(req);
          if (u) store.deleteUser(u.id);
          return json({ ok: true }, { headers: { 'Set-Cookie': clearCookie } });
        },
      },

      '/api/*': () => error(404, 'not_found'),

      // the app for every other path (it has its own little router)
      '/*': index,
    },
    error(e) {
      console.error(e);
      return error(500, 'server_error');
    },
  });
}

if (import.meta.main) {
  const store = openDb(DB_PATH);
  const server = createServer(store);
  console.log(`berlin-streckensammler on ${server.url} (db ${DB_PATH}, ${stationIds.size} stations, data ${stationsData.feedDate}, origin ${process.env.ORIGIN ?? 'dev'})`);
  const stop = () => { server.stop(); store.db.close(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
