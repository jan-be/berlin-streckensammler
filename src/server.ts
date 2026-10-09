/**
 * One Bun process serves everything: the React app (bundled by Bun from
 * index.html), the station data and a small JSON API over SQLite.
 */
import index from './index.html';
import stationsData from '../data/stations.json';
import { openDb, MODES, NOTE_MAX, type Mode, type Store } from './db';
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
/** A note as stored: trimmed, at most NOTE_MAX characters, null when empty; undefined if it isn't text */
function cleanNote(n: unknown): string | null | undefined {
  if (n === undefined || n === null) return null;
  if (typeof n !== 'string') return undefined;
  const t = n.replace(/\r\n?/g, '\n').trim();
  return t ? t.slice(0, NOTE_MAX) : null;
}

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

      // The account (null while collecting without one) and the journal
      '/api/me': req => {
        const u = me(req);
        return json({
          account: accountView(store, u),
          entries: u ? store.entries(u.id).map(e => [e.id, e.station, e.mode, e.date, e.note]) : [],
        });
      },

      // Log a visit (the first one without an account starts an anonymous journal)
      '/api/entries': {
        POST: async req => {
          const b = await body(req);
          if (!b) return error(415, 'json_expected');
          const { station, mode, date } = b as { station?: string; mode?: Mode; date?: string };
          if (typeof station !== 'string' || !stationIds.has(station)) return error(400, 'unknown_station');
          if (!MODES.includes(mode as Mode) || !stationModes.get(station)!.includes(mode!)) return error(400, 'mode_not_served');
          const note = cleanNote(b.note);
          if (note === undefined) return error(400, 'note_invalid');
          const on = validDate(date) ? date : berlinToday();
          let u = me(req);
          const headers: Record<string, string> = {};
          if (!u) {
            u = store.createUser();
            headers['Set-Cookie'] = sessionCookie(store.createSession(u.id));
          }
          const id = store.addEntry(u.id, { station, mode: mode!, date: on, note });
          return json({ ok: true, entry: [id, station, mode, on, note] }, { headers });
        },
      },
      // Change a visit's date or note, or delete it
      '/api/entries/:id': {
        PATCH: async req => {
          const b = await body(req);
          if (!b) return error(415, 'json_expected');
          const u = me(req);
          const id = Number(req.params.id);
          const old = u && Number.isInteger(id) ? store.entry(u.id, id) : null;
          if (!old) return error(404, 'not_found');
          const date = b.date === undefined ? old.date : b.date;
          if (!validDate(date)) return error(400, 'date_invalid');
          const note = b.note === undefined ? old.note : cleanNote(b.note);
          if (note === undefined) return error(400, 'note_invalid');
          store.updateEntry(u!.id, id, { date, note });
          return json({ ok: true, entry: [id, old.station, old.mode, date, note] });
        },
        DELETE: async req => {
          if (!(await body(req))) return error(415, 'json_expected');
          const u = me(req);
          const id = Number(req.params.id);
          if (!u || !Number.isInteger(id) || !store.deleteEntry(u.id, id)) return error(404, 'not_found');
          return json({ ok: true });
        },
      },

      ...authRoutes({ store, me, token, json, error, body, cookie: sessionCookie }),

      // Everything stored about you, as a file (Art. 15 and 20 GDPR)
      '/api/export': req => {
        const u = me(req);
        const data = u ? store.exportUser(u.id) : null;
        const stations = new Map((stationsData.stations as unknown[][]).map(st => [st[0] as string, st[1] as string]));
        const body = {
          exportedAt: new Date().toISOString(),
          site: 'berlin-streckensammler.janbe.eu',
          ...(data ?? { account: null, passkeys: [], sessions: [], visits: [] }),
        };
        body.visits = body.visits.map(v => ({ ...v, stationName: stations.get(v.station as string) ?? null }));
        return new Response(JSON.stringify(body, null, 2), {
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Disposition': 'attachment; filename="streckensammler-daten.json"',
            'Cache-Control': 'no-store',
          },
        });
      },

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
