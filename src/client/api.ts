import type { Mode } from './data';

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
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
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? res.statusText);
  return data as T;
}

/** Today on this device, as the date a visit is logged under */
export const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const api = {
  data: () => call<unknown>('GET', '/api/data'),
  me: () => call<{ code: string | null; visits: [string, Mode, string][] }>('GET', '/api/me'),
  collect: (station: string, mode: Mode, date = localToday()) =>
    call<{ ok: true; code: string; date: string }>('PUT', '/api/visits', { station, mode, date }),
  uncollect: (station: string, mode: Mode) => call<{ ok: true }>('DELETE', '/api/visits', { station, mode }),
  login: (code: string) => call<{ ok: true }>('POST', '/api/login', { code }),
  logout: () => call<{ ok: true }>('POST', '/api/logout'),
  deleteAccount: () => call<{ ok: true }>('DELETE', '/api/account', {}),
};
