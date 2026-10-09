import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { decode, nearest, search, MODES, type Line, type Mode, type Network, type Station } from './data';
import { api, ApiError, cancelled, localToday, passkeysSupported, type Account, type Entry } from './api';
import { STRINGS, formatDate, formatMonth, initialLang, type Lang, type T } from './i18n';
import { MODE_COLOR, ModeIcon, PasskeyIcon } from './icons';
import { providerName } from './passkeyProviders';
import { LegalPage, REPO } from './legal';

// ── routes ─────────────────────────────────────────────────────────────────
const SLUG: Record<Mode, string> = { S: 's-bahn', U: 'u-bahn', R: 'regio', T: 'tram', B: 'bus', F: 'faehre' };
const MODE_OF_SLUG = Object.fromEntries(Object.entries(SLUG).map(([m, s]) => [s, m])) as Record<string, Mode>;
const JOURNAL = 'besuche';
const LEGAL = ['rechtliches', 'impressum', 'datenschutz'];
type Route = { mode: Mode | null; line: string | null; journal?: boolean; legal?: 'rechtliches' | 'impressum' | 'datenschutz' };

function parseRoute(path: string): Route {
  const [slug, line] = path.split('/').filter(Boolean).map(decodeURIComponent);
  if (slug === JOURNAL) return { mode: null, line: null, journal: true };
  if (LEGAL.includes(slug)) return { mode: null, line: null, legal: slug as Route['legal'] };
  const mode = MODE_OF_SLUG[slug] ?? null;
  return { mode, line: mode && line ? line : null };
}
const routePath = (r: Route) =>
  r.legal ? `/${r.legal}` : r.journal ? `/${JOURNAL}` : r.mode ? `/${SLUG[r.mode]}${r.line ? `/${encodeURIComponent(r.line)}` : ''}` : '/';

const key = (station: string, mode: Mode) => `${station}|${mode}`;

/** Black or white text on a line colour */
function textOn(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255];
  return 0.299 * r + 0.587 * g + 0.114 * b > 170 ? '#1a1a1a' : '#fff';
}

const BANNER_KEY = 'saveBannerDismissed';
const readFlag = (k: string) => { try { return localStorage.getItem(k) === '1'; } catch { return false; } };
const setFlag = (k: string) => { try { localStorage.setItem(k, '1'); } catch { /* */ } };

/** What the journal says about each station and mode: collected since when, how often */
type Collected = Map<string, { first: string; count: number }>;
function collectedFrom(entries: Entry[]): Collected {
  const m: Collected = new Map();
  for (const e of entries) {
    const k = key(e.station, e.mode);
    const c = m.get(k);
    if (!c) m.set(k, { first: e.date, count: 1 });
    else { c.count++; if (e.date < c.first) c.first = e.date; }
  }
  return m;
}
const byNewest = (a: Entry, b: Entry) => b.date.localeCompare(a.date) || b.id - a.id;

type Toast = { text: string; actions?: { label: string; run: () => void }[] };
type SheetState = { station: Station; mode?: Mode; edit?: number };

