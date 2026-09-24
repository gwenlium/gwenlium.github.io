import { ownerHintKey } from '../../lib/editor-config';
import { readRecord, writeRecord } from './database';

type SavedAuth = {
  key: 'owner';
  // Non-extractable: scripts can ask it to sign, but nothing can copy it out of this browser.
  keys: CryptoKeyPair;
  device: string;
  token?: string;
  expiresAt?: number;
  session?: string;
};
type Issued = { token: string; expiresAt: number; session?: string };

const tokenPattern = /^ghu_[A-Za-z0-9]{1,508}$/;
const sessionLabel = 'gwenlium-editor-session-v1';
const renewMargin = 5 * 60;
const encoder = new TextEncoder();
const now = () => Math.floor(Date.now() / 1000);
const base64url = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function authFailure(message: string, status = 401): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

export interface OwnerAuth {
  readonly remembered: boolean;
  /** A valid access token, renewed quietly when it is close to expiring. */
  token(force?: boolean): Promise<string>;
  /** Must be called directly from a click: it opens the GitHub popup before any await. */
  signIn(): Promise<void>;
  /** Forget this browser's sign-in and revoke it on GitHub; `everywhere` ends every device's sign-in. Resolves with a warning if GitHub could not be told. */
  signOut(everywhere?: boolean): Promise<string | undefined>;
}

function setHint(value: boolean): void {
  try {
    if (value) localStorage.setItem(ownerHintKey, '1');
    else localStorage.removeItem(ownerHintKey);
  } catch { /* The hint only saves a page load; the saved sign-in is the source of truth. */ }
}

export function hasOwnerHint(): boolean {
  try { return localStorage.getItem(ownerHintKey) === '1'; } catch { return false; }
}

/** GitHub sign-in that stays on this device: a sealed session plus a browser-bound key renew the token. */
export class BrowserOwnerAuth implements OwnerAuth {
  private memory?: SavedAuth;
  private popup?: () => void;

  constructor(private readonly authOrigin: string, private readonly siteOrigin: string) {}

  get remembered(): boolean { return Boolean(this.memory?.session); }

  private async load(): Promise<SavedAuth | undefined> {
    try {
      const saved = await readRecord<SavedAuth>('auth', 'owner');
      if (saved && saved.keys?.privateKey instanceof CryptoKey && typeof saved.device === 'string') return saved;
    } catch { /* Private windows can refuse storage; the in-memory sign-in still works. */ }
    return this.memory;
  }

  private async save(value: SavedAuth): Promise<void> {
    this.memory = value;
    try { await writeRecord('auth', value); } catch { /* Kept in memory for this tab. */ }
    setHint(true);
  }

