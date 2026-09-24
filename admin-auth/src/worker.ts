import { contentPath, decodeBase64, EditorError, maxRequestBytes, maxTextBytes, mediaFilePattern, previewRegistry, publishPayload, registryPath, shaPattern, validateContent } from './editor-content';
import type { EditorFileInfo, EditorMediaEntry, EditorOwner } from '../../src/lib/editor-types';

interface Env {
  SITE_ORIGIN: string;
  AUTH_ORIGIN?: string;
  ALLOWED_USER_ID: string;
  GITHUB_REPOSITORY_ID: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  OAUTH_STATE_SECRET?: string;
  CF_ANALYTICS_ACCOUNT_ID?: string;
  CF_ANALYTICS_API_TOKEN?: string;
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
  version: 2;
  state: string;
  verifier: string;
  issuedAt: number;
  expiresAt: number;
  callbackUri: string;
  siteOrigin: string;
  clientId: string;
  device: string;
}

/** Sealed with AES-GCM; only this worker can open it, and only the browser key that signed in can use it. */
interface OwnerSession {
  version: 1;
  userId: number;
  refreshToken: string;
  refreshExpiresAt: number;
  device: string;
}

interface IssuedToken {
  token: string;
  expiresAt: number;
  session?: string;
}

const COOKIE_NAME = '__Host-gwenlium-cms-oauth';
const ATTEMPT_SECONDS = 600;
// A P-256 public key in uncompressed form is 65 bytes, which is 87 base64url characters.
const devicePattern = /^[A-Za-z0-9_-]{87}$/;
const refreshPattern = /^ghr_[A-Za-z0-9]{1,508}$/;
const SESSION_CLOCK_SKEW = 300;
const SESSION_LABEL = 'gwenlium-editor-session-v1';
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

async function sessionKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(SESSION_LABEL), info: encoder.encode('owner session seal') },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

async function sealSession(session: OwnerSession, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(SESSION_LABEL) },
    await sessionKey(secret), encoder.encode(JSON.stringify(session)),
  ));
  const output = new Uint8Array(iv.length + sealed.length);
  output.set(iv);
  output.set(sealed, iv.length);
  return base64url(output);
}

async function openSession(value: unknown, config: Configuration): Promise<OwnerSession> {
  const failure = new OAuthError('Your saved sign-in is no longer valid. Sign in again.', 401);
  if (typeof value !== 'string' || value.length < 40 || value.length > 3000) throw failure;
  let session: Record<string, unknown> | undefined;
  try {
    const bytes = fromBase64url(value);
    const opened = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: encoder.encode(SESSION_LABEL) },
      await sessionKey(config.stateSecret), bytes.slice(12),
    );
    session = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(opened)));
  } catch { throw failure; }
  if (
    !session || session.version !== 1 || session.userId !== config.userId ||
    typeof session.refreshToken !== 'string' || !refreshPattern.test(session.refreshToken) ||
    typeof session.refreshExpiresAt !== 'number' || !Number.isSafeInteger(session.refreshExpiresAt) ||
    session.refreshExpiresAt <= Math.floor(Date.now() / 1000) ||
    typeof session.device !== 'string' || !devicePattern.test(session.device)
  ) throw failure;
  return session as unknown as OwnerSession;
}

function deviceKey(device: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', fromBase64url(device), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
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
      !attempt || attempt.version !== 2 || attempt.state !== state ||
      typeof attempt.device !== 'string' || !devicePattern.test(attempt.device) ||
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

function popupResponse(config: Configuration, result: IssuedToken | { message: string }, status: number): Response {
  const success = 'token' in result;
  const payload = success ? { provider: 'github', ...result } : { message: result.message };
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
<p><a href="${escapeHtml(config.siteOrigin)}/write/" rel="noreferrer noopener">Return to the editor</a></p>
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
  // The editor's browser-held key: the saved session only ever works with this key's signatures.
  const device = singleParameter(url, 'device_key');
  if (!device || !devicePattern.test(device)) return textResponse('Reload the editor and sign in again.', 400);
  try { await deviceKey(device); } catch { return textResponse('Reload the editor and sign in again.', 400); }
  const now = Math.floor(Date.now() / 1000);
  const attempt: Attempt = {
    version: 2,
    device,
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

async function githubJson(url: string, options: RequestInit, refUpdate = false): Promise<Record<string, unknown>> {
  const path = new URL(url).pathname;
  const step = path === '/login/oauth/access_token' ? 'token exchange'
    : path === '/user' ? 'account verification'
    : path === '/user/installations' ? 'installation verification' : 'repository verification';
  try {
    const response = await fetch(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(15000) });
    if (!response.ok) {
      if (refUpdate && [409, 422].includes(response.status)) throw new EditorError('The branch changed or rejected this publish. Refresh and review your draft before publishing again.', 409);
      const status = path === '/user' && [401, 403].includes(response.status) ? response.status : 502;
      throw new OAuthError(`GitHub ${step} failed (HTTP ${response.status}). Please try again from the editor.`, status);
    }
    const body = record(await response.json());
    if (!body) throw new OAuthError(`GitHub returned an invalid ${step} response. Please try again from the editor.`, 502);
    return body;
  } catch (error) {
    if (error instanceof OAuthError || error instanceof EditorError) throw error;
    throw new OAuthError(`GitHub ${step} could not be reached. Please try again from the editor.`, 502);
  }
}

/** GitHub endpoints that answer with a JSON array (githubJson accepts objects only). */
async function githubList(url: string, token: string): Promise<unknown[]> {
  let response: Response;
  try { response = await fetch(url, { headers: githubHeaders(token), redirect: 'manual', signal: AbortSignal.timeout(15000) }); }
  catch { throw new EditorError('GitHub could not be reached. Try again.', 502); }
  const value: unknown = response.ok ? await response.json().catch(() => undefined) : undefined;
  if (!Array.isArray(value)) throw new EditorError(`GitHub did not return the list (HTTP ${response.status}).`, 502);
  return value;
}

function githubHeaders(token: string): HeadersInit {
  return {
    'Accept': 'application/vnd.github+json',
    'Authorization': `Bearer ${token}`,
    'X-GitHub-Api-Version': '2026-03-10',
    'User-Agent': 'gwenlium-cms-auth',
  };
}

/**
 * Short-lived, per-isolate memory. Git objects are immutable, so trees and blobs are cached by SHA;
 * owner checks are reused for a minute. Every GitHub call still uses the caller's own token.
 */
const memory = {
  owners: new Map<string, { login: string; until: number }>(),
  identity: undefined as { name: string; branch: string; until: number } | undefined,
  trees: new Map<string, { treeSha: string; entries: Map<string, EditorTreeEntry> }>(),
  blobs: new Map<string, string>(),
  blobBytes: 0,
};

async function tokenKey(token: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(token))));
}

