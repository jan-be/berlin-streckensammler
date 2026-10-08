import type { Mode } from './data';

export const MODE_COLOR: Record<Mode, string> = { S: '#008D4F', U: '#115D91', R: '#E2001A', T: '#9B1B30', B: '#95276E', F: '#0098D4' };

/**
 * Each mode's sign, drawn here: the green S circle, the blue U square, and
 * white pictograms on the mode's colour for regional trains, trams, buses and
 * ferries. `label` makes it an image with that name (else it is decoration).
 */
export function ModeIcon({ mode, size = 24, label }: { mode: Mode; size?: number; label?: string }) {
  const c = MODE_COLOR[mode];
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true };
  return (
    <svg className="mode-icon" width={size} height={size} viewBox="0 0 24 24" {...a11y}>
      {label && <title>{label}</title>}
      {mode === 'S' && (
        <>
          <circle cx="12" cy="12" r="12" fill={c} />
          <text x="12" y="17.2" textAnchor="middle" fontFamily="Arial, Helvetica, sans-serif" fontWeight="700" fontSize="16" fill="#fff">S</text>
        </>
      )}
      {mode === 'U' && (
        <>
          <rect width="24" height="24" rx="3" fill={c} />
          <text x="12" y="17.6" textAnchor="middle" fontFamily="Arial, Helvetica, sans-serif" fontWeight="700" fontSize="17" fill="#fff">U</text>
        </>
      )}
      {mode === 'R' && (
        <>
          <rect width="24" height="24" rx="5" fill={c} />
          {/* a train front: body, windscreen, lamps, the legs on the rails */}
          <rect x="6.5" y="3.5" width="11" height="13.5" rx="3.2" fill="#fff" />
          <rect x="8" y="5.6" width="8" height="4.6" rx="1" fill={c} />
          <circle cx="9.4" cy="13.8" r="1.1" fill={c} />
          <circle cx="14.6" cy="13.8" r="1.1" fill={c} />
          <path d="M9 17 7.2 20.5M15 17l1.8 3.5" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
        </>
      )}
      {mode === 'T' && (
        <>
          <rect width="24" height="24" rx="5" fill={c} />
          {/* a tram: the pantograph on top, then the car */}
          <path d="M9 3.2h6M12 3.2v2.6" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" />
          <rect x="6.5" y="5.8" width="11" height="12" rx="2.4" fill="#fff" />
          <rect x="8" y="7.6" width="8" height="4.4" rx="1" fill={c} />
          <circle cx="9.4" cy="15" r="1" fill={c} />
          <circle cx="14.6" cy="15" r="1" fill={c} />
          <path d="M9.2 17.8 8 20.5M14.8 17.8l1.2 2.7" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" />
        </>
      )}
      {mode === 'B' && (
        <>
          <rect width="24" height="24" rx="5" fill={c} />
          {/* a bus front: wide body, big windscreen, wheels below */}
          <rect x="5.5" y="4" width="13" height="13.5" rx="2.6" fill="#fff" />
          <rect x="7" y="6" width="10" height="5.6" rx="1" fill={c} />
          <circle cx="8.6" cy="14.6" r="1.05" fill={c} />
          <circle cx="15.4" cy="14.6" r="1.05" fill={c} />
          <rect x="7" y="17.5" width="2.6" height="2.6" rx="0.8" fill="#fff" />
          <rect x="14.4" y="17.5" width="2.6" height="2.6" rx="0.8" fill="#fff" />
        </>
      )}
      {mode === 'F' && (
        <>
          <rect width="24" height="24" rx="5" fill={c} />
          {/* a ferry: funnel, cabin, hull, a wave */}
          <rect x="12.6" y="5.2" width="2.2" height="3.4" rx="0.5" fill="#fff" />
          <rect x="7.8" y="8.6" width="8.6" height="4.4" rx="0.8" fill="#fff" />
          <path d="M4.5 13.6h15l-2.8 4.2H7.3Z" fill="#fff" />
          <path d="M4.5 20.2c1.2 0 1.2-.9 2.5-.9s1.3.9 2.5.9 1.2-.9 2.5-.9 1.3.9 2.5.9 1.2-.9 2.5-.9 1.3.9 2.5.9" fill="none" stroke="#fff" strokeWidth="1.2" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}

/** A small icon used in text (passkey, check), drawn in the current colour */
export function PasskeyIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="8" r="4" />
      <path d="M2.5 20c.8-3.6 3.4-5.6 6.5-5.6 1.2 0 2.3.3 3.2.8" />
      <circle cx="17.5" cy="14.5" r="2.5" />
      <path d="M17.5 17v4.5M17.5 19.5h1.8" />
    </svg>
  );
}
