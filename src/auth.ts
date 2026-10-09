/**
 * Accounts with passkeys (WebAuthn, via @simplewebauthn/server).
 *
 * - Create an account: a name and a new passkey. The visitor's anonymous
 *   collection (if any) becomes the account's.
 * - Sign in: any of the account's passkeys, no name needed (discoverable
 *   credentials). What this device collected anonymously moves into the account;
 *   a different named account on this device is just signed out, never merged.
 * - Signed in: add more passkeys (another device or password manager), remove
 *   one (never the last), rename.
 */
import {
  generateAuthenticationOptions, generateRegistrationOptions,
  verifyAuthenticationResponse, verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { cleanName, newHandle, type Store, type User } from './db';

const RP_NAME = 'Berlin Streckensammler';

/**
 * Where the app is served from: ORIGIN in production; in development the
 * request's own origin when it is localhost, so any port works.
 */
export function relyingParty(req: Request) {
  const configured = process.env.ORIGIN;
  const own = req.headers.get('origin') ?? '';
  const origin = configured || (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(own) ? own : 'http://localhost:3000');
  return { origin, rpID: new URL(origin).hostname };
}

/** Challenges waiting for their answer: one process, a few minutes */
type Pending = { challenge: string; kind: 'register' | 'add' | 'login'; userId: number | null; name?: string; handle?: string; at: number };
const pending = new Map<string, Pending>();
const TTL = 5 * 60_000;
function remember(p: Omit<Pending, 'at'>): string {
  const now = Date.now();
  for (const [k, v] of pending) if (now - v.at > TTL) pending.delete(k);
  const id = crypto.randomUUID();
  pending.set(id, { ...p, at: now });
  return id;
}
function take(id: unknown): Pending | null {
  if (typeof id !== 'string') return null;
  const p = pending.get(id);
  pending.delete(id);
  return p && Date.now() - p.at <= TTL ? p : null;
}

const fromBase64url = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'));

/** What the app shows of an account */
export function accountView(store: Store, user: User | null) {
  if (!user?.name) return null;
  return {
    name: user.name,
    passkeys: store.passkeys(user.id).map(p => ({
      id: p.id, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt, synced: p.backedUp,
      // which password manager or device made it (the client knows the common ones)
      provider: p.aaguid && p.aaguid !== '00000000-0000-0000-0000-000000000000' ? p.aaguid : null,
      current: p.id === user.passkeyId,
    })),
  };
}

type Ctx = {
  store: Store;
  me: (req: Request) => User | null;
  /** the request's session token */
  token: (req: Request) => string | null;
  json: (body: unknown, init?: ResponseInit) => Response;
  error: (status: number, code: string) => Response;
  body: (req: Request) => Promise<Record<string, unknown> | null>;
  cookie: (token: string) => string;
};

export function authRoutes({ store, me, token, json, error, body, cookie }: Ctx) {
  /** Sign this browser in as `userId` (a fresh session; the old one ends) */
  const signIn = (req: Request, userId: number, passkeyId: string, extra: Record<string, unknown> = {}) => {
    const old = token(req);
    if (old) store.deleteSession(old);
    const t = store.createSession(userId, passkeyId);
    return json({ ok: true, account: accountView(store, { ...store.user(userId)!, passkeyId }), ...extra }, { headers: { 'Set-Cookie': cookie(t) } });
  };

  return {
    // ── create an account: name → passkey ──────────────────────────────────
    '/api/account/create/options': {
      POST: async (req: Request) => {
        const b = await body(req);
        if (!b) return error(415, 'json_expected');
        const name = cleanName(b.name);
        if (!name) return error(400, 'name_invalid');
        const current = me(req);
        if (current?.name) return error(409, 'signed_in');
        if (!store.nameFree(name, current?.id ?? 0)) return error(409, 'name_taken');
        const rp = relyingParty(req);
        // the account's user handle, kept with it once the passkey is made
        const handle = current ? store.handle(current.id) : newHandle();
        const options = await generateRegistrationOptions({
          rpName: RP_NAME, rpID: rp.rpID, userName: name, userDisplayName: name,
          userID: fromBase64url(handle),
          attestationType: 'none',
          authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
        });
        const flow = remember({ challenge: options.challenge, kind: 'register', userId: current?.id ?? null, name, handle });
        return json({ flow, options });
      },
    },
    '/api/account/create/verify': {
      POST: async (req: Request) => {
        const b = await body(req);
        const p = take(b?.flow);
        if (!p || p.kind !== 'register') return error(400, 'expired');
        const rp = relyingParty(req);
        let v;
        try {
          v = await verifyRegistrationResponse({
            response: b!.response as never, expectedChallenge: p.challenge,
            expectedOrigin: rp.origin, expectedRPID: rp.rpID, requireUserVerification: false,
          });
        } catch { return error(400, 'passkey_failed'); }
        if (!v.verified) return error(400, 'passkey_failed');
        // the visitor's anonymous user becomes the account (or a new one)
        const current = me(req);
        let user = current && !current.name && current.id === p.userId ? current : null;
        if (!user) user = store.createUser();
        store.handle(user.id, p.handle);
        if (!store.setName(user.id, p.name!)) return error(409, 'name_taken');
        const { credential, credentialBackedUp, aaguid } = v.registrationInfo;
        store.addPasskey(user.id, {
          id: credential.id, publicKey: credential.publicKey, counter: credential.counter,
          transports: credential.transports, backedUp: credentialBackedUp, aaguid,
        });
        return signIn(req, user.id, credential.id);
      },
    },

    // ── sign in with a passkey ─────────────────────────────────────────────
    '/api/login/options': {
      POST: async (req: Request) => {
        const rp = relyingParty(req);
        const options = await generateAuthenticationOptions({ rpID: rp.rpID, userVerification: 'preferred' });
        return json({ flow: remember({ challenge: options.challenge, kind: 'login', userId: null }), options });
      },
    },
    '/api/login/verify': {
      POST: async (req: Request) => {
        const b = await body(req);
        const p = take(b?.flow);
        if (!p || p.kind !== 'login') return error(400, 'expired');
        const response = b!.response as { id?: unknown };
        const key = typeof response?.id === 'string' ? store.passkey(response.id) : null;
        if (!key) return error(401, 'passkey_unknown');
        const rp = relyingParty(req);
        let v;
        try {
          v = await verifyAuthenticationResponse({
            response: response as never, expectedChallenge: p.challenge, expectedOrigin: rp.origin, expectedRPID: rp.rpID,
            credential: { id: key.id, publicKey: new Uint8Array(key.publicKey), counter: key.counter, transports: key.transports as never },
            requireUserVerification: false,
          });
        } catch { return error(401, 'passkey_failed'); }
        if (!v.verified) return error(401, 'passkey_failed');
        store.usePasskey(key.id, v.authenticationInfo.newCounter);
        // what this device collected without an account comes along
        const current = me(req);
        let merged = 0;
        if (current && !current.name && current.id !== key.userId) {
          merged = store.countEntries(current.id);
          store.mergeInto(current.id, key.userId);
        }
        return signIn(req, key.userId, key.id, { merged });
      },
    },

    // ── more passkeys for the signed-in account ────────────────────────────
    '/api/passkeys/options': {
      POST: async (req: Request) => {
        const u = me(req);
        if (!u?.name) return error(401, 'not_signed_in');
        const rp = relyingParty(req);
        const options = await generateRegistrationOptions({
          rpName: RP_NAME, rpID: rp.rpID, userName: u.name, userDisplayName: u.name,
          userID: fromBase64url(store.handle(u.id)),
          attestationType: 'none',
          excludeCredentials: store.passkeys(u.id).map(k => ({ id: k.id, transports: k.transports as never })),
          authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
        });
        return json({ flow: remember({ challenge: options.challenge, kind: 'add', userId: u.id }), options });
      },
    },
    '/api/passkeys': {
      POST: async (req: Request) => {
        const u = me(req);
        const b = await body(req);
        const p = take(b?.flow);
        if (!u?.name) return error(401, 'not_signed_in');
        if (!p || p.kind !== 'add' || p.userId !== u.id) return error(400, 'expired');
        const rp = relyingParty(req);
        let v;
        try {
          v = await verifyRegistrationResponse({
            response: b!.response as never, expectedChallenge: p.challenge,
            expectedOrigin: rp.origin, expectedRPID: rp.rpID, requireUserVerification: false,
          });
        } catch { return error(400, 'passkey_failed'); }
        if (!v.verified) return error(400, 'passkey_failed');
        const { credential, credentialBackedUp, aaguid } = v.registrationInfo;
        if (store.passkey(credential.id)) return error(409, 'passkey_exists');
        store.addPasskey(u.id, {
          id: credential.id, publicKey: credential.publicKey, counter: credential.counter,
          transports: credential.transports, backedUp: credentialBackedUp, aaguid,
        });
        return json({ ok: true, account: accountView(store, u) });
      },
      DELETE: async (req: Request) => {
        const u = me(req);
        const b = await body(req);
        if (!u?.name) return error(401, 'not_signed_in');
        if (typeof b?.id !== 'string') return error(400, 'id_expected');
        if (!store.removePasskey(u.id, b.id)) return error(409, 'last_passkey');
        return json({ ok: true, account: accountView(store, u) });
      },
    },

    // ── rename ─────────────────────────────────────────────────────────────
    '/api/account/name': {
      POST: async (req: Request) => {
        const u = me(req);
        if (!u?.name) return error(401, 'not_signed_in');
        const name = cleanName((await body(req))?.name);
        if (!name) return error(400, 'name_invalid');
        if (!store.setName(u.id, name)) return error(409, 'name_taken');
        return json({ ok: true, account: accountView(store, { ...store.user(u.id)!, passkeyId: u.passkeyId }) });
      },
    },
  };
}