function remember<K, V>(map: Map<K, V>, key: K, value: V, limit: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value as K);
}

/** The signed-in account must be the owner, with the app installed only on the website repository. */
async function verifiedOwner(token: string, config: Configuration): Promise<string> {
  const key = await tokenKey(token);
  const cached = memory.owners.get(key);
  if (cached && cached.until > Date.now()) return cached.login;
  const user = await githubJson(`${GITHUB_API}/user`, { headers: githubHeaders(token) });
  if (user.id !== config.userId) throw new EditorError('This GitHub account is not allowed to edit this website.', 403);
  await verifyRepository(token, config);
  const login = typeof user.login === 'string' ? user.login.slice(0, 100) : '';
  remember(memory.owners, key, { login, until: Date.now() + 60_000 }, 20);
  return login;
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

function tokenRequest(config: Configuration, parameters: Record<string, string>): Promise<Record<string, unknown>> {
  return githubJson('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'gwenlium-cms-auth',
    },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...parameters }),
  });
}

/** Validate a GitHub token response, re-verify the owner, and seal its refresh token for the signing browser. */
async function issueToken(result: Record<string, unknown>, config: Configuration, device: string): Promise<IssuedToken> {
  if (result.error === 'bad_refresh_token') throw new OAuthError('Your saved sign-in expired. Sign in again.', 401);
  const token = result.access_token;
  // Do not accept broad OAuth-app tokens or non-expiring user tokens.
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
  const now = Math.floor(Date.now() / 1000);
  const issued: IssuedToken = { token, expiresAt: now + result.expires_in };
  const refreshToken = result.refresh_token;
  const refreshSeconds = result.refresh_token_expires_in;
  // Without a refresh token (app setting) the editor still works; it just asks again after the token expires.
  if (typeof refreshToken === 'string' && refreshPattern.test(refreshToken) &&
    typeof refreshSeconds === 'number' && Number.isSafeInteger(refreshSeconds) && refreshSeconds > 0 && refreshSeconds <= 366 * 86400) {
    issued.session = await sealSession({ version: 1, userId: config.userId, refreshToken, refreshExpiresAt: now + refreshSeconds, device }, config.stateSecret);
  }
  return issued;
}

async function renewSession(request: Request, config: Configuration): Promise<Response> {
  const body = record(await requestJson(request, 4096));
  if (!body || Object.keys(body).some(key => !['session', 'timestamp', 'signature'].includes(key))) throw new EditorError('Invalid sign-in renewal.');
  const session = await openSession(body.session, config);
  const timestamp = body.timestamp;
  const now = Math.floor(Date.now() / 1000);
  if (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > SESSION_CLOCK_SKEW ||
    typeof body.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(body.signature)) throw new OAuthError('Your saved sign-in is no longer valid. Sign in again.', 401);
  // Proof that the request comes from the browser that signed in: a copied session alone is useless.
  const signed = encoder.encode(`${SESSION_LABEL}\n${body.session}\n${timestamp}`);
  const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, await deviceKey(session.device), fromBase64url(body.signature), signed);
  if (!valid) throw new OAuthError('Your saved sign-in is no longer valid. Sign in again.', 401);
  const result = await tokenRequest(config, { grant_type: 'refresh_token', refresh_token: session.refreshToken });
  return analyticsJson(await issueToken(result, config, session.device), 200, config);
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
    const result = await tokenRequest(config, {
      code,
      code_verifier: attempt.verifier,
      redirect_uri: config.callbackUri,
      repository_id: String(config.repositoryId),
    });
    return popupResponse(config, await issueToken(result, config, attempt.device), 200);
  } catch (error) {
    return popupResponse(config, {
      message: error instanceof OAuthError ? error.message : 'Sign-in could not be completed. Start again from the editor.',
    }, error instanceof OAuthError ? error.status : 500);
  }
}

interface AnalyticsGroup {
  count: number;
  sum?: { visits: number };
  dimensions?: Record<string, string>;
}

