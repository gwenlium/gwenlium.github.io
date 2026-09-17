interface Env {
  SITE_ORIGIN: string;
  AUTH_ORIGIN?: string;
  ALLOWED_USER_ID: string;
  GITHUB_REPOSITORY_ID: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  OAUTH_STATE_SECRET?: string;
}

interface Configuration {
  siteOrigin: string;
  authOrigin: string;
  siteId: string;
  callbackUri: string;
  userId: number;
  repositoryId: number;
  clientId: string;
  clientSecret: string;
  stateSecret: string;
}

interface Attempt {
  version: 1;
  state: string;
  verifier: string;
  issuedAt: number;
  expiresAt: number;
  callbackUri: string;
  siteOrigin: string;
  clientId: string;
}

const COOKIE_NAME = '__Host-gwenlium-cms-oauth';
const ATTEMPT_SECONDS = 600;
const COOKIE_ATTRIBUTES = 'Path=/; Secure; HttpOnly; SameSite=Lax';
const CLEAR_COOKIE = `${COOKIE_NAME}=; ${COOKIE_ATTRIBUTES}; Max-Age=0`;
const GITHUB_API = 'https://api.github.com';
const encoder = new TextEncoder();

class OAuthError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function origin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value ? value : undefined;
  } catch {
    return undefined;
  }
}

function configuration(env: Env): Configuration | undefined {
  const siteOrigin = origin(env.SITE_ORIGIN);
  const authOrigin = origin(env.AUTH_ORIGIN);
  const userId = Number(env.ALLOWED_USER_ID);
  const repositoryId = Number(env.GITHUB_REPOSITORY_ID);
  if (
    !siteOrigin || !authOrigin || siteOrigin === authOrigin ||
    !/^[1-9]\d*$/.test(env.ALLOWED_USER_ID) || !Number.isSafeInteger(userId) ||
    !/^[1-9]\d*$/.test(env.GITHUB_REPOSITORY_ID) || !Number.isSafeInteger(repositoryId) ||
    !env.GITHUB_CLIENT_ID || env.GITHUB_CLIENT_ID !== env.GITHUB_CLIENT_ID.trim() ||
    !env.GITHUB_CLIENT_SECRET || env.GITHUB_CLIENT_SECRET !== env.GITHUB_CLIENT_SECRET.trim() ||
    !env.OAUTH_STATE_SECRET || encoder.encode(env.OAUTH_STATE_SECRET).length < 32
  ) return undefined;
  return {
    siteOrigin,
    authOrigin,
    siteId: new URL(siteOrigin).host,
    callbackUri: `${authOrigin}/callback`,
    userId,
    repositoryId,
    clientId: env.GITHUB_CLIENT_ID,
    clientSecret: env.GITHUB_CLIENT_SECRET,
    stateSecret: env.OAUTH_STATE_SECRET,
  };
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid encoding');
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
}

function randomValue(length = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(length)));
}

function stateKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
  );
}

function signedBytes(payload: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(`gwenlium-cms-oauth-v1\0${payload}`);
}

async function signAttempt(attempt: Attempt, secret: string): Promise<string> {
  const payload = base64url(encoder.encode(JSON.stringify(attempt)));
  const signature = await crypto.subtle.sign('HMAC', await stateKey(secret), signedBytes(payload));
  return `${payload}.${base64url(new Uint8Array(signature))}`;
}

function cookieValue(request: Request): string | undefined {
  const matches = (request.headers.get('Cookie') ?? '').split(';')
    .map(part => part.trim())
    .filter(part => part.startsWith(`${COOKIE_NAME}=`));
  return matches.length === 1 ? matches[0].slice(COOKIE_NAME.length + 1) : undefined;
}

function singleParameter(url: URL, name: string): string | undefined {
  const values = url.searchParams.getAll(name);
  return values.length === 1 ? values[0] : undefined;
}

async function verifyAttempt(request: Request, url: URL, config: Configuration): Promise<Attempt> {
  const failure = new OAuthError('This sign-in attempt is invalid or expired. Start again from the editor.', 400);
  const cookie = cookieValue(request);
  const state = singleParameter(url, 'state');
  if (!cookie || cookie.length > 3000 || !state || !/^[A-Za-z0-9_-]{43}$/.test(state)) throw failure;
  try {
    const parts = cookie.split('.');
    if (parts.length !== 2) throw failure;
    const [payload, signature] = parts;
    if (!/^[A-Za-z0-9_-]{43}$/.test(signature)) throw failure;
    const valid = await crypto.subtle.verify(
      'HMAC', await stateKey(config.stateSecret), fromBase64url(signature), signedBytes(payload),
    );
    if (!valid) throw failure;
    const attempt = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fromBase64url(payload))));
    const now = Math.floor(Date.now() / 1000);
    if (
      !attempt || attempt.version !== 1 || attempt.state !== state ||
      typeof attempt.verifier !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(attempt.verifier) ||
      typeof attempt.issuedAt !== 'number' || !Number.isSafeInteger(attempt.issuedAt) ||
      typeof attempt.expiresAt !== 'number' || !Number.isSafeInteger(attempt.expiresAt) ||
      attempt.issuedAt > now || attempt.expiresAt !== attempt.issuedAt + ATTEMPT_SECONDS ||
      attempt.expiresAt <= now || attempt.callbackUri !== config.callbackUri ||
      attempt.siteOrigin !== config.siteOrigin || attempt.clientId !== config.clientId
    ) throw failure;
    return attempt as unknown as Attempt;
  } catch {
    throw failure;
  }
}