// ── app ────────────────────────────────────────────────────────────────────
export function App() {
  const [lang, setLang] = useState<Lang>(initialLang);
  const t = STRINGS[lang];
  const [net, setNet] = useState<Network | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [account, setAccount] = useState<Account | null>(null);
  const [route, setRoute] = useState<Route>(() => parseRoute(location.pathname));
  const [query, setQuery] = useState('');
  const [near, setNear] = useState<{ status: 'loading' | 'denied' | 'unavailable' | 'ok'; at?: { lat: number; lon: number } } | null>(null);
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [bannerGone, setBannerGone] = useState(() => readFlag(BANNER_KEY));
  const collected = useMemo(() => collectedFrom(entries), [entries]);

  useEffect(() => { document.documentElement.lang = lang; try { localStorage.setItem('lang', lang); } catch { /* */ } }, [lang]);

  const loadMe = useCallback(async () => {
    const me = await api.me();
    setEntries(me.entries);
    setAccount(me.account);
  }, []);
  const load = useCallback(async () => {
    try {
      const [raw] = await Promise.all([api.data(), loadMe()]);
      setNet(decode(raw as Parameters<typeof decode>[0]));
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, [loadMe]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const onPop = () => { setRoute(parseRoute(location.pathname)); setSheet(null); };
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, []);
  const go = useCallback((r: Route) => {
    history.pushState(null, '', routePath(r));
    setRoute(r);
    setQuery('');
    setNear(null);
    scrollTo({ top: 0 });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), toast.actions ? 6000 : 3500);
    return () => clearTimeout(id);
  }, [toast]);
  const say = useCallback((text: string) => setToast({ text }), []);

  const fail = useCallback((e: unknown) => {
    if (cancelled(e)) return;
    if (e instanceof ApiError) say(e.status === 0 ? t.offline : t.errors[e.code] ?? t.error);
    else say(t.error);
  }, [t, say]);

  // ── the journal: shown at once, put right if the server says no ─────────
  const logVisit = useCallback(async (s: Station, mode: Mode, opts: { date?: string; note?: string | null } = {}) => {
    const temp: Entry = { id: -Date.now(), station: s.id, mode, date: opts.date ?? localToday(), note: opts.note || null };
    setEntries(es => [temp, ...es]);
    try {
      const saved = await api.addEntry(s.id, mode, opts);
      setEntries(es => es.map(e => (e.id === temp.id ? saved : e)));
      return saved;
    } catch (e) {
      setEntries(es => es.filter(x => x.id !== temp.id));
      fail(e);
      return null;
    }
  }, [fail]);

  const updateEntry = useCallback(async (id: number, patch: { date: string; note: string | null }) => {
    const before = entries.find(e => e.id === id);
    setEntries(es => es.map(e => (e.id === id ? { ...e, ...patch, note: patch.note || null } : e)));
    try { await api.updateEntry(id, patch); } catch (e) {
      if (before) setEntries(es => es.map(x => (x.id === id ? before : x)));
      fail(e);
    }
  }, [entries, fail]);

  const removeEntry = useCallback(async (id: number) => {
    const before = entries.find(e => e.id === id);
    setEntries(es => es.filter(e => e.id !== id));
    try { await api.deleteEntry(id); } catch (e) {
      if (before) setEntries(es => [before, ...es]);
      fail(e);
    }
  }, [entries, fail]);

  /**
   * A tap on a station's sign: not visited yet in that mode → log a visit now
   * (with Undo and a way to add a note); visited → open the station, where its
   * visits are, so a stray tap never deletes anything.
   */
  const quickTap = useCallback(async (s: Station, mode: Mode) => {
    if (collected.has(key(s.id, mode))) { setSheet({ station: s, mode }); return; }
    const saved = await logVisit(s, mode);
    if (!saved) return;
    setToast({
      text: t.logged(`${s.name} · ${t.modes[mode]}`),
      actions: [
        { label: t.undo, run: () => removeEntry(saved.id) },
        { label: t.addNote, run: () => setSheet({ station: s, mode, edit: saved.id }) },
      ],
    });
  }, [collected, logVisit, removeEntry, t]);

  const findNearby = useCallback(() => {
    if (!('geolocation' in navigator)) { setNear({ status: 'unavailable' }); return; }
    setQuery('');
    setNear({ status: 'loading' });
    navigator.geolocation.getCurrentPosition(
      p => setNear({ status: 'ok', at: { lat: p.coords.latitude, lon: p.coords.longitude } }),
      e => setNear({ status: e.code === e.PERMISSION_DENIED ? 'denied' : 'unavailable' }),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
    );
  }, []);

  const collectedIn = useCallback((m: Mode) => {
    if (!net) return 0;
    let n = 0;
    for (const k of collected.keys()) if (k.endsWith(`|${m}`) && net.byId.has(k.slice(0, -2))) n++;
    return n;
  }, [collected, net]);

  if (loadError) return (
    <div className="center-msg">
      <p>{t.offline}</p>
      <button className="btn" onClick={load}>↻</button>
    </div>
  );
  if (!net) return <div className="center-msg"><div className="spinner" aria-label="…" /></div>;

  const mode = route.mode;
  const line = route.line ? net.linesByMode[route.mode!]?.find(l => l.name === route.line) ?? null : null;
  const results = query.trim() ? search(net.stations, query, mode) : null;
  const nearby = near?.status === 'ok' && near.at ? nearest(net.stations, near.at, mode) : null;
  const showBanner = !account && !bannerGone && entries.length >= 3 && !mode && !route.journal && !route.legal && !results && !near;
  const openStation = (s: Station) => setSheet({ station: s });
  const list = { collected, onTap: quickTap, onOpen: openStation, t };

  return (
    <div className="app">
      <header className="top">
        <button className="brand" onClick={() => go({ mode: null, line: null })}>
          <span className="brand-mark" aria-hidden="true"><ModeIcon mode="S" size={24} /><ModeIcon mode="U" size={24} /></span>
          <span className="brand-text">{t.title}</span>
        </button>
        <button className={`account-btn ${account ? 'in' : ''}`} onClick={() => setAccountOpen(true)} aria-label={account ? `${t.account}: ${account.name}` : t.signIn}>
          {account ? <span className="avatar" aria-hidden="true">{account.name.slice(0, 1).toUpperCase()}</span> : <PasskeyIcon />}
          <span className="account-label">{account ? account.name : t.signIn}</span>
        </button>
      </header>

      <nav className="tabs" aria-label={t.lines}>
        <button className={`tab all ${!mode ? 'on' : ''}`} onClick={() => go({ mode: null, line: null })}>{t.all}</button>
        {MODES.map(m => (
          <button key={m} className={`tab ${mode === m ? 'on' : ''}`} style={{ '--mode': MODE_COLOR[m] } as React.CSSProperties}
            onClick={() => go({ mode: m, line: null })} aria-label={`${t.modes[m]}: ${collectedIn(m)} ${t.of} ${net.count[m]}`}>
            <ModeIcon mode={m} size={22} />
            <span className="tab-count">{collectedIn(m)}<span className="tab-total">/{net.count[m]}</span></span>
          </button>
        ))}
      </nav>

      <div className="searchbar">
        <div className="search-field">
          {mode ? <ModeIcon mode={mode} size={18} /> : (
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" /><path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
          )}
          <input
            type="search" value={query} onChange={e => { setQuery(e.target.value); setNear(null); }}
            placeholder={mode ? t.searchPlaceholderMode(t.modeLong[mode]) : t.searchPlaceholder}
            aria-label={mode ? t.searchPlaceholderMode(t.modeLong[mode]) : t.searchPlaceholder} autoComplete="off" spellCheck={false} enterKeyHint="search"
          />
          {query && <button className="clear" onClick={() => setQuery('')} aria-label="×">×</button>}
        </div>
        <button className={`btn nearby ${near ? 'on' : ''}`} onClick={() => (near ? setNear(null) : findNearby())} aria-label={t.nearby} aria-pressed={!!near}>
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /><circle cx="12" cy="12" r="6" fill="none" stroke="currentColor" strokeWidth="2" /><circle cx="12" cy="12" r="2" fill="currentColor" /></svg>
          <span>{t.nearby}</span>
        </button>
      </div>

      <main>
        {showBanner && (
          <div className="banner">
            <PasskeyIcon size={22} />
            <div className="banner-text">{t.saveBanner(entries.length)}</div>
            <div className="banner-actions">
              <button className="btn small primary" onClick={() => setAccountOpen(true)}>{t.saveBannerAction}</button>
              <button className="link small" onClick={() => { setFlag(BANNER_KEY); setBannerGone(true); }}>{t.later}</button>
            </div>
          </div>
        )}
        {results ? (
          <StationList stations={results} mode={mode} {...list} empty={t.noResults} />
        ) : near ? (
          <section>
            {near.status === 'loading' && <p className="muted pad">{t.nearbyLoading}</p>}
            {near.status === 'denied' && <p className="notice">{t.nearbyDenied}</p>}
            {near.status === 'unavailable' && <p className="notice">{t.nearbyUnavailable}</p>}
            {nearby && (
              <>
                <StationList stations={nearby.map(n => n.s)} distances={nearby.map(n => n.d)} mode={mode} {...list} empty={t.noResults} />
                <p className="muted small pad">{t.nearbyNote}</p>
              </>
            )}
          </section>
        ) : route.legal ? (
          <LegalPage lang={lang} section={route.legal === 'rechtliches' ? undefined : route.legal}
            onBack={() => go({ mode: null, line: null })} backLabel={t.back} />
        ) : route.journal ? (
          <JournalPage net={net} entries={entries} onOpen={openStation} onBack={() => go({ mode: null, line: null })} lang={lang} t={t} />
        ) : line ? (
          <LinePage line={line} {...list} onBack={() => go({ mode: line.mode, line: null })} />
        ) : mode ? (
          <ModePage net={net} mode={mode} collected={collected} count={collectedIn(mode)} onLine={l => go({ mode, line: l.name })} t={t} />
        ) : (
          <Home net={net} entries={entries} collectedIn={collectedIn} onMode={m => go({ mode: m, line: null })}
            onOpen={openStation} onJournal={() => go({ mode: null, line: null, journal: true })} lang={lang} t={t} />
        )}
      </main>

      <footer className="foot">
        <p>{t.attribution(formatDate(net.feedDate, lang))}</p>
        <p>{t.disclaimer} {t.signsCredit}</p>
        <p className="foot-links">
          <button className="link" onClick={() => go({ mode: null, line: null, legal: 'impressum' })}>{t.imprint}</button>
          <button className="link" onClick={() => go({ mode: null, line: null, legal: 'datenschutz' })}>{t.privacyTitle}</button>
          <a className="link github" href={REPO} target="_blank" rel="noopener noreferrer">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" /></svg>
            {t.sourceCode}
          </a>
          <button className="link" onClick={() => setLang(lang === 'de' ? 'en' : 'de')}>{t.language}</button>
        </p>
      </footer>

      {sheet && (
        <StationSheet key={sheet.station.id} station={sheet.station} initialMode={sheet.mode} initialEdit={sheet.edit}
          entries={entries} onLog={logVisit} onUpdate={updateEntry} onDelete={removeEntry}
          onClose={() => setSheet(null)} onLine={l => { setSheet(null); go({ mode: l.mode, line: l.name }); }} lang={lang} t={t} />
      )}
      {accountOpen && (
        <AccountSheet account={account} collected={entries.length} lang={lang} t={t}
          onClose={() => setAccountOpen(false)} onChanged={loadMe} onToast={say} onError={fail} />
      )}
      {toast && (
        <div className="toast" role="status">
          <span>{toast.text}</span>
          {toast.actions?.map(a => (
            <button key={a.label} className="toast-action" onClick={() => { setToast(null); a.run(); }}>{a.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── pieces ─────────────────────────────────────────────────────────────────
export function LineBadge({ line, small }: { line: Line; small?: boolean }) {
  const shape = line.mode === 'U' ? 'square' : line.mode === 'S' ? 'pill' : 'tag';
  return (
    <span className={`badge ${shape} ${small ? 'small' : ''}`} style={{ background: line.color, color: textOn(line.color) }}>{line.name}</span>
  );
}

/** The label of a station's sign or circle: log it, or (visited) open it */
const tapLabel = (t: T, s: Station, mode: Mode, modeName: string, c: Collected) => {
  const got = c.get(key(s.id, mode));
  return got ? t.collectedOpen(s.name, modeName, got.count) : t.collect(s.name, modeName);
};

function Check({ on, color, label, onClick, big, count }: { on: boolean; color: string; label: string; onClick: () => void; big?: boolean; count?: number }) {
  return (
    <button className={`check ${on ? 'on' : ''} ${big ? 'big' : ''}`} style={{ '--c': color } as React.CSSProperties}
      aria-label={label} title={label} onClick={e => { e.stopPropagation(); onClick(); }}>
      {on && (count && count > 1
        ? <span className="check-count" aria-hidden="true">{count}</span>
        : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg>)}
    </button>
  );
}

/** A mode's sign as a button: grey until visited, then in colour with a tick (or how many times) */
function ModeToggle({ mode, on, count, label, onClick, size = 30 }: { mode: Mode; on: boolean; count?: number; label: string; onClick: () => void; size?: number }) {
  return (
    <button className={`mode-toggle ${on ? 'on' : ''}`} aria-label={label} title={label}
      onClick={e => { e.stopPropagation(); onClick(); }}>
      <ModeIcon mode={mode} size={size} />
      {on && (
        <span className="tick" aria-hidden="true">
          {count && count > 1 ? count : <svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" /></svg>}
        </span>
      )}
    </button>
  );
}

function StationList({ stations, distances, mode, collected, onTap, onOpen, t, empty }: {
  stations: Station[]; distances?: number[]; mode: Mode | null; collected: Collected;
  onTap: (s: Station, m: Mode) => void; onOpen: (s: Station) => void; t: T; empty: string;
}) {
  if (!stations.length) return <p className="muted pad">{empty}</p>;
  return (
    <ul className="list">
      {stations.map((s, i) => {
        const lines = mode ? s.lines[mode] ?? [] : MODES.filter(m => m !== 'B').flatMap(m => s.lines[m] ?? []);
        const bus = !mode ? s.lines.B ?? [] : [];
        return (
          <li key={s.id} className="row" onClick={() => onOpen(s)}>
            <div className="row-main">
              <div className="row-name">{s.name}</div>
              <div className="row-meta">
                {distances && <span className="dist">{t.meters(distances[i])}</span>}
                {lines.slice(0, 10).map(l => <LineBadge key={l.id} line={l} small />)}
                {lines.length > 10 && <span className="muted small">+{lines.length - 10}</span>}
                {bus.length > 0 && (
                  <span className="bus-lines"><ModeIcon mode="B" size={14} /> {bus.slice(0, 4).map(l => l.name).join(', ')}{bus.length > 4 ? ' …' : ''}</span>
                )}
                {s.note && <span className="note">{t.closedNote[s.note] ?? s.note}</span>}
              </div>
            </div>
            {mode ? (
              <Check big on={collected.has(key(s.id, mode))} count={collected.get(key(s.id, mode))?.count} color={MODE_COLOR[mode]}
                label={tapLabel(t, s, mode, t.modes[mode], collected)} onClick={() => onTap(s, mode)} />
            ) : (
              <div className="toggles">
                {s.modes.map(m => (
                  <ModeToggle key={m} mode={m} on={collected.has(key(s.id, m))} count={collected.get(key(s.id, m))?.count}
                    label={tapLabel(t, s, m, t.modes[m], collected)} onClick={() => onTap(s, m)} />
                ))}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Progress({ value, total, color }: { value: number; total: number; color: string }) {
  const pct = total ? (value / total) * 100 : 0;
  return <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={value}><span style={{ width: `${pct}%`, background: color }} /></div>;
}

/** One journal line: the mode's sign, the station, the day, the note */
function EntryRow({ e, s, onOpen, lang, t, withDate = true }: { e: Entry; s: Station; onOpen: (s: Station) => void; lang: Lang; t: T; withDate?: boolean }) {
  return (
    <li className="row entry-row" onClick={() => onOpen(s)}>
      <ModeIcon mode={e.mode} size={24} label={t.modes[e.mode]} />
      <div className="row-main">
        <div className="row-name">{s.name}</div>
        {e.note && <div className="entry-note">{e.note}</div>}
      </div>
      {withDate && <span className="muted small nowrap">{formatDate(e.date, lang)}</span>}
    </li>
  );
}

function Home({ net, entries, collectedIn, onMode, onOpen, onJournal, lang, t }: {
  net: Network; entries: Entry[]; collectedIn: (m: Mode) => number; onMode: (m: Mode) => void;
  onOpen: (s: Station) => void; onJournal: () => void; lang: Lang; t: T;
}) {
  const recent = useMemo(() => [...entries].sort(byNewest).filter(e => net.byId.has(e.station)).slice(0, 8), [entries, net]);
  const stations = useMemo(() => new Set(entries.map(e => e.station)).size, [entries]);
  return (
    <>
      <section className="cards">
        {MODES.map(m => {
          const n = collectedIn(m), total = net.count[m];
          return (
            <button key={m} className="card" onClick={() => onMode(m)} aria-label={`${t.modes[m]}: ${n} ${t.of} ${total}`}>
              <div className="card-head">
                <ModeIcon mode={m} size={30} />
                <div className="card-num"><b>{n}</b> <span className="muted">/ {total}</span></div>
              </div>
              <Progress value={n} total={total} color={MODE_COLOR[m]} />
            </button>
          );
        })}
      </section>
      {recent.length ? (
        <section>
          <div className="section-head">
            <h2>{t.recent}</h2>
            <span className="muted small">{t.summary(entries.length, stations)}</span>
          </div>
          <ul className="list">
            {recent.map(e => <EntryRow key={e.id} e={e} s={net.byId.get(e.station)!} onOpen={onOpen} lang={lang} t={t} />)}
          </ul>
          {entries.length > recent.length && <button className="more-link" onClick={onJournal}>{t.journal} ›</button>}
        </section>
      ) : <p className="hint">{t.emptyHint}</p>}
    </>
  );
}

/** Every visit, newest first, by month */
function JournalPage({ net, entries, onOpen, onBack, lang, t }: {
  net: Network; entries: Entry[]; onOpen: (s: Station) => void; onBack: () => void; lang: Lang; t: T;
}) {
  const months = useMemo(() => {
    const out: { month: string; items: Entry[] }[] = [];
    for (const e of [...entries].sort(byNewest)) {
      if (!net.byId.has(e.station)) continue;
      const m = e.date.slice(0, 7);
      if (out[out.length - 1]?.month !== m) out.push({ month: m, items: [] });
      out[out.length - 1].items.push(e);
    }
    return out;
  }, [entries, net]);
  return (
    <>
      <button className="back" onClick={onBack}>‹ {t.back}</button>
      <h1 className="page-title">{t.journal}</h1>
      {months.length === 0 && <p className="hint">{t.noVisits}</p>}
      {months.map(({ month, items }) => (
        <section key={month}>
          <h2>{formatMonth(`${month}-01`, lang)}</h2>
          <ul className="list">
            {items.map(e => <EntryRow key={e.id} e={e} s={net.byId.get(e.station)!} onOpen={onOpen} lang={lang} t={t} />)}
          </ul>
        </section>
      ))}
    </>
  );
}

function lineCount(l: Line, collected: Collected) {
  return { n: l.all.filter(s => collected.has(key(s.id, l.mode))).length, total: l.all.length };
}

function ModePage({ net, mode, collected, count, onLine, t }: {
  net: Network; mode: Mode; collected: Collected; count: number; onLine: (l: Line) => void; t: T;
}) {
  const lines = net.linesByMode[mode];
  return (
    <>
      <section className="mode-head" style={{ '--mode': MODE_COLOR[mode] } as React.CSSProperties}>
        <div className="mode-title">
          <ModeIcon mode={mode} size={40} label={t.modes[mode]} />
          <div className="mode-num"><b>{count}</b> {t.of} {net.count[mode]} {t.modeLong[mode]} {t.collected}</div>
        </div>
        <Progress value={count} total={net.count[mode]} color={MODE_COLOR[mode]} />
      </section>
      <h2>{t.lines}</h2>
      <ul className="list">
        {lines.map(l => {
          const { n, total } = lineCount(l, collected);
          const first = l.main[0]?.name, last = l.main[l.main.length - 1]?.name;
          return (
            <li key={l.id} className="row line-row" onClick={() => onLine(l)}>
              <LineBadge line={l} />
              <div className="row-main">
                <div className="row-name small-name">{first && last && first !== last ? t.lineSpan(first, last) : first}</div>
                <Progress value={n} total={total} color={l.color} />
              </div>
              <span className={`count ${n === total ? 'done' : ''}`}>{n}/{total}</span>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function LinePage({ line, collected, onTap, onOpen, onBack, t }: {
  line: Line; collected: Collected; onTap: (s: Station, m: Mode) => void; onOpen: (s: Station) => void; onBack: () => void; t: T;
}) {
  const { n, total } = lineCount(line, collected);
  const stop = (s: Station, i: number, arr: Station[]) => {
    const got = collected.get(key(s.id, line.mode));
    const others = (s.lines[line.mode] ?? []).filter(l => l.id !== line.id);
    return (
      <li key={`${s.id}-${i}`} className={`stop ${got ? 'on' : ''} ${i === 0 ? 'first' : ''} ${i === arr.length - 1 ? 'last' : ''}`} onClick={() => onOpen(s)}>
        <span className="track" aria-hidden="true" />
        <Check on={!!got} count={got?.count} color={line.color} label={tapLabel(t, s, line.mode, line.name, collected)} onClick={() => onTap(s, line.mode)} />
        <div className="row-main">
          <div className="row-name">{s.name}</div>
          {(others.length > 0 || s.note) && (
            <div className="row-meta">
              {others.slice(0, 8).map(l => <LineBadge key={l.id} line={l} small />)}
              {s.note && <span className="note">{t.closedNote[s.note] ?? s.note}</span>}
            </div>
          )}
        </div>
      </li>
    );
  };
  return (
    <>
      <button className="back" onClick={onBack}>‹ {t.back}</button>
      <section className="line-head">
        <div className="line-title">
          <LineBadge line={line} />
          {line.main.length > 1 && <span>{t.lineSpan(line.main[0].name, line.main[line.main.length - 1].name)}</span>}
        </div>
        <div className="line-num"><b>{n}</b> {t.of} {total} {n === total ? `· ${t.done} 🎉` : ''}</div>
        <Progress value={n} total={total} color={line.color} />
      </section>
      <ul className="stops" style={{ '--c': line.color } as React.CSSProperties}>{line.main.map(stop)}</ul>
      {line.more.length > 0 && (
        <>
          <h2>{t.moreStations}</h2>
          <ul className="stops loose" style={{ '--c': line.color } as React.CSSProperties}>{line.more.map(stop)}</ul>
        </>
      )}
    </>
  );
}

function Sheet({ title, onClose, children, closeLabel }: { title: React.ReactNode; onClose: () => void; children: React.ReactNode; closeLabel: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" tabIndex={-1} ref={ref} onClick={e => e.stopPropagation()}>
        <div className="sheet-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label={closeLabel}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * A station: per mode how often and since when, a form to log a visit with a
 * note, and every visit here (edit its day or note, or delete it).
 */
function StationSheet({ station: s, initialMode, initialEdit, entries, onLog, onUpdate, onDelete, onClose, onLine, lang, t }: {
  station: Station; initialMode?: Mode; initialEdit?: number; entries: Entry[];
  onLog: (s: Station, m: Mode, opts: { date?: string; note?: string | null }) => Promise<Entry | null>;
  onUpdate: (id: number, patch: { date: string; note: string | null }) => void; onDelete: (id: number) => void;
  onClose: () => void; onLine: (l: Line) => void; lang: Lang; t: T;
}) {
  const here = useMemo(() => entries.filter(e => e.station === s.id).sort(byNewest), [entries, s.id]);
  const [mode, setMode] = useState<Mode>(initialMode && s.modes.includes(initialMode) ? initialMode : s.modes[0]);
  const [date, setDate] = useState(localToday());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<number | null>(initialEdit ?? null);
  const osm = `https://www.openstreetmap.org/?mlat=${s.lat}&mlon=${s.lon}#map=17/${s.lat}/${s.lon}`;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const saved = await onLog(s, mode, { date, note: note.trim() || null });
    setBusy(false);
    // ready for the next one: no note, today
    if (saved) { setNote(''); setDate(localToday()); }
  };

  return (
    <Sheet title={s.name} onClose={onClose} closeLabel={t.close}>
      {s.note && <p className="note block">{t.closedNote[s.note] ?? s.note}</p>}
      <ul className="sheet-modes">
        {s.modes.map(m => {
          const mine = here.filter(e => e.mode === m);
          const first = mine.reduce<string | null>((a, e) => (!a || e.date < a ? e.date : a), null);
          return (
            <li key={m} className={m === mode ? 'chosen' : ''} onClick={() => setMode(m)}>
              <ModeToggle mode={m} size={34} on={mine.length > 0} count={mine.length} label={t.modes[m]} onClick={() => setMode(m)} />
              <div className="row-main">
                <div className="small">
                  {mine.length ? <><b>{t.visitsCount(mine.length)}</b> <span className="muted">· {t.firstVisit(formatDate(first!, lang))}</span></>
                    : <span className="muted">{t.notCollected}</span>}
                </div>
                {(s.lines[m] ?? []).length > 0 && (
                  <div className="row-meta wrap">
                    {(s.lines[m] ?? []).map(l => <button key={l.id} className="badge-btn" onClick={e => { e.stopPropagation(); onLine(l); }}><LineBadge line={l} small /></button>)}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <form className="log-form" onSubmit={submit}>
        <h4>{t.logVisit}</h4>
        <div className="log-row">
          {s.modes.length > 1 && (
            <div className="mode-pick" role="radiogroup" aria-label={t.logVisit}>
              {s.modes.map(m => (
                <button type="button" key={m} role="radio" aria-checked={m === mode} aria-label={t.modes[m]} title={t.modes[m]}
                  className={`mode-choice ${m === mode ? 'on' : ''}`} onClick={() => setMode(m)}>
                  <ModeIcon mode={m} size={26} />
                </button>
              ))}
            </div>
          )}
          <input type="date" value={date} max={localToday()} onChange={e => e.target.value && setDate(e.target.value)} aria-label={t.date} />
        </div>
        <textarea value={note} onChange={e => setNote(e.target.value)} placeholder={t.notePlaceholder} maxLength={500} rows={2} aria-label={t.notePlaceholder} />
        <button className="btn primary" disabled={busy}>{t.logIt}</button>
      </form>

      {here.length > 0 && (
        <>
          <h4>{t.visitsTitle}</h4>
          <ul className="visits">
            {here.map(e => editing === e.id
              ? <EntryEditor key={e.id} e={e} onSave={patch => { onUpdate(e.id, patch); setEditing(null); }}
                  onDelete={() => { if (confirm(t.deleteVisitConfirm)) { onDelete(e.id); setEditing(null); } }}
                  onCancel={() => setEditing(null)} t={t} />
              : (
                <li key={e.id} className="visit" onClick={() => setEditing(e.id)}>
                  <ModeIcon mode={e.mode} size={20} label={t.modes[e.mode]} />
                  <div className="row-main">
                    <div className="small"><b>{formatDate(e.date, lang)}</b></div>
                    <div className={e.note ? 'entry-note' : 'muted small'}>{e.note ?? t.noNote}</div>
                  </div>
                  <button className="link small" onClick={ev => { ev.stopPropagation(); setEditing(e.id); }}>{t.edit}</button>
                </li>
              ))}
          </ul>
        </>
      )}
      <p><a href={osm} target="_blank" rel="noopener noreferrer">{t.showOnMap} ↗</a></p>
    </Sheet>
  );
}

function EntryEditor({ e, onSave, onDelete, onCancel, t }: {
  e: Entry; onSave: (patch: { date: string; note: string | null }) => void; onDelete: () => void; onCancel: () => void; t: T;
}) {
  const [date, setDate] = useState(e.date);
  const [note, setNote] = useState(e.note ?? '');
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <li className="visit editing">
      <form className="edit-form" onSubmit={ev => { ev.preventDefault(); onSave({ date, note: note.trim() || null }); }}>
        <div className="log-row">
          <ModeIcon mode={e.mode} size={24} label={t.modes[e.mode]} />
          <input type="date" value={date} max={localToday()} onChange={ev => ev.target.value && setDate(ev.target.value)} aria-label={t.date} />
        </div>
        <textarea ref={ref} value={note} onChange={ev => setNote(ev.target.value)} placeholder={t.notePlaceholder} maxLength={500} rows={3} aria-label={t.notePlaceholder} />
        <div className="edit-actions">
          <button className="btn small primary">{t.save}</button>
          <button type="button" className="btn small" onClick={onCancel}>{t.cancel}</button>
          <button type="button" className="link small red" onClick={onDelete}>{t.delete}</button>
        </div>
      </form>
    </li>
  );
}

function AccountSheet({ account, collected, lang, t, onClose, onChanged, onToast, onError }: {
  account: Account | null; collected: number; lang: Lang; t: T;
  onClose: () => void; onChanged: () => Promise<void>; onToast: (m: string) => void; onError: (e: unknown) => void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const supported = useMemo(() => passkeysSupported(), []);

  /** Run an account action: busy while it runs, its error shown here */
  const run = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what);
    setMsg(null);
    try { await fn(); } catch (e) {
      if (cancelled(e)) return;
      // the authenticator already holds a passkey of this account (excludeCredentials)
      if (e instanceof Error && e.name === 'InvalidStateError') { setMsg(t.errors.passkey_exists); return; }
      if (e instanceof ApiError && t.errors[e.code]) setMsg(t.errors[e.code]);
      else onError(e);
    } finally { setBusy(null); }
  };

  const create = (e: React.FormEvent) => {
    e.preventDefault();
    run('create', async () => {
      const r = await api.createAccount(name);
      await onChanged();
      onToast(t.accountCreated(r.account.name));
      onClose();
    });
  };
  const signIn = () => run('signin', async () => {
    const r = await api.signIn();
    await onChanged();
    onToast(t.welcomeBack(r.account.name, r.merged));
    onClose();
  });
  const addPasskey = () => run('add', async () => { await api.addPasskey(); await onChanged(); onToast(t.passkeyAdded); });
  const removePasskey = (id: string) => {
    if (!confirm(t.removePasskeyConfirm)) return;
    run('remove', async () => { await api.removePasskey(id); await onChanged(); });
  };
  const rename = (e: React.FormEvent) => {
    e.preventDefault();
    run('rename', async () => { await api.rename(name); await onChanged(); setRenaming(false); });
  };
  const logout = () => run('logout', async () => { await api.logout(); await onChanged(); onClose(); });
  const remove = () => {
    if (!confirm(t.deleteConfirm)) return;
    run('delete', async () => { await api.deleteAccount(); await onChanged(); onClose(); });
  };

  const privacy = (
    <>
      <h4>{t.privacyTitle}</h4>
      <ul className="privacy">{t.privacy.map(p => <li key={p} className="small">{p}</li>)}</ul>
      <p className="privacy-links small">
        {collected > 0 || account ? <a className="link" href="/api/export" download>{t.exportData}</a> : null}
        <a className="link" href="/datenschutz" onClick={e => { e.preventDefault(); onClose(); history.pushState(null, '', '/datenschutz'); dispatchEvent(new PopStateEvent('popstate')); }}>{t.privacyFull}</a>
      </p>
    </>
  );

  if (!account) return (
    <Sheet title={t.account} onClose={onClose} closeLabel={t.close}>
      <p className="muted">{t.accountWhy}</p>
      {!supported ? <p className="notice">{t.noPasskeys}</p> : (
        <>
          {collected > 0 && <p className="small">{t.keepsCollection(collected)}</p>}
          <button className="btn primary wide" onClick={signIn} disabled={!!busy}>
            <PasskeyIcon /> {t.signInPasskey}
          </button>
          <form className="create" onSubmit={create}>
            <h4>{t.newHere}</h4>
            <div className="login-row">
              <input value={name} onChange={e => { setName(e.target.value); setMsg(null); }} placeholder={t.namePlaceholder}
                autoComplete="username webauthn" maxLength={30} aria-label={t.namePlaceholder} />
              <button className="btn" disabled={!!busy || name.trim().length < 2}>{t.createAccount}</button>
            </div>
            <p className="muted small">{t.nameHint}</p>
          </form>
        </>
      )}
      {msg && <p className="error small">{msg}</p>}
      {collected > 0 && (
        <div className="danger">
          <button className="link red" onClick={remove} disabled={!!busy}>{t.deleteCollection}</button>
        </div>
      )}
      {privacy}
    </Sheet>
  );

  return (
    <Sheet title={t.account} onClose={onClose} closeLabel={t.close}>
      <div className="who">
        <span className="avatar big" aria-hidden="true">{account.name.slice(0, 1).toUpperCase()}</span>
        {renaming ? (
          <form className="login-row grow" onSubmit={rename}>
            <input value={name} onChange={e => { setName(e.target.value); setMsg(null); }} maxLength={30} aria-label={t.namePlaceholder} autoFocus />
            <button className="btn small primary" disabled={!!busy}>{t.save}</button>
            <button type="button" className="btn small" onClick={() => setRenaming(false)}>{t.cancel}</button>
          </form>
        ) : (
          <div className="grow">
            <div className="muted small">{t.signedInAs}</div>
            <div className="who-name">{account.name} <button className="link small" onClick={() => { setName(account.name); setRenaming(true); }}>{t.rename}</button></div>
          </div>
        )}
      </div>
      {msg && <p className="error small">{msg}</p>}

      <h4>{t.passkeys}</h4>
      <ul className="passkeys">
        {account.passkeys.map(p => (
          <li key={p.id}>
            <PasskeyIcon />
            <div className="grow small">
              <div className="passkey-name">
                {providerName(p.provider) ?? 'Passkey'}
                {p.current && <span className="pill on">{t.currentPasskey}</span>}
                {p.synced && <span className="pill">{t.synced}</span>}
              </div>
              <div className="muted">
                {t.passkeyCreated(formatDate(p.createdAt, lang))}
                {p.lastUsedAt && ` · ${t.passkeyUsed(formatDate(p.lastUsedAt, lang))}`}
              </div>
            </div>
            {account.passkeys.length > 1 && <button className="link small red" onClick={() => removePasskey(p.id)} disabled={!!busy}>{t.remove}</button>}
          </li>
        ))}
      </ul>
      {supported && <button className="btn small" onClick={addPasskey} disabled={!!busy}><PasskeyIcon size={16} /> {t.addPasskey}</button>}
      <p className="muted small">{t.addPasskeyHint}</p>

      <div className="danger">
        <button className="link" onClick={logout} disabled={!!busy}>{t.logout}</button>
        <button className="link red" onClick={remove} disabled={!!busy}>{t.deleteAccount}</button>
      </div>
      {privacy}
    </Sheet>
  );
}