function analyticsJson(value: unknown, status: number, config: Configuration): Response {
  const responseHeaders = headers();
  responseHeaders.set('Content-Type', 'application/json; charset=utf-8');
  responseHeaders.set('Access-Control-Allow-Origin', config.siteOrigin);
  responseHeaders.set('Vary', 'Origin');
  return new Response(JSON.stringify(value), { status, headers: responseHeaders });
}

async function analytics(request: Request, url: URL, env: Env, config: Configuration): Promise<Response> {
  // Never expose a private report or CORS permission to another origin.
  if (request.headers.get('Origin') !== config.siteOrigin) return textResponse('Origin not allowed.', 403);
  if (request.method === 'OPTIONS') {
    const requestedHeaders = (request.headers.get('Access-Control-Request-Headers') ?? '').toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
    if (request.headers.get('Access-Control-Request-Method') !== 'GET' || requestedHeaders.some(value => value !== 'authorization')) {
      return analyticsJson({ error: 'Invalid preflight.' }, 403, config);
    }
    const responseHeaders = headers();
    responseHeaders.set('Access-Control-Allow-Origin', config.siteOrigin);
    responseHeaders.set('Access-Control-Allow-Methods', 'GET');
    responseHeaders.set('Access-Control-Allow-Headers', 'Authorization');
    responseHeaders.set('Vary', 'Origin');
    return new Response(null, { status: 204, headers: responseHeaders });
  }
  if (request.method !== 'GET') return analyticsJson({ error: 'Method not allowed.' }, 405, config);
  const authorization = request.headers.get('Authorization') ?? '';
  if (!/^Bearer ghu_[A-Za-z0-9]{1,508}$/.test(authorization)) return analyticsJson({ error: 'Sign in to the editor.' }, 401, config);
  const daysText = singleParameter(url, 'days') ?? (url.searchParams.has('days') ? '' : '30');
  if (!['1', '7', '30'].includes(daysText)) return analyticsJson({ error: 'Choose 1, 7 or 30 days.' }, 400, config);
  try {
    const token = authorization.slice(7);
    const user = await githubJson(`${GITHUB_API}/user`, { headers: githubHeaders(token) });
    if (user.id !== config.userId) return analyticsJson({ error: 'This account cannot view site analytics.' }, 403, config);
    await verifyRepository(token, config);
    if (!env.CF_ANALYTICS_API_TOKEN || !/^[a-f0-9]{32}$/i.test(env.CF_ANALYTICS_ACCOUNT_ID ?? '')) {
      return analyticsJson({ error: 'Analytics is not connected yet.' }, 503, config);
    }
    const end = new Date();
    const start = new Date(end);
    start.setUTCHours(0, 0, 0, 0);
    start.setUTCDate(start.getUTCDate() - Number(daysText) + 1);
    // Account and exact hostname are server-owned; callers cannot query another website.
    const filter = 'filter: { requestHost: $host, datetime_geq: $start, datetime_lt: $end }';
    const query = `query SiteAnalytics($account: String!, $host: String!, $start: Time!, $end: Time!) {
      viewer { accounts(filter: { accountTag: $account }) {
        totals: rumPageloadEventsAdaptiveGroups(limit: 1, ${filter}) { count sum { visits } }
        daily: rumPageloadEventsAdaptiveGroups(limit: 31, orderBy: [date_ASC], ${filter}) { count dimensions { date } }
        pages: rumPageloadEventsAdaptiveGroups(limit: 10, orderBy: [count_DESC], ${filter}) { count dimensions { requestPath } }
        referrers: rumPageloadEventsAdaptiveGroups(limit: 10, orderBy: [count_DESC], ${filter}) { count dimensions { refererHost } }
      } }
    }`;
    const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${env.CF_ANALYTICS_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: {
        account: env.CF_ANALYTICS_ACCOUNT_ID,
        host: config.siteId, start: start.toISOString(), end: end.toISOString(),
      } }),
    });
    if (!response.ok) return analyticsJson({ error: 'The analytics provider is unavailable.' }, 502, config);
    const body = record(await response.json());
    const accounts = record(record(body?.data)?.viewer)?.accounts;
    const account = Array.isArray(accounts) && accounts.length === 1 ? record(accounts[0]) : undefined;
    if ((Array.isArray(body?.errors) && body.errors.length) || !account) return analyticsJson({ error: 'The analytics query could not be completed.' }, 502, config);
    function groups(name: string, dimension?: string): AnalyticsGroup[] {
      const values = account![name];
      if (!Array.isArray(values) || values.some(value => !record(value) || typeof value.count !== 'number' || !Number.isFinite(value.count) || value.count < 0 ||
        (dimension && typeof record(value.dimensions)?.[dimension] !== 'string'))) throw new Error('Invalid analytics response');
      return values as AnalyticsGroup[];
    }
    const totals = groups('totals');
    if (totals.length > 1 || (totals.length && (typeof totals[0].sum?.visits !== 'number' || !Number.isFinite(totals[0].sum.visits) || totals[0].sum.visits < 0))) throw new Error('Invalid totals');
    const dailyCounts = new Map(groups('daily', 'date').map(row => [row.dimensions!.date, row.count]));
    const daily = Array.from({ length: Number(daysText) }, (_, index) => {
      const date = new Date(start);
      date.setUTCDate(date.getUTCDate() + index);
      const label = date.toISOString().slice(0, 10);
      return { label, views: dailyCounts.get(label) ?? 0 };
    });
    return analyticsJson({
      start: start.toISOString(), end: end.toISOString(),
      pageViews: totals[0]?.count ?? 0, visits: totals[0]?.sum?.visits ?? 0, daily,
      pages: groups('pages', 'requestPath').map(row => ({ label: row.dimensions!.requestPath || '/', views: row.count })),
      referrers: groups('referrers', 'refererHost').map(row => ({ label: row.dimensions!.refererHost || 'Direct / unknown', views: row.count })),
    }, 200, config);
  } catch (error) {
    return analyticsJson({ error: error instanceof OAuthError ? error.message : 'Analytics is temporarily unavailable.' }, error instanceof OAuthError ? error.status : 502, config);
  }
}