function headers(nonce?: string): Headers {
  return new Headers({
    'Cache-Control': 'no-store, max-age=0',
    'Pragma': 'no-cache',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Strict-Transport-Security': 'max-age=31536000',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': `default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; script-src ${nonce ? `'nonce-${nonce}'` : "'none'"}`,
  });
}

function textResponse(message: string, status: number, clearCookie = false): Response {
  const responseHeaders = headers();
  responseHeaders.set('Content-Type', 'text/plain; charset=utf-8');
  if (clearCookie) responseHeaders.set('Set-Cookie', CLEAR_COOKIE);
  return new Response(message, { status, headers: responseHeaders });
}

function scriptData(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, char =>
    `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]!);
}

function popupResponse(config: Configuration, result: { token: string } | { message: string }, status: number): Response {
  const success = 'token' in result;
  const payload = success ? { token: result.token, provider: 'github' } : { message: result.message };
  const message = `authorization:github:${success ? 'success' : 'error'}:${JSON.stringify(payload)}`;
  const nonce = randomValue();
  const responseHeaders = headers(nonce);
  responseHeaders.set('Content-Type', 'text/html; charset=utf-8');
  // The provider consumes authorization codes once; clearing the browser-bound attempt also
  // prevents ordinary callback replay, without keeping tokens or OAuth sessions in storage.
  responseHeaders.set('Set-Cookie', CLEAR_COOKIE);
  return new Response(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Website sign-in</title></head>
<body>
<h1>Website sign-in</h1>
<p id="status" role="status">Returning the sign-in result to the editor…</p>
<p><a href="${escapeHtml(config.siteOrigin)}/admin/" rel="noreferrer noopener">Return to the editor</a></p>
<script nonce="${nonce}">
(() => {
  const siteOrigin = ${scriptData(config.siteOrigin)};
  let message = ${scriptData(message)};
  const opener = window.opener;
  const status = document.getElementById('status');
  let timeout;
  try { history.replaceState(null, '', '/callback'); } catch {}
  const cleanUp = () => {
    message = '';
    clearTimeout(timeout);
    window.removeEventListener('message', receive);
  };
  const recover = () => {
    cleanUp();
    status.textContent = 'The editor window is unavailable. Return to the editor and sign in again.';
  };
  const receive = (event) => {
    if (event.source !== opener || event.origin !== siteOrigin || event.data !== 'authorizing:github' || !message) return;
    try {
      if (!opener || opener.closed) return recover();
      opener.postMessage(message, siteOrigin);
      cleanUp();
      status.textContent = ${scriptData(success ? 'Sign-in complete. You can close this window.' : 'Sign-in was not completed. Return to the editor to try again.')};
      setTimeout(() => window.close(), 150);
    } catch { recover(); }
  };
  window.addEventListener('pagehide', cleanUp, { once: true });
  if (!opener || opener.closed) return recover();
  window.addEventListener('message', receive);
  timeout = setTimeout(recover, 30000);
  try { opener.postMessage('authorizing:github', siteOrigin); } catch { recover(); }
})();
</script>
</body></html>`, { status, headers: responseHeaders });
}

async function startAuthorization(request: Request, url: URL, config: Configuration): Promise<Response> {
  if (singleParameter(url, 'provider') !== 'github' || singleParameter(url, 'site_id') !== config.siteId) {
    return textResponse('Invalid authentication provider or site.', 400);
  }
  const requestOrigin = request.headers.get('Origin');
  if (requestOrigin !== null && requestOrigin !== config.siteOrigin) {
    return textResponse('This site cannot initiate editor sign-in.', 403);
  }
  const now = Math.floor(Date.now() / 1000);
  const attempt: Attempt = {
    version: 1,
    state: randomValue(),
    verifier: randomValue(64),
    issuedAt: now,
    expiresAt: now + ATTEMPT_SECONDS,
    callbackUri: config.callbackUri,
    siteOrigin: config.siteOrigin,
    clientId: config.clientId,
  };
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(attempt.verifier))));
  const authorize = new URL('https://github.com/login/oauth/authorize');
  // A GitHub App uses its installed permissions, never caller-provided OAuth scopes.
  authorize.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.callbackUri,
    state: attempt.state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    allow_signup: 'false',
  }).toString();
  const responseHeaders = headers();
  responseHeaders.set('Location', authorize.href);
  responseHeaders.set('Set-Cookie', `${COOKIE_NAME}=${await signAttempt(attempt, config.stateSecret)}; ${COOKIE_ATTRIBUTES}; Max-Age=${ATTEMPT_SECONDS}`);
  return new Response(null, { status: 302, headers: responseHeaders });
}

