import type { Mode } from './data';
// Berlin's own signs, public domain on Wikimedia Commons (see the comment in each file)
import S from './signs/S.svg' with { type: 'text' };
import U from './signs/U.svg' with { type: 'text' };
import R from './signs/R.svg' with { type: 'text' };
import T from './signs/T.svg' with { type: 'text' };
import B from './signs/B.svg' with { type: 'text' };
import F from './signs/F.svg' with { type: 'text' };

const SIGNS: Record<Mode, string> = { S, U, R, T, B, F };

/** Each mode's colour, as in its sign */
export const MODE_COLOR: Record<Mode, string> = { S: '#008D4F', U: '#0664AB', R: '#DA251D', T: '#D82020', B: '#A5027D', F: '#0080BA' };

/**
 * A mode's sign: the S-Bahn's green S, the U-Bahn's blue U, VBB's red "Bahn"
 * diamond for regional trains, the red "Tram" square, BVG's "BUS" circle and
 * ferry F. `label` makes it an image with that name (else it is decoration).
 * The markup is the app's own static files, never user input.
 */
export function ModeIcon({ mode, size = 24, label }: { mode: Mode; size?: number; label?: string }) {
  return (
    <span
      className={`mode-icon sign-${mode}`}
      style={{ width: size, height: size }}
      {...(label ? { role: 'img', 'aria-label': label, title: label } : { 'aria-hidden': true })}
      dangerouslySetInnerHTML={{ __html: SIGNS[mode] }}
    />
  );
}

/** The passkey symbol, drawn in the current colour */
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