interface EditorTreeEntry extends EditorFileInfo { mode: string; type: string }
interface EditorRepository {
  api: string;
  name: string;
  branch: string;
  ref: string;
  head: string;
  treeSha: string;
  entries: Map<string, EditorTreeEntry>;
}

function regularFile(repository: EditorRepository, path: string): EditorTreeEntry | undefined {
  const entry = repository.entries.get(path);
  if (!entry || entry.type !== 'blob' || entry.mode !== '100644') return undefined;
  const parts = path.split('/');
  for (let index = 1; index < parts.length; index++) {
    const parent = repository.entries.get(parts.slice(0, index).join('/'));
    if (parent && (parent.type !== 'tree' || parent.mode !== '040000')) return undefined;
  }
  return entry;
}

function writablePath(repository: EditorRepository, path: string): void {
  if (repository.entries.has(path) && !regularFile(repository, path)) throw new EditorError('Content cannot replace a directory, executable, symlink or submodule.');
  const parts = path.split('/');
  for (let index = 1; index < parts.length; index++) {
    const parent = repository.entries.get(parts.slice(0, index).join('/'));
    if (parent && (parent.type !== 'tree' || parent.mode !== '040000')) throw new EditorError('Content paths must stay inside normal repository directories.');
  }
}

async function branchHead(repository: Pick<EditorRepository, 'api' | 'ref'>, token: string): Promise<string> {
  const response = await githubJson(`${repository.api}/git/ref/heads/${repository.ref}`, { headers: githubHeaders(token) });
  const commit = record(response.object);
  if (commit?.type !== 'commit' || typeof commit.sha !== 'string' || !shaPattern.test(commit.sha)) throw new EditorError('GitHub returned an invalid branch head.', 502);
  return commit.sha;
}

async function editorRepository(token: string, config: Configuration): Promise<EditorRepository> {
  const { name, branch } = memory.identity && memory.identity.until > Date.now() ? memory.identity : await repositoryIdentity(token, config);
  const api = `${GITHUB_API}/repos/${name}`;
  const ref = branch.split('/').map(encodeURIComponent).join('/');
  // The branch head is always read fresh; everything below it is immutable.
  const head = await branchHead({ api, ref }, token);
  const known = memory.trees.get(head);
  if (known) return { api, name, branch, ref, head, treeSha: known.treeSha, entries: known.entries };
  const commit = await githubJson(`${api}/git/commits/${head}`, { headers: githubHeaders(token) });
  const treeSha = record(commit.tree)?.sha;
  if (commit.sha !== head || typeof treeSha !== 'string' || !shaPattern.test(treeSha)) throw new EditorError('GitHub returned an invalid commit tree.', 502);
  const tree = await githubJson(`${api}/git/trees/${treeSha}?recursive=1`, { headers: githubHeaders(token) });
  if (tree.truncated !== false || !Array.isArray(tree.tree) || tree.tree.length > 20000) throw new EditorError('The repository tree is incomplete or too large to edit safely.', 502);
  const entries = new Map<string, EditorTreeEntry>();
  for (const value of tree.tree) {
    const entry = record(value);
    if (!entry || typeof entry.path !== 'string' || entries.has(entry.path) || typeof entry.sha !== 'string' || !shaPattern.test(entry.sha) ||
      typeof entry.mode !== 'string' || typeof entry.type !== 'string' || (entry.type === 'blob' && (!Number.isSafeInteger(entry.size) || Number(entry.size) < 0))) {
      throw new EditorError('GitHub returned an invalid tree entry.', 502);
    }
    entries.set(entry.path, { path: entry.path, sha: entry.sha, mode: entry.mode, type: entry.type, size: Number(entry.size ?? 0) });
  }
  remember(memory.trees, head, { treeSha, entries }, 4);
  return { api, name, branch, ref, head, treeSha, entries };
}