async function githubJson(url: string, options: RequestInit): Promise<Record<string, unknown>> {
  try {
    const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('GitHub request failed');
    const body = record(await response.json());
    if (!body) throw new Error('Invalid GitHub response');
    return body;
  } catch {
    throw new OAuthError('GitHub could not complete sign-in. Please try again from the editor.', 502);
  }
}

function githubHeaders(token: string): HeadersInit {
  return {
    'Accept': 'application/vnd.github+json',
    'Authorization': `Bearer ${token}`,
    'X-GitHub-Api-Version': '2026-03-10',
    'User-Agent': 'gwenlium-cms-auth',
  };
}

async function verifyRepository(token: string, config: Configuration): Promise<void> {
  const options = { headers: githubHeaders(token) };
  const result = await githubJson(`${GITHUB_API}/user/installations?per_page=100`, options);
  const installations = result.installations;
  const failure = new OAuthError('The GitHub App must be installed only on the website repository with the required editing permissions.', 403);
  // repository_id can be ignored by GitHub when the app cannot access that repository.
  // Public repository metadata alone is not evidence of an authorized installation.
  if (result.total_count !== 1 || !Array.isArray(installations) || installations.length !== 1) throw failure;
  const installation = record(installations[0]);
  const permissions = record(installation?.permissions);
  if (
    !installation || !Number.isSafeInteger(installation.id) || Number(installation.id) <= 0 ||
    record(installation.account)?.id !== config.userId || installation.repository_selection !== 'selected' ||
    installation.suspended_at !== null || !permissions ||
    permissions.contents !== 'write' || permissions.metadata !== 'read' ||
    Object.keys(permissions).some(name => name !== 'contents' && name !== 'metadata')
  ) throw failure;
  const repositories = await githubJson(`${GITHUB_API}/user/installations/${installation.id}/repositories?per_page=100`, options);
  if (
    repositories.total_count !== 1 || !Array.isArray(repositories.repositories) ||
    repositories.repositories.length !== 1 || record(repositories.repositories[0])?.id !== config.repositoryId
  ) throw failure;
}

async function completeAuthorization(request: Request, url: URL, config: Configuration): Promise<Response> {
  try {
    const attempt = await verifyAttempt(request, url, config);
    if (url.searchParams.has('error')) {
      throw new OAuthError('GitHub authorization was not completed. Please try again from the editor.', 403);
    }
    const code = singleParameter(url, 'code');
    if (!code || code.length > 512 || !/^[A-Za-z0-9_-]+$/.test(code)) {
      throw new OAuthError('GitHub did not supply a valid authorization code. Start again from the editor.', 400);
    }
    const result = await githubJson('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'gwenlium-cms-auth',
      },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        code_verifier: attempt.verifier,
        redirect_uri: config.callbackUri,
        repository_id: String(config.repositoryId),
      }),
    });
    const token = result.access_token;
    // Do not accept broad OAuth-app tokens or non-expiring user tokens. Refresh tokens
    // returned by GitHub are deliberately discarded; the editor signs in again on expiry.
    if (
      result.error || typeof token !== 'string' || !/^ghu_[A-Za-z0-9]{1,508}$/.test(token) ||
      result.token_type !== 'bearer' || result.scope !== '' ||
      typeof result.expires_in !== 'number' || !Number.isSafeInteger(result.expires_in) ||
      result.expires_in <= 0 || result.expires_in > 28800
    ) throw new OAuthError('GitHub did not issue an expiring GitHub App token. Check the app settings and sign in again.', 502);
    const user = await githubJson(`${GITHUB_API}/user`, { headers: githubHeaders(token) });
    if (user.id !== config.userId) {
      throw new OAuthError('This GitHub account is not allowed to edit this website.', 403);
    }
    await verifyRepository(token, config);
    return popupResponse(config, { token }, 200);
  } catch (error) {
    return popupResponse(config, {
      message: error instanceof OAuthError ? error.message : 'Sign-in could not be completed. Start again from the editor.',
    }, error instanceof OAuthError ? error.status : 500);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const callback = url.pathname === '/callback';
    if (!['/auth', '/callback', '/health'].includes(url.pathname)) return textResponse('Not found.', 404);
    if (request.method !== 'GET') {
      const response = textResponse('Method not allowed.', 405, callback);
      response.headers.set('Allow', 'GET');
      return response;
    }
    if (url.protocol !== 'https:') return textResponse('HTTPS is required.', 400, callback);
    const config = configuration(env);
    if (url.pathname === '/health') {
      const responseHeaders = headers();
      responseHeaders.set('Content-Type', 'application/json; charset=utf-8');
      return new Response(JSON.stringify({ ready: Boolean(config) }), {
        status: config ? 200 : 503,
        headers: responseHeaders,
      });
    }
    if (!config) return textResponse('Editor sign-in is unavailable until its configuration is complete.', 503, callback);
    if (url.origin !== config.authOrigin) return textResponse('Invalid authentication origin.', 400, callback);
    try {
      return callback
        ? await completeAuthorization(request, url, config)
        : await startAuthorization(request, url, config);
    } catch {
      return textResponse('Editor sign-in is temporarily unavailable.', 500, callback);
    }
  },
};
