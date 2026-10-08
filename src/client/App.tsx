import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { decode, nearest, search, MODES, type Line, type Mode, type Network, type Station } from './data';
import { api, ApiError, localToday } from './api';
import { STRINGS, formatDate, initialLang, type Lang } from './i18n';

// ── routes ─────────────────────────────────────────────────────────────────
const SLUG: Record<Mode, string> = { S: 's-bahn', U: 'u-bahn', R: 'regio', T: 'tram', B: 'bus', F: 'faehre' };
const MODE_OF_SLUG = Object.fromEntries(Object.entries(SLUG).map(([m, s]) => [s, m])) as Record<string, Mode>;
type Route = { mode: Mode | null; line: string | null };

function parseRoute(path: string): Route {
  const [slug, line] = path.split('/').filter(Boolean).map(decodeURIComponent);
  const mode = MODE_OF_SLUG[slug] ?? null;
  return { mode, line: mode && line ? line : null };
}
const routePath = (r: Route) => (r.mode ? `/${SLUG[r.mode]}${r.line ? `/${encodeURIComponent(r.line)}` : ''}` : '/');

export const MODE_COLOR: Record<Mode, string> = { S: '#008D4F', U: '#115D91', R: '#E2001A', T: '#9B1B30', B: '#95276E', F: '#0098D4' };
const SHORT: Record<Mode, string> = { S: 'S', U: 'U', R: 'RE', T: 'Tram', B: 'Bus', F: 'F' };

const key = (station: string, mode: Mode) => `${station}|${mode}`;

/** Black or white text on a line colour */
function textOn(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255];
  return 0.299 * r + 0.587 * g + 0.114 * b > 170 ? '#1a1a1a' : '#fff';
}