async function repositoryIdentity(token: string, config: Configuration): Promise<{ name: string; branch: string; until: number }> {
  const response = await githubJson(`${GITHUB_API}/repositories/${config.repositoryId}`, { headers: githubHeaders(token) });
  const name = response.full_name;
  const branch = response.default_branch;
  if (response.id !== config.repositoryId || record(response.owner)?.id !== config.userId || typeof name !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(name) || typeof branch !== 'string' ||
    !branch || branch.length > 255 || /[\u0000-\u0020\u007f~^:?*\[\\]/.test(branch) || branch.includes('..') || branch.includes('@{') ||
    branch.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) {
    throw new EditorError('GitHub returned an unexpected website repository.', 403);
  }
  memory.identity = { name, branch, until: Date.now() + 5 * 60_000 };
  return memory.identity;
}

async function editorFile(repository: EditorRepository, path: string, token: string): Promise<{ path: string; sha: string; content: string }> {
  const entry = regularFile(repository, path);
  if (!entry) throw new EditorError('The requested content file does not exist as a normal file.', 404);
  if (entry.size > maxTextBytes) throw new EditorError('The requested content file is too large.', 413);
  const cached = memory.blobs.get(entry.sha);
  if (cached !== undefined) return { path, sha: entry.sha, content: cached };
  const blob = await githubJson(`${repository.api}/git/blobs/${entry.sha}`, { headers: githubHeaders(token) });
  if (blob.sha !== entry.sha || blob.encoding !== 'base64' || typeof blob.content !== 'string' || blob.size !== entry.size) throw new EditorError('GitHub returned an invalid content blob.', 502);
  let content: string;
  try {
    const bytes = entry.size === 0 && blob.content === '' ? new Uint8Array() : decodeBase64(blob.content, maxTextBytes, true);
    if (bytes.length !== entry.size) throw new Error('Incorrect size');
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch { throw new EditorError('The repository content is not valid UTF-8 text.', 502); }
  // Bounded to a few megabytes: plenty for every content file of this site.
  if (memory.blobBytes + entry.size > 6 * 1024 * 1024) { memory.blobs.clear(); memory.blobBytes = 0; }
  remember(memory.blobs, entry.sha, content, 400);
  memory.blobBytes += entry.size;
  return { path, sha: entry.sha, content };
}

async function gitBlobSha(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const header = encoder.encode(`blob ${bytes.length}\0`);
  const joined = new Uint8Array(header.length + bytes.length);
  joined.set(header);
  joined.set(bytes, header.length);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-1', joined)), byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Read many text files with one GitHub GraphQL request per hundred files instead of one REST
 * request each; Workers allow only a limited number of outgoing requests per call. Every text is
 * checked against its tree SHA, and anything GraphQL cannot return exactly is read over REST.
 */
async function editorFiles(repository: EditorRepository, paths: string[], token: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const pending: EditorTreeEntry[] = [];
  for (const path of paths) {
    const entry = regularFile(repository, path);
    if (!entry) throw new EditorError('The requested content file does not exist as a normal file.', 404);
    if (entry.size > maxTextBytes) throw new EditorError('The requested content file is too large.', 413);
    const cached = memory.blobs.get(entry.sha);
    if (cached !== undefined) result.set(path, cached);
    else pending.push(entry);
  }
  const [owner, name] = repository.name.split('/');
  for (let start = 0; start < pending.length; start += 100) {
    const chunk = pending.slice(start, start + 100);
    // SHAs are validated hex, so interpolating them into the query is safe.
    const fields = chunk.map((entry, index) => `f${index}: object(oid: "${entry.sha}") { ... on Blob { text byteSize isBinary isTruncated } }`).join(' ');
    let objects: Record<string, unknown> | undefined;
    try {
      const response = await githubJson(`${GITHUB_API}/graphql`, {
        method: 'POST', headers: { ...githubHeaders(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`, variables: { owner, name } }),
      });
      objects = record(record(response.data)?.repository);
    } catch { objects = undefined; }
    await Promise.all(chunk.map(async (entry, index) => {
      const blob = record(objects?.[`f${index}`]);
      if (blob && blob.isBinary === false && blob.isTruncated === false && typeof blob.text === 'string' && blob.byteSize === entry.size) {
        const bytes = encoder.encode(blob.text);
        if (bytes.length === entry.size && await gitBlobSha(bytes) === entry.sha) {
          if (memory.blobBytes + entry.size > 6 * 1024 * 1024) { memory.blobs.clear(); memory.blobBytes = 0; }
          remember(memory.blobs, entry.sha, blob.text, 400);
          memory.blobBytes += entry.size;
          result.set(entry.path, blob.text);
          return;
        }
      }
      result.set(entry.path, (await editorFile(repository, entry.path, token)).content);
    }));
  }
  return result;
}

const mediaReference = /\/?media\/[a-z0-9]+(?:-[a-z0-9]+)*-preview-[a-f0-9]{32}\.(?:webp|gif|mp4|mp3)/g;

/** Prepared media that content or site code still points at (code such as the interface sounds counts too). */
async function mediaInUse(repository: EditorRepository, token: string, content: Map<string, string>): Promise<Set<string>> {
  const code = [...repository.entries.values()].filter(entry => entry.type === 'blob' && !contentPath(String(entry.path), true) && !entry.path.startsWith('public/media/')
    && entry.path !== 'package-lock.json' && /\.(?:astro|ts|mts|js|mjs|cjs|css|json|html|md|svg|xml|ya?ml)$/.test(entry.path) && entry.size <= maxTextBytes);
  if (code.length > 400) throw new EditorError('The repository has too many code files to check media safely.', 413);
  const texts = [...content.values(), ...(await editorFiles(repository, code.map(entry => entry.path), token)).values()];
  const used = new Set<string>();
  for (const text of texts) for (const match of text.matchAll(mediaReference)) used.add(`/${match[0].replace(/^\//, '')}`);
  return used;
}

async function requestJson(request: Request, limit = maxRequestBytes): Promise<unknown> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('Content-Type') ?? '')) throw new EditorError('The editor request must be application/json.', 415);
  const length = request.headers.get('Content-Length');
  if (length && (!/^\d+$/.test(length) || Number(length) > limit)) throw new EditorError('The editor request is too large.', 413);
  if (!request.body) throw new EditorError('The editor request needs a JSON body.');
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0; let source = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new EditorError('The editor request is too large.', 413); }
      source += decoder.decode(value, { stream: true });
    }
    source += decoder.decode();
    return JSON.parse(source);
  } catch (error) {
    if (error instanceof EditorError) throw error;
    throw new EditorError('The editor request must be valid UTF-8 JSON.');
  } finally { reader.releaseLock(); }
}

async function publishEditor(request: Request, repository: EditorRepository, token: string, config: Configuration): Promise<Response> {
  const payload = publishPayload(await requestJson(request));
  const conflict = () => new EditorError('The website changed since this draft was loaded. Refresh and review your draft before publishing.', 409);
  if (payload.baseCommit !== repository.head) throw conflict();
  for (const change of payload.changes) writablePath(repository, change.path);
  const deletions = new Set(payload.deletions ?? []);
  for (const path of deletions) {
    if (!regularFile(repository, path)) throw new EditorError('Something you deleted no longer exists. Refresh before publishing.', 409);
    if (payload.changes.some(change => change.path === path)) throw new EditorError('An entry cannot be both changed and deleted.');
  }
  writablePath(repository, registryPath);
  const registryFile = regularFile(repository, registryPath);
  const previews: Record<string, EditorMediaEntry> = registryFile ? previewRegistry((await editorFile(repository, registryPath, token)).content) : Object.create(null);
  const removedMedia = [...deletions].filter(path => mediaFilePattern.test(path));
  for (const path of removedMedia) delete previews[path.slice(6)];
  const uploads = new Map(payload.media.map(upload => [upload.path, upload]));
  for (const upload of payload.media) {
    writablePath(repository, upload.path);
    const previous = previews[upload.path.slice(6)];
    if (repository.entries.has(upload.path)) throw new EditorError('Prepared media paths are immutable. Reuse an existing preview rather than uploading over it.');
    if (previous) throw new EditorError('This preview path is already registered.');
    previews[upload.path.slice(6)] = upload.entry;
  }
  const exists = (path: string) => uploads.has(path) || (!deletions.has(path) && Boolean(regularFile(repository, path)));
  for (const path of Object.keys(previews)) if (!exists(`public${path}`)) throw new EditorError('The preview registry contains a missing or unsafe file.');
  const files = new Map<string, string>();
  const changes = new Map(payload.changes.map(change => [change.path, change.content]));
  const contentEntries = [...repository.entries.values()].filter(entry => contentPath(entry.path));
  if (contentEntries.length > 250 || contentEntries.reduce((total, entry) => total + entry.size, 0) > 8 * maxTextBytes) throw new EditorError('The content catalogue is too large to publish safely.', 413);
  // Resolve the whole catalogue before any Git writes: cross-file IDs, media and
  // post slugs must agree with the final tree, not only with each changed file.
  for (const entry of contentEntries) if (!regularFile(repository, entry.path)) throw new EditorError('Editable content contains an unsafe file.');
  const unchanged = contentEntries.map(entry => entry.path).filter(path => !deletions.has(path) && !changes.has(path));
  for (const [path, content] of await editorFiles(repository, unchanged, token)) files.set(path, content);
  for (const change of payload.changes) files.set(change.path, change.content);
  if (removedMedia.length) {
    const used = await mediaInUse(repository, token, files);
    for (const path of removedMedia) {
      const url = path.slice(6);
      if (!used.has(url)) continue;
      const user = [...files].find(([, content]) => content.includes(url));
      throw new EditorError(`${url.slice(7)} is still used${user ? ` in ${user[0]}` : ' by the site itself'}, so it cannot be deleted.`);
    }
  }
  validateContent(files, previews, exists, config.siteOrigin);
  if (await branchHead(repository, token) !== payload.baseCommit) throw conflict();
  const writeHeaders = new Headers(githubHeaders(token));
  writeHeaders.set('Content-Type', 'application/json');
  const tree: Array<{ path: string; mode: string; type: string; sha?: string | null; content?: string }> = payload.changes.map(change => ({ path: change.path, mode: '100644', type: 'blob', content: change.content }));
  for (const path of deletions) tree.push({ path, mode: '100644', type: 'blob', sha: null });
  // The browser uploaded each prepared file as a Git blob and checked that GitHub's SHA is the
  // hash of the bytes it verified. GitHub refuses a tree that names a blob it does not have.
  for (const upload of payload.media) tree.push({ path: upload.path, mode: '100644', type: 'blob', sha: upload.blob });
  if (payload.media.length || removedMedia.length) {
    const sorted = Object.fromEntries(Object.entries(previews).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    tree.push({ path: registryPath, mode: '100644', type: 'blob', content: `${JSON.stringify({ files: sorted }, null, 2)}\n` });
  }
  const nextTree = await githubJson(`${repository.api}/git/trees`, { method: 'POST', headers: writeHeaders, body: JSON.stringify({ base_tree: repository.treeSha, tree }) }).catch(error => {
    throw payload.media.length ? new EditorError('GitHub could not find every uploaded file. Publish again to upload them again.', 502) : error;
  });
  if (typeof nextTree.sha !== 'string' || !shaPattern.test(nextTree.sha)) throw new EditorError('GitHub did not confirm the publication tree.', 502);
  if (await branchHead(repository, token) !== payload.baseCommit) throw conflict();
  const commit = await githubJson(`${repository.api}/git/commits`, { method: 'POST', headers: writeHeaders, body: JSON.stringify({ message: payload.message?.trim() || 'Publish website edits', tree: nextTree.sha, parents: [payload.baseCommit] }) });
  if (typeof commit.sha !== 'string' || !shaPattern.test(commit.sha)) throw new EditorError('GitHub did not confirm the publication commit.', 502);
  if (await branchHead(repository, token) !== payload.baseCommit) throw conflict();
  // Non-force is the final concurrency guard: a competing descendant commit
  // makes this sibling commit non-fast-forward and GitHub rejects the update.
  const updated = await githubJson(`${repository.api}/git/refs/heads/${repository.ref}`, { method: 'PATCH', headers: writeHeaders, body: JSON.stringify({ sha: commit.sha, force: false }) }, true);
  if (record(updated.object)?.sha !== commit.sha) throw new EditorError('GitHub did not confirm the branch update. Refresh before trying again.', 502);
  return analyticsJson({ commit: commit.sha, htmlUrl: `https://github.com/${repository.name}/commit/${commit.sha}` }, 200, config);
}

/** Sign out on GitHub's side: this token only, or every device's authorization at once. */
async function revokeEditor(request: Request, url: URL, token: string, config: Configuration): Promise<Response> {
  if (url.search) throw new EditorError('This endpoint does not accept query parameters.');
  const body = record(await requestJson(request, 256));
  if (!body || Object.keys(body).some(key => key !== 'everywhere') || typeof body.everywhere !== 'boolean') throw new EditorError('Invalid sign-out request.');
  const scope = body.everywhere ? 'grant' : 'token';
  let response: Response;
  try {
    response = await fetch(`${GITHUB_API}/applications/${encodeURIComponent(config.clientId)}/${scope}`, {
      method: 'DELETE', redirect: 'manual', signal: AbortSignal.timeout(15000),
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2026-03-10',
        'User-Agent': 'gwenlium-cms-auth',
      },
      body: JSON.stringify({ access_token: token }),
    });
  } catch { throw new OAuthError('GitHub could not be reached to sign out. Your sign-in on this browser was still removed.', 502); }
  // 404: GitHub no longer knows the token, which is the goal.
  if (response.status !== 204 && response.status !== 404) throw new OAuthError(`GitHub sign-out failed (HTTP ${response.status}). Your sign-in on this browser was still removed.`, 502);
  return analyticsJson({ revoked: scope }, 200, config);
}

async function editor(request: Request, url: URL, config: Configuration): Promise<Response> {
  if (request.headers.get('Origin') !== config.siteOrigin) return textResponse('Origin not allowed.', 403);
  const renewal = url.pathname === '/editor/session';
  const method = ['/editor/publish', '/editor/session', '/editor/revoke', '/editor/files'].includes(url.pathname) ? 'POST' : 'GET';
  if (request.method === 'OPTIONS') {
    const requestedHeaders = (request.headers.get('Access-Control-Request-Headers') ?? '').toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
    const allowedHeaders = renewal ? ['content-type'] : method === 'POST' ? ['authorization', 'content-type'] : ['authorization'];
    if (request.headers.get('Access-Control-Request-Method') !== method || requestedHeaders.some(header => !allowedHeaders.includes(header))) return analyticsJson({ error: 'Invalid preflight.' }, 403, config);
    const responseHeaders = headers();
    responseHeaders.set('Access-Control-Allow-Origin', config.siteOrigin);
    responseHeaders.set('Access-Control-Allow-Methods', method);
    responseHeaders.set('Access-Control-Allow-Headers', allowedHeaders.join(', '));
    responseHeaders.set('Vary', 'Origin');
    return new Response(null, { status: 204, headers: responseHeaders });
  }
  if (request.method !== method) return analyticsJson({ error: 'Method not allowed.' }, 405, config);
  if (renewal) {
    try {
      if (url.search) throw new EditorError('This endpoint does not accept query parameters.');
      return await renewSession(request, config);
    } catch (error) {
      const known = error instanceof EditorError || error instanceof OAuthError;
      return analyticsJson({ error: known ? error.message.slice(0, 400) : 'Sign-in renewal failed. Try again.' }, known ? error.status : 502, config);
    }
  }
  const authorization = request.headers.get('Authorization') ?? '';
  if (!/^Bearer ghu_[A-Za-z0-9]{1,508}$/.test(authorization)) return analyticsJson({ error: 'Sign in to the editor.' }, 401, config);
  try {
    const token = authorization.slice(7);
    if (url.pathname === '/editor/revoke') {
      // Signing out must work even if the app installation changed, so it skips the repository check.
      const user = await githubJson(`${GITHUB_API}/user`, { headers: githubHeaders(token) });
      if (user.id !== config.userId) throw new EditorError('This GitHub account is not allowed to edit this website.', 403);
      memory.owners.delete(await tokenKey(token));
      return await revokeEditor(request, url, token, config);
    }
    const owner: EditorOwner = { id: config.userId, login: await verifiedOwner(token, config) };
    const parameters = [...url.searchParams.keys()];
    if (url.pathname === '/editor/files') {
      // Many files in one request: one owner check and one tree instead of one per file.
      if (parameters.length) throw new EditorError('This endpoint does not accept query parameters.');
      const body = record(await requestJson(request, 64 * 1024));
      const paths = body?.paths;
      if (!body || Object.keys(body).some(key => key !== 'ref' && key !== 'paths') || typeof body.ref !== 'string' || !shaPattern.test(body.ref)
        || !Array.isArray(paths) || !paths.length || paths.length > 250 || new Set(paths).size !== paths.length || paths.some(path => !contentPath(path, true))) {
        throw new EditorError('Provide one full commit SHA and up to 250 distinct allowed content paths.');
      }
      const repository = await editorRepository(token, config);
      if (body.ref !== repository.head) throw new EditorError('This content snapshot is stale. Refresh the editor before loading more files.', 409);
      const contents = await editorFiles(repository, paths as string[], token);
      return analyticsJson({ files: (paths as string[]).map(path => ({ path, sha: regularFile(repository, path)!.sha, content: contents.get(path)! })) }, 200, config);
    }
    if (url.pathname === '/editor/history' || url.pathname === '/editor/version') {
      // Earlier versions of one content file, straight from Git history.
      const path = singleParameter(url, 'path');
      const commit = url.pathname === '/editor/version' ? singleParameter(url, 'commit') : undefined;
      if (!contentPath(path) || parameters.length !== (commit === undefined ? 1 : 2) || (url.pathname === '/editor/version' && (!commit || !shaPattern.test(commit)))) {
        throw new EditorError('Provide one content path (and, for a version, one full commit SHA).');
      }
      const identity = memory.identity && memory.identity.until > Date.now() ? memory.identity : await repositoryIdentity(token, config);
      const api = `${GITHUB_API}/repos/${identity.name}`;
      if (url.pathname === '/editor/history') {
        const values = await githubList(`${api}/commits?${new URLSearchParams({ path, sha: identity.branch, per_page: '40' })}`, token);
        const versions = values.flatMap(value => {
          const item = record(value);
          const details = record(item?.commit);
          const sha = item?.sha;
          const date = record(details?.author)?.date ?? record(details?.committer)?.date;
          if (typeof sha !== 'string' || !shaPattern.test(sha) || typeof details?.message !== 'string' || typeof date !== 'string') return [];
          return [{ commit: sha, message: details.message.split('\n')[0].slice(0, 200), date }];
        });
        return analyticsJson({ path, versions }, 200, config);
      }
      const file = await githubJson(`${api}/contents/${path.split('/').map(encodeURIComponent).join('/')}?${new URLSearchParams({ ref: commit! })}`, { headers: githubHeaders(token) });
      if (file.type !== 'file' || file.encoding !== 'base64' || typeof file.content !== 'string' || !Number.isSafeInteger(file.size) || Number(file.size) > maxTextBytes) throw new EditorError('That version could not be read.', 502);
      let content: string;
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64(file.content, maxTextBytes, true)); }
      catch { throw new EditorError('That version is not readable text.', 502); }
      return analyticsJson({ path, commit, content }, 200, config);
    }
    if (url.pathname === '/editor/unused-media') {
      // Registered media that no content and no site code refers to. Drafts are the browser's to check.
      if (parameters.length) throw new EditorError('This endpoint does not accept query parameters.');
      const repository = await editorRepository(token, config);
      const registryFile = regularFile(repository, registryPath);
      if (!registryFile) return analyticsJson({ head: repository.head, media: [] }, 200, config);
      const contentPaths = [...repository.entries.values()].filter(entry => contentPath(entry.path) && regularFile(repository, entry.path)).map(entry => entry.path);
      const contents = await editorFiles(repository, [...contentPaths, registryPath], token);
      const previews = previewRegistry(contents.get(registryPath)!);
      contents.delete(registryPath);
      const used = await mediaInUse(repository, token, contents);
      const media = Object.entries(previews).filter(([url]) => !used.has(url) && regularFile(repository, `public${url}`)).map(([url, entry]) => ({ url, entry }));
      return analyticsJson({ head: repository.head, media }, 200, config);
    }
    if (url.pathname === '/editor/file') {
      const path = singleParameter(url, 'path'); const ref = singleParameter(url, 'ref');
      if (parameters.length !== 2 || !contentPath(path, true) || !ref || !shaPattern.test(ref)) throw new EditorError('Provide one allowed content path and one full commit SHA.');
      const repository = await editorRepository(token, config);
      if (ref !== repository.head) throw new EditorError('This content snapshot is stale. Refresh the editor before loading more files.', 409);
      return analyticsJson(await editorFile(repository, path, token), 200, config);
    }
    if (parameters.length) throw new EditorError('This endpoint does not accept query parameters.');
    const repository = await editorRepository(token, config);
    if (url.pathname === '/editor/publish') return await publishEditor(request, repository, token, config);
    const files: EditorFileInfo[] = [...repository.entries.values()].filter(entry => contentPath(entry.path, true) && regularFile(repository, entry.path)).map(({ path, sha, size }) => ({ path, sha, size }));
    return analyticsJson({ head: repository.head, branch: repository.branch, repository: repository.name, owner, files }, 200, config);
  } catch (error) {
    const known = error instanceof EditorError || error instanceof OAuthError;
    return analyticsJson({ error: known ? error.message.slice(0, 400) : 'The editor request could not be completed. Nothing was confirmed published; refresh before retrying.' }, known ? error.status : 502, config);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (['/editor', '/editor/file', '/editor/files', '/editor/history', '/editor/version', '/editor/unused-media', '/editor/publish', '/editor/session', '/editor/revoke'].includes(url.pathname)) {
      const config = configuration(env);
      if (!config) return textResponse('Editor configuration is unavailable.', 503);
      if (url.protocol !== 'https:' || url.origin !== config.authOrigin) return textResponse('Invalid editor origin.', 400);
      return editor(request, url, config);
    }
    if (url.pathname === '/analytics') {
      const config = configuration(env);
      if (!config) return textResponse('Editor configuration is unavailable.', 503);
      if (url.protocol !== 'https:' || url.origin !== config.authOrigin) return textResponse('Invalid analytics origin.', 400);
      return analytics(request, url, env, config);
    }
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
