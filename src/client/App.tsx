import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { decode, nearest, search, MODES, type Line, type Mode, type Network, type Station } from './data';
import { api, ApiError, cancelled, localToday, passkeysSupported, type Account } from './api';
import { STRINGS, formatDate, initialLang, type Lang, type T } from './i18n';
import { MODE_COLOR, ModeIcon, PasskeyIcon } from './icons';
import { providerName } from './passkeyProviders';

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

// ── app ────────────────────────────────────────────────────────────────────
export function App() {
  const [lang, setLang] = useState<Lang>(initialLang);
  const t = STRINGS[lang];
  const [net, setNet] = useState<Network | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [visits, setVisits] = useState<Map<string, string>>(new Map());
  const [account, setAccount] = useState<Account | null>(null);
  const [route, setRoute] = useState<Route>(() => parseRoute(location.pathname));
  const [query, setQuery] = useState('');
  const [near, setNear] = useState<{ status: 'loading' | 'denied' | 'unavailable' | 'ok'; at?: { lat: number; lon: number } } | null>(null);
  const [sheet, setSheet] = useState<Station | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [bannerGone, setBannerGone] = useState(() => readFlag(BANNER_KEY));

  useEffect(() => { document.documentElement.lang = lang; try { localStorage.setItem('lang', lang); } catch { /* */ } }, [lang]);

  const loadMe = useCallback(async () => {
    const me = await api.me();
    setVisits(new Map(me.visits.map(([s, m, d]) => [key(s, m), d])));
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
    const id = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(id);
  }, [toast]);

  const fail = useCallback((e: unknown) => {
    if (cancelled(e)) return;
    if (e instanceof ApiError) setToast(e.status === 0 ? t.offline : t.errors[e.code] ?? t.error);
    else setToast(t.error);
  }, [t]);

  /** Collect or drop a station in a mode: shown at once, undone if the server says no */
  const toggle = useCallback(async (s: Station, mode: Mode) => {
    const k = key(s.id, mode);
    const had = visits.get(k);
    setVisits(v => { const n = new Map(v); had ? n.delete(k) : n.set(k, localToday()); return n; });
    try {
      if (had) await api.uncollect(s.id, mode);
      else await api.collect(s.id, mode);
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
  const showBanner = !account && !bannerGone && visits.size >= 3 && !mode && !results && !near;

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
            <div className="banner-text">{t.saveBanner(visits.size)}</div>
            <div className="banner-actions">
              <button className="btn small primary" onClick={() => setAccountOpen(true)}>{t.saveBannerAction}</button>
              <button className="link small" onClick={() => { setFlag(BANNER_KEY); setBannerGone(true); }}>{t.later}</button>
            </div>
          </div>
        )}
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

      {sheet && <StationSheet station={sheet} visits={visits} onToggle={toggle} onDate={setDate} onClose={() => setSheet(null)} onLine={l => { setSheet(null); go({ mode: l.mode, line: l.name }); }} t={t} />}
      {accountOpen && (
        <AccountSheet account={account} collected={visits.size} lang={lang} t={t}
          onClose={() => setAccountOpen(false)} onChanged={loadMe} onToast={setToast} onError={fail} />
      )}
      {toast && <div className="toast" role="status">{toast}</div>}
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

function Check({ on, color, label, onClick, big }: { on: boolean; color: string; label: string; onClick: () => void; big?: boolean }) {
  return (
    <button className={`check ${on ? 'on' : ''} ${big ? 'big' : ''}`} style={{ '--c': color } as React.CSSProperties}
      aria-pressed={on} aria-label={label} title={label} onClick={e => { e.stopPropagation(); onClick(); }}>
      {on && <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg>}
    </button>
  );
}

/** A mode's sign as a toggle: grey until collected, then in colour with a tick */
function ModeToggle({ mode, on, label, onClick, size = 30 }: { mode: Mode; on: boolean; label: string; onClick: () => void; size?: number }) {
  return (
    <button className={`mode-toggle ${on ? 'on' : ''}`} aria-pressed={on} aria-label={label} title={label}
      onClick={e => { e.stopPropagation(); onClick(); }}>
      <ModeIcon mode={mode} size={size} />
      {on && <span className="tick" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" /></svg></span>}
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
              <Check big on={visits.has(key(s.id, mode))} color={MODE_COLOR[mode]} label={(visits.has(key(s.id, mode)) ? t.uncollect : t.collect)(s.name, t.modes[mode])} onClick={() => onToggle(s, mode)} />
            ) : (
              <div className="toggles">
                {s.modes.map(m => <ModeToggle key={m} mode={m} on={visits.has(key(s.id, m))} label={(visits.has(key(s.id, m)) ? t.uncollect : t.collect)(s.name, t.modes[m])} onClick={() => onToggle(s, m)} />)}
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
          <h2>{t.recent}</h2>
          <ul className="list">
            {recent.map(({ s, m, d }) => (
              <li key={key(s.id, m)} className="row" onClick={() => onOpen(s)}>
                <ModeIcon mode={m} size={24} label={t.modes[m]} />
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
        <div className="mode-title">
          <ModeIcon mode={mode} size={40} label={t.modes[mode]} />
          <div className="mode-num"><b>{collected}</b> {t.of} {net.count[mode]} {t.modeLong[mode]} {t.collected}</div>
        </div>
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

function StationSheet({ station: s, visits, onToggle, onDate, onClose, onLine, t }: {
  station: Station; visits: Map<string, string>; onToggle: (s: Station, m: Mode) => void; onDate: (s: Station, m: Mode, d: string) => void;
  onClose: () => void; onLine: (l: Line) => void; t: T;
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
              <ModeToggle mode={m} size={36} on={!!d} label={(d ? t.uncollect : t.collect)(s.name, t.modes[m])} onClick={() => onToggle(s, m)} />
              <div className="row-main">
                <div className="row-meta">
                  {d ? (
                    <label className="date">{t.collectedOn}
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