// ── app ────────────────────────────────────────────────────────────────────
export function App() {
  const [lang, setLang] = useState<Lang>(initialLang);
  const t = STRINGS[lang];
  const [net, setNet] = useState<Network | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [visits, setVisits] = useState<Map<string, string>>(new Map());
  const [code, setCode] = useState<string | null>(null);
  const [route, setRoute] = useState<Route>(() => parseRoute(location.pathname));
  const [query, setQuery] = useState('');
  const [near, setNear] = useState<{ status: 'loading' | 'denied' | 'unavailable' | 'ok'; at?: { lat: number; lon: number } } | null>(null);
  const [sheet, setSheet] = useState<Station | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => { document.documentElement.lang = lang; try { localStorage.setItem('lang', lang); } catch { /* */ } }, [lang]);

  const load = useCallback(async () => {
    try {
      const [raw, me] = await Promise.all([api.data(), api.me()]);
      setNet(decode(raw as Parameters<typeof decode>[0]));
      setVisits(new Map(me.visits.map(([s, m, d]) => [key(s, m), d])));
      setCode(me.code);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);
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
    const id = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(id);
  }, [toast]);

  const fail = useCallback((e: unknown) => setToast(e instanceof ApiError && e.status === 0 ? t.offline : t.error), [t]);

  /** Collect or drop a station in a mode: shown at once, undone if the server says no */
  const toggle = useCallback(async (s: Station, mode: Mode) => {
    const k = key(s.id, mode);
    const had = visits.get(k);
    setVisits(v => { const n = new Map(v); had ? n.delete(k) : n.set(k, localToday()); return n; });
    try {
      if (had) await api.uncollect(s.id, mode);
      else { const r = await api.collect(s.id, mode); setCode(r.code); }
    } catch (e) {
      setVisits(v => { const n = new Map(v); had ? n.set(k, had) : n.delete(k); return n; });
      fail(e);
    }
  }, [visits, fail]);

  const setDate = useCallback(async (s: Station, mode: Mode, date: string) => {
    const k = key(s.id, mode);
    const before = visits.get(k);
    setVisits(v => new Map(v).set(k, date));
    try { await api.collect(s.id, mode, date); } catch (e) {
      setVisits(v => { const n = new Map(v); before ? n.set(k, before) : n.delete(k); return n; });
      fail(e);
    }
  }, [visits, fail]);

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
    for (const k of visits.keys()) if (k.endsWith(`|${m}`) && net.byId.has(k.slice(0, -2))) n++;
    return n;
  }, [visits, net]);

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

  return (
    <div className="app">
      <header className="top">
        <button className="brand" onClick={() => go({ mode: null, line: null })}>
          <span className="brand-mark" aria-hidden="true">
            <span style={{ background: MODE_COLOR.S }}>S</span><span style={{ background: MODE_COLOR.U }}>U</span>
          </span>
          <span className="brand-text">{t.title}</span>
        </button>
        <button className="icon-btn" onClick={() => setAccountOpen(true)} aria-label={t.account}>
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
        </button>
      </header>

      <nav className="tabs" aria-label={t.lines}>
        <button className={`tab ${!mode ? 'on' : ''}`} onClick={() => go({ mode: null, line: null })}>{t.all}</button>
        {MODES.map(m => (
          <button key={m} className={`tab ${mode === m ? 'on' : ''}`} style={{ '--mode': MODE_COLOR[m] } as React.CSSProperties}
            onClick={() => go({ mode: m, line: null })}>
            <span className="tab-label">{t.modes[m]}</span>
            <span className="tab-count">{collectedIn(m)}/{net.count[m]}</span>
          </button>
        ))}
      </nav>

      <div className="searchbar">
        <div className="search-field">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" /><path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
          <input
            type="search" value={query} onChange={e => { setQuery(e.target.value); setNear(null); }}
            placeholder={mode ? t.searchPlaceholderMode(t.modeLong[mode]) : t.searchPlaceholder}
            aria-label={t.searchPlaceholder} autoComplete="off" spellCheck={false} enterKeyHint="search"
          />
          {query && <button className="clear" onClick={() => setQuery('')} aria-label="×">×</button>}
        </div>
        <button className={`btn nearby ${near ? 'on' : ''}`} onClick={() => (near ? setNear(null) : findNearby())} aria-label={t.nearby} aria-pressed={!!near}>
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /><circle cx="12" cy="12" r="6" fill="none" stroke="currentColor" strokeWidth="2" /><circle cx="12" cy="12" r="2" fill="currentColor" /></svg>
          <span>{t.nearby}</span>
        </button>
      </div>

      <main>
        {results ? (
          <StationList stations={results} mode={mode} visits={visits} onToggle={toggle} onOpen={setSheet} t={t} empty={t.noResults} />
        ) : near ? (
          <section>
            {near.status === 'loading' && <p className="muted pad">{t.nearbyLoading}</p>}
            {near.status === 'denied' && <p className="notice">{t.nearbyDenied}</p>}
            {near.status === 'unavailable' && <p className="notice">{t.nearbyUnavailable}</p>}
            {nearby && (
              <>
                <StationList stations={nearby.map(n => n.s)} distances={nearby.map(n => n.d)} mode={mode} visits={visits} onToggle={toggle} onOpen={setSheet} t={t} empty={t.noResults} />
                <p className="muted small pad">{t.nearbyNote}</p>
              </>
            )}
          </section>
        ) : line ? (
          <LinePage line={line} visits={visits} onToggle={toggle} onOpen={setSheet} onBack={() => go({ mode: line.mode, line: null })} t={t} />
        ) : mode ? (
          <ModePage net={net} mode={mode} visits={visits} collected={collectedIn(mode)} onLine={l => go({ mode, line: l.name })} t={t} />
        ) : (
          <Home net={net} visits={visits} collectedIn={collectedIn} onMode={m => go({ mode: m, line: null })} onOpen={setSheet} lang={lang} t={t} />
        )}
      </main>

      <footer className="foot">
        <p>{t.attribution(formatDate(net.feedDate, lang))}</p>
        <p>{t.disclaimer}</p>
        <p><button className="link" onClick={() => setLang(lang === 'de' ? 'en' : 'de')}>{t.language}</button> · <button className="link" onClick={() => setAccountOpen(true)}>{t.privacyTitle}</button></p>
      </footer>

      {sheet && <StationSheet station={sheet} visits={visits} onToggle={toggle} onDate={setDate} onClose={() => setSheet(null)} onLine={l => { setSheet(null); go({ mode: l.mode, line: l.name }); }} lang={lang} t={t} />}
      {accountOpen && <AccountSheet code={code} onClose={() => setAccountOpen(false)} onChanged={load} t={t} />}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

type T = (typeof STRINGS)['de'];

// ── pieces ─────────────────────────────────────────────────────────────────
export function LineBadge({ line, small }: { line: Line; small?: boolean }) {
  const shape = line.mode === 'U' ? 'square' : line.mode === 'S' ? 'pill' : 'tag';
  return (
    <span className={`badge ${shape} ${small ? 'small' : ''}`} style={{ background: line.color, color: textOn(line.color) }}>{line.name}</span>
  );
}

function Check({ on, color, label, onClick, big }: { on: boolean; color: string; label: string; onClick: () => void; big?: boolean }) {
  return (
    <button className={`check ${on ? 'on' : ''} ${big ? 'big' : ''}`} style={{ '--c': color } as React.CSSProperties}
      aria-pressed={on} aria-label={label} title={label} onClick={e => { e.stopPropagation(); onClick(); }}>
      {on && <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg>}
    </button>
  );
}

function ModeChip({ mode, on, label, onClick }: { mode: Mode; on: boolean; label: string; onClick: () => void }) {
  return (
    <button className={`chip ${on ? 'on' : ''}`} style={{ '--c': MODE_COLOR[mode] } as React.CSSProperties}
      aria-pressed={on} aria-label={label} title={label} onClick={e => { e.stopPropagation(); onClick(); }}>
      {on && <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" /></svg>}
      {SHORT[mode]}
    </button>
  );
}

function StationList({ stations, distances, mode, visits, onToggle, onOpen, t, empty }: {
  stations: Station[]; distances?: number[]; mode: Mode | null; visits: Map<string, string>;
  onToggle: (s: Station, m: Mode) => void; onOpen: (s: Station) => void; t: T; empty: string;
}) {
  if (!stations.length) return <p className="muted pad">{empty}</p>;
  return (
    <ul className="list">
      {stations.map((s, i) => {
        const lines = mode ? s.lines[mode] ?? [] : MODES.filter(m => m !== 'B').flatMap(m => s.lines[m] ?? []);
        return (
          <li key={s.id} className="row" onClick={() => onOpen(s)}>
            <div className="row-main">
              <div className="row-name">{s.name}</div>
              <div className="row-meta">
                {distances && <span className="dist">{t.meters(distances[i])}</span>}
                {lines.slice(0, 10).map(l => <LineBadge key={l.id} line={l} small />)}
                {lines.length > 10 && <span className="muted small">+{lines.length - 10}</span>}
                {!mode && s.modes.includes('B') && <span className="muted small">{(s.lines.B ?? []).length > 0 ? `Bus ${(s.lines.B ?? []).slice(0, 4).map(l => l.name).join(', ')}${(s.lines.B ?? []).length > 4 ? ' …' : ''}` : ''}</span>}
                {s.note && <span className="note">{t.closedNote[s.note] ?? s.note}</span>}
              </div>
            </div>
            {mode ? (
              <Check big on={visits.has(key(s.id, mode))} color={MODE_COLOR[mode]} label={(visits.has(key(s.id, mode)) ? t.uncollect : t.collect)(s.name, t.modes[mode])} onClick={() => onToggle(s, mode)} />
            ) : (
              <div className="chips">
                {s.modes.map(m => <ModeChip key={m} mode={m} on={visits.has(key(s.id, m))} label={(visits.has(key(s.id, m)) ? t.uncollect : t.collect)(s.name, t.modes[m])} onClick={() => onToggle(s, m)} />)}
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

function Home({ net, visits, collectedIn, onMode, onOpen, lang, t }: {
  net: Network; visits: Map<string, string>; collectedIn: (m: Mode) => number; onMode: (m: Mode) => void; onOpen: (s: Station) => void; lang: Lang; t: T;
}) {
  const recent = useMemo(() => [...visits.entries()]
    .map(([k, d]) => ({ s: net.byId.get(k.slice(0, -2)), m: k.slice(-1) as Mode, d }))
    .filter((v): v is { s: Station; m: Mode; d: string } => !!v.s)
    .sort((a, b) => b.d.localeCompare(a.d))
    .slice(0, 12), [visits, net]);
  return (
    <>
      <section className="cards">
        {MODES.map(m => {
          const n = collectedIn(m), total = net.count[m];
          return (
            <button key={m} className="card" onClick={() => onMode(m)} style={{ '--mode': MODE_COLOR[m] } as React.CSSProperties}>
              <div className="card-head"><span className="mode-dot" />{t.modes[m]}</div>
              <div className="card-num"><b>{n}</b> <span className="muted">/ {total}</span></div>
              <Progress value={n} total={total} color={MODE_COLOR[m]} />
            </button>
          );
        })}
      </section>
      {recent.length ? (
        <section>
          <h2>{t.recent}</h2>
          <ul className="list">
            {recent.map(({ s, m, d }) => (
              <li key={key(s.id, m)} className="row" onClick={() => onOpen(s)}>
                <span className="mode-pill" style={{ background: MODE_COLOR[m] }}>{SHORT[m]}</span>
                <div className="row-main"><div className="row-name">{s.name}</div></div>
                <span className="muted small">{formatDate(d, lang)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : <p className="hint">{t.emptyHint}</p>}
    </>
  );
}

function lineCount(l: Line, visits: Map<string, string>) {
  const all = [...l.main, ...l.more];
  return { n: all.filter(s => visits.has(key(s.id, l.mode))).length, total: all.length };
}

function ModePage({ net, mode, visits, collected, onLine, t }: {
  net: Network; mode: Mode; visits: Map<string, string>; collected: number; onLine: (l: Line) => void; t: T;
}) {
  const lines = net.linesByMode[mode];
  return (
    <>
      <section className="mode-head" style={{ '--mode': MODE_COLOR[mode] } as React.CSSProperties}>
        <div className="mode-title">{t.modes[mode]}</div>
        <div className="mode-num"><b>{collected}</b> {t.of} {net.count[mode]} {t.modeLong[mode]} {t.collected}</div>
        <Progress value={collected} total={net.count[mode]} color={MODE_COLOR[mode]} />
      </section>
      <h2>{t.lines}</h2>
      <ul className="list">
        {lines.map(l => {
          const { n, total } = lineCount(l, visits);
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

function LinePage({ line, visits, onToggle, onOpen, onBack, t }: {
  line: Line; visits: Map<string, string>; onToggle: (s: Station, m: Mode) => void; onOpen: (s: Station) => void; onBack: () => void; t: T;
}) {
  const { n, total } = lineCount(line, visits);
  const stop = (s: Station, i: number, arr: Station[]) => {
    const on = visits.has(key(s.id, line.mode));
    const others = (s.lines[line.mode] ?? []).filter(l => l.id !== line.id);
    return (
      <li key={s.id} className={`stop ${on ? 'on' : ''} ${i === 0 ? 'first' : ''} ${i === arr.length - 1 ? 'last' : ''}`} onClick={() => onOpen(s)}>
        <span className="track" aria-hidden="true" />
        <Check on={on} color={line.color} label={(on ? t.uncollect : t.collect)(s.name, line.name)} onClick={() => onToggle(s, line.mode)} />
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

function StationSheet({ station: s, visits, onToggle, onDate, onClose, onLine, lang, t }: {
  station: Station; visits: Map<string, string>; onToggle: (s: Station, m: Mode) => void; onDate: (s: Station, m: Mode, d: string) => void;
  onClose: () => void; onLine: (l: Line) => void; lang: Lang; t: T;
}) {
  const osm = `https://www.openstreetmap.org/?mlat=${s.lat}&mlon=${s.lon}#map=17/${s.lat}/${s.lon}`;
  return (
    <Sheet title={s.name} onClose={onClose} closeLabel={t.close}>
      {s.note && <p className="note block">{t.closedNote[s.note] ?? s.note}</p>}
      <ul className="sheet-modes">
        {s.modes.map(m => {
          const d = visits.get(key(s.id, m));
          return (
            <li key={m}>
              <Check big on={!!d} color={MODE_COLOR[m]} label={(d ? t.uncollect : t.collect)(s.name, t.modes[m])} onClick={() => onToggle(s, m)} />
              <div className="row-main">
                <div className="row-name">{t.modes[m]}</div>
                <div className="row-meta">
                  {d ? (
                    <label className="date">{t.collectedOn('')}
                      <input type="date" value={d} max={localToday()} onChange={e => e.target.value && onDate(s, m, e.target.value)} aria-label={t.date} />
                    </label>
                  ) : <span className="muted small">{t.notCollected}</span>}
                </div>
                {(s.lines[m] ?? []).length > 0 && (
                  <div className="row-meta wrap">
                    {(s.lines[m] ?? []).map(l => <button key={l.id} className="badge-btn" onClick={() => onLine(l)}><LineBadge line={l} small /></button>)}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <p><a href={osm} target="_blank" rel="noopener noreferrer">{t.showOnMap} ↗</a></p>
    </Sheet>
  );
}

function AccountSheet({ code, onClose, onChanged, t }: { code: string | null; onClose: () => void; onChanged: () => Promise<void>; t: T }) {
  const [input, setInput] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const login = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (clean.length !== 16) { setMsg(t.loginInvalid); return; }
    setBusy(true);
    try { await api.login(input); await onChanged(); onClose(); } catch (err) {
      setMsg(err instanceof ApiError && err.status === 404 ? t.loginBad : err instanceof ApiError && err.status === 400 ? t.loginInvalid : t.error);
    } finally { setBusy(false); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(code!); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* */ }
  };
  const logout = async () => {
    if (!confirm(t.logoutConfirm)) return;
    try { await api.logout(); await onChanged(); onClose(); } catch { setMsg(t.error); }
  };
  const remove = async () => {
    if (!confirm(t.deleteConfirm)) return;
    try { await api.deleteAccount(); await onChanged(); onClose(); } catch { setMsg(t.error); }
  };

  return (
    <Sheet title={t.account} onClose={onClose} closeLabel={t.close}>
      <p className="muted">{t.accountIntro}</p>
      {code ? (
        <div className="code-box">
          <span className="code-label">{t.yourCode}</span>
          <code className="code">{code}</code>
          <button className="btn small" onClick={copy}>{copied ? t.copied : t.copy}</button>
        </div>
      ) : <p className="notice">{t.noAccountYet}</p>}

      <form className="login" onSubmit={login}>
        <h4>{t.loginTitle}</h4>
        <p className="muted small">{t.loginHint}</p>
        <div className="login-row">
          <input value={input} onChange={e => { setInput(e.target.value); setMsg(null); }} placeholder="XXXX-XXXX-XXXX-XXXX"
            autoCapitalize="characters" autoComplete="off" spellCheck={false} aria-label={t.yourCode} />
          <button className="btn primary" disabled={busy}>{t.login}</button>
        </div>
        {msg && <p className="error small">{msg}</p>}
      </form>

      {code && (
        <div className="danger">
          <button className="link" onClick={logout}>{t.logout}</button>
          <button className="link red" onClick={remove}>{t.deleteAccount}</button>
        </div>
      )}

      <h4>{t.privacyTitle}</h4>
      <ul className="privacy">{t.privacy.map(p => <li key={p} className="small">{p}</li>)}</ul>
    </Sheet>
  );
}