  async token(force = false): Promise<string> {
    const cached = this.memory;
    if (!force && cached?.token && (cached.expiresAt ?? 0) - now() > renewMargin) return cached.token;
    const renew = async () => {
      // Re-read inside the lock: another tab may have renewed while this one waited.
      const saved = await this.load();
      if (!saved) throw authFailure('Sign in with GitHub to edit the website.');
      if (saved.token && (saved.expiresAt ?? 0) - now() > renewMargin && (!force || saved.token !== cached?.token)) {
        this.memory = saved;
        return saved.token;
      }
      if (!saved.session) throw authFailure('Your sign-in expired. Sign in with GitHub again.');
      const timestamp = now();
      const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, saved.keys.privateKey, encoder.encode(`${sessionLabel}\n${saved.session}\n${timestamp}`));
      const response = await fetch(`${this.authOrigin}/editor/session`, {
        method: 'POST', mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'error',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: saved.session, timestamp, signature: base64url(signature) }),
      });
      let value: unknown;
      try { value = await response.json(); } catch { value = undefined; }
      if (!response.ok) {
        const message = (value as { error?: unknown })?.error;
        if (response.status === 401) await this.forget();
        throw authFailure(typeof message === 'string' ? message : 'Sign-in renewal failed. Try again.', response.status);
      }
      const issued = this.issued(value);
      await this.save({ ...saved, ...issued, session: issued.session ?? saved.session });
      return issued.token;
    };
    // Refresh tokens are single use: two tabs renewing at once would sign each other out.
    return 'locks' in navigator ? navigator.locks.request('gwenlium-owner-auth', renew) : renew();
  }

  private issued(value: unknown): Issued {
    const data = value as Issued;
    if (!data || typeof data !== 'object' || typeof data.token !== 'string' || !tokenPattern.test(data.token)
      || !Number.isSafeInteger(data.expiresAt) || (data.session !== undefined && (typeof data.session !== 'string' || !/^[A-Za-z0-9_-]{40,3000}$/.test(data.session)))) {
      throw authFailure('GitHub returned an invalid sign-in. Try again.');
    }
    return { token: data.token, expiresAt: data.expiresAt, session: data.session };
  }

  signIn(): Promise<void> {
    if (window.location.origin !== this.siteOrigin) return Promise.reject(authFailure('Open the editor on the website itself to sign in.', 403));
    this.popup?.();
    // Open before the first await to keep the click's popup permission.
    const popup = window.open('about:blank', '_blank', 'popup,width=640,height=760');
    if (!popup) return Promise.reject(new Error('Allow the GitHub sign-in popup, then try again.'));
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    let finished = false;
    let handshaken = false;
    let keys: CryptoKeyPair | undefined;
    let device = '';
    const cleanup = () => {
      window.removeEventListener('message', receive);
      clearTimeout(timeout);
      clearInterval(closed);
      this.popup = undefined;
      try { popup.close(); } catch { /* Already closed. */ }
    };
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (error) reject(error);
    };
    const receive = (event: MessageEvent) => {
      if (finished || event.origin !== this.authOrigin || event.source !== popup || typeof event.data !== 'string') return;
      if (event.data === 'authorizing:github') {
        try { popup.postMessage('authorizing:github', this.authOrigin); handshaken = true; }
        catch { finish(new Error('The GitHub sign-in window could not finish.')); }
        return;
      }
      if (!handshaken) return;
      if (event.data.startsWith('authorization:github:error:')) {
        let message = 'GitHub did not sign in the website owner.';
        try { const data = JSON.parse(event.data.slice('authorization:github:error:'.length)); if (typeof data.message === 'string') message = data.message; } catch { /* Keep the generic message. */ }
        finish(new Error(message));
        return;
      }
      const prefix = 'authorization:github:success:';
      if (!event.data.startsWith(prefix)) return;
      try {
        const issued = this.issued(JSON.parse(event.data.slice(prefix.length)));
        finish();
        void this.save({ key: 'owner', keys: keys!, device, ...issued }).then(resolve, reject);
      } catch (error) { finish(error instanceof Error ? error : new Error('GitHub returned an invalid sign-in.')); }
    };
    const timeout = window.setTimeout(() => finish(new Error('GitHub sign-in timed out. Try again.')), 5 * 60 * 1000);
    const closed = window.setInterval(() => { if (popup.closed) finish(new Error('GitHub sign-in was cancelled.')); }, 400);
    this.popup = () => finish(new Error('GitHub sign-in was cancelled.'));
    window.addEventListener('message', receive);
    void (async () => {
      try {
        keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
        device = base64url(await crypto.subtle.exportKey('raw', keys.publicKey));
        const url = new URL('/auth', this.authOrigin);
        url.search = new URLSearchParams({ provider: 'github', site_id: new URL(this.siteOrigin).host, device_key: device }).toString();
        if (!finished) popup.location.href = url.href;
      } catch { finish(new Error('This browser cannot create a secure sign-in key.')); }
    })();
    return promise;
  }

  private async forget(): Promise<void> {
    this.memory = undefined;
    setHint(false);
    try { await writeRecord('auth', undefined, 'owner'); } catch { /* Nothing saved. */ }
  }

  async signOut(everywhere = false): Promise<string | undefined> {
    this.popup?.();
    let warning: string | undefined;
    try {
      const token = await this.token();
      const response = await fetch(`${this.authOrigin}/editor/revoke`, {
        method: 'POST', mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'error',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ everywhere }),
      });
      if (!response.ok) warning = ((await response.json().catch(() => ({}))) as { error?: string }).error ?? 'GitHub could not be told about the sign-out.';
    } catch (error) {
      // An expired sign-in has nothing left to revoke; anything else is worth saying.
      if ((error as { status?: number }).status !== 401) warning = 'GitHub could not be reached, so the sign-in was only removed from this browser.';
    }
    await this.forget();
    return warning;
  }
}

/** The dev server's stand-in worker trusts localhost, so there is nothing to sign in to. */
export class DevOwnerAuth implements OwnerAuth {
  readonly remembered = true;
  async token(): Promise<string> { setHint(true); return 'ghu_localdevelopment'; }
  async signIn(): Promise<void> { setHint(true); }
  async signOut(): Promise<string | undefined> { setHint(false); return undefined; }
}
