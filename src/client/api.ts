import { startAuthentication, startRegistration, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import type { Mode } from './data';

export class ApiError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, 'offline');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? 'error');
  return data as T;
}

/** Today on this device, as the date a visit is logged under */
export const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export type Account = {
  name: string;
  passkeys: { id: string; createdAt: string; lastUsedAt: string | null; synced: boolean; provider: string | null; current: boolean }[];
};
type Options = { flow: string; options: Parameters<typeof startRegistration>[0]['optionsJSON'] };
type LoginOptions = { flow: string; options: Parameters<typeof startAuthentication>[0]['optionsJSON'] };

export const passkeysSupported = () => browserSupportsWebAuthn();

/** The browser's own refusal (cancelled, timed out, no passkey picked): nothing to report */
export const cancelled = (e: unknown) => e instanceof Error && (e.name === 'NotAllowedError' || e.name === 'AbortError');

export const api = {
  data: () => call<unknown>('GET', '/api/data'),
  me: () => call<{ account: Account | null; visits: [string, Mode, string][] }>('GET', '/api/me'),
  collect: (station: string, mode: Mode, date = localToday()) =>
    call<{ ok: true; date: string }>('PUT', '/api/visits', { station, mode, date }),
  uncollect: (station: string, mode: Mode) => call<{ ok: true }>('DELETE', '/api/visits', { station, mode }),

  /** A new account: the name, then the device makes a passkey */
  async createAccount(name: string) {
    const { flow, options } = await call<Options>('POST', '/api/account/create/options', { name });
    const response = await startRegistration({ optionsJSON: options });
    return call<{ ok: true; account: Account }>('POST', '/api/account/create/verify', { flow, response });
  },
  /** Sign in with any passkey of an account */
  async signIn() {
    const { flow, options } = await call<LoginOptions>('POST', '/api/login/options', {});
    const response = await startAuthentication({ optionsJSON: options });
    return call<{ ok: true; account: Account; merged: number }>('POST', '/api/login/verify', { flow, response });
  },
  /** One more passkey for the signed-in account */
  async addPasskey() {
    const { flow, options } = await call<Options>('POST', '/api/passkeys/options', {});
    const response = await startRegistration({ optionsJSON: options });
    return call<{ ok: true; account: Account }>('POST', '/api/passkeys', { flow, response });
  },
  removePasskey: (id: string) => call<{ ok: true; account: Account }>('DELETE', '/api/passkeys', { id }),
  rename: (name: string) => call<{ ok: true; account: Account }>('POST', '/api/account/name', { name }),
  logout: () => call<{ ok: true }>('POST', '/api/logout'),
  deleteAccount: () => call<{ ok: true }>('DELETE', '/api/account', {}),
};
