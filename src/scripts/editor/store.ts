import { parseDocument } from 'yaml';
import type { PreparedPreview } from './prepare-media';
import { normalizeWatermarkCredit } from '../../lib/watermark.mjs';
import { checkPreparedMedia } from '../../lib/media-check';
import type {
  EditorBinding, EditorConflict, EditorDraftFile, EditorFile, EditorMediaEntry, EditorMediaUpload,
  EditorPublishRequest, EditorPublishResult, EditorSnapshot, PreviewRegistry,
} from '../../lib/editor-types';
import { authFailure, type OwnerAuth } from './auth';
import { readRecord, writeIfRevision } from './database';

export const registryPath = 'src/content/media-previews.json';
const sitePath = 'src/content/site.json';
const previewPath = /^\/media\/[a-z0-9]+(?:-[a-z0-9]+)*-preview-([a-f0-9]{32})\.(webp|gif|mp4|mp3)$/;
const forbiddenKeys: Record<string, boolean> = { ['__proto__']: true, prototype: true, constructor: true };
const own = (value: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value, key);

type StagedMedia = { url: string; file: Blob; entry: EditorMediaEntry };
type SavedDraft = {
  key: string;
  revision: number;
  snapshot: EditorSnapshot;
  files: EditorDraftFile[];
  media: StagedMedia[];
};
type Session = {
  controller: AbortController;
  key: string;
  revision: number;
  snapshot: EditorSnapshot;
  files: Map<string, EditorDraftFile>;
  media: Map<string, StagedMedia>;
  cache: Map<string, Promise<string>>;
  conflicts?: EditorConflict[];
};

export type EntrySummary = {
  path: string;
  title: string;
  permalink: string;
  section: 'devlog' | 'life';
  draft: boolean;
  date: string;
  publishAt: string;
  cover: string;
  changed: boolean;
  isNew: boolean;
};

function failure(message: string, status?: number): Error & { status?: number } {
  return Object.assign(new Error(message), status === undefined ? {} : { status });
}

export function isPostPath(path: string): boolean {
  return /^src\/content\/posts\/(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)*[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(path);
}

function editablePath(path: string): boolean {
  if (typeof path !== 'string' || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) return false;
  return /^src\/content\/(?:site|windows|gallery|music)\.json$/.test(path)
    || /^src\/content\/pages\/[^/]+\.json$/.test(path)
    || isPostPath(path);
}

function assertPath(path: string, writable = false): void {
  if (!editablePath(path) && (writable || path !== registryPath)) throw new Error('This file is not editable website content.');
}

function snapshotFrom(value: unknown): EditorSnapshot {
  const item = value as EditorSnapshot;
  if (!item || typeof item !== 'object' || !/^[a-f0-9]{40}$/.test(item.head)
    || typeof item.branch !== 'string' || !item.branch
    || typeof item.repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(item.repository)
    || !item.owner || !Number.isSafeInteger(item.owner.id) || item.owner.id <= 0
    || typeof item.owner.login !== 'string' || !Array.isArray(item.files)) {
    throw new Error('The editor returned an invalid owner snapshot.');
  }
  const paths = new Set<string>();
  for (const file of item.files) {
    if (!file || typeof file.path !== 'string' || (!editablePath(file.path) && file.path !== registryPath)
      || !/^[a-f0-9]{40}$/.test(file.sha) || !Number.isSafeInteger(file.size) || file.size < 0 || paths.has(file.path)) {
      throw new Error('The editor returned an invalid file list.');
    }
    paths.add(file.path);
  }
  return {
    head: item.head, branch: item.branch, repository: item.repository,
    owner: { id: item.owner.id, login: item.owner.login },
    files: item.files.map(({ path, sha, size }) => ({ path, sha, size })),
  };
}

function safeValue(value: unknown, ancestors = new WeakSet<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (!value || typeof value !== 'object') throw new Error('Editable values must be JSON-compatible data.');
  if (ancestors.has(value)) throw new Error('Cyclic data cannot be saved as editor content.');
  ancestors.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (own(forbiddenKeys, key)) throw new Error('Prototype keys are not allowed in editor content.');
    safeValue(child, ancestors);
  }
  ancestors.delete(value);
}

function pointerParts(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) throw new Error('An editable field must use a JSON pointer.');
  return pointer.slice(1).split('/').map(part => {
    if (/~(?![01])/u.test(part)) throw new Error('The editable field has an invalid JSON pointer escape.');
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (own(forbiddenKeys, key)) throw new Error('Prototype fields cannot be edited.');
    return key;
  });
}

function locate(value: unknown, parts: string[], writing: boolean): { path: (string | number)[]; value: unknown } {
  const path: (string | number)[] = [];
  let current = value;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    const last = index === parts.length - 1;
    let key: string | number = part;
    if (Array.isArray(current)) {
      if (part.startsWith('@')) {
        let selected = -1;
        for (let position = 0; position < current.length; position++) {
          const item = current[position];
          if (item && typeof item === 'object' && own(item, 'id') && item.id === part.slice(1)) {
            if (selected !== -1) throw new Error('The selected item ID is not unique. Refresh before editing it.');
            selected = position;
          }
        }
        if (selected === -1) throw new Error('The selected item was removed. Refresh before editing it.');
        key = selected;
      } else if (part === '-' && writing && last) key = current.length;
      else if (/^(?:0|[1-9]\d*)$/.test(part)) key = Number(part);
      else throw new Error('This array field requires an item ID or numeric index.');
      if (!Number.isSafeInteger(key) || Number(key) < 0 || Number(key) >= current.length + (writing && last ? 1 : 0)) {
        throw new Error('The selected array item no longer exists.');
      }
    } else if (!current || typeof current !== 'object') {
      throw new Error('The parent of this editable field no longer exists.');
    }
    path.push(key);
    const container = current as Record<string | number, unknown>;
    current = own(container, key) ? container[key] : undefined;
    if (current === undefined && !last) throw new Error('The parent of this editable field no longer exists.');
  }
  return { path, value: current };
}

export function markdownParts(content: string) {
  const opening = /^(?:\uFEFF)?---[ \t]*\r?\n/.exec(content);
  if (!opening) return { opening: '---\n', closing: '---\n', prefix: '', yaml: '', body: content };
  const rest = content.slice(opening[0].length);
  const closing = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(rest);
  if (!closing) throw new Error('This Markdown file has unclosed frontmatter.');
  const end = opening[0].length + closing.index + closing[0].length;
  return { opening: opening[0], closing: closing[0], prefix: content.slice(0, end), yaml: rest.slice(0, closing.index), body: content.slice(end) };
}

export function bindingDocument(content: string, markdown: boolean) {
  if (!markdown) {
    const value: unknown = JSON.parse(content);
    safeValue(value);
    return { value, document: undefined, parts: undefined };
  }
  const parts = markdownParts(content);
  const document = parseDocument(parts.yaml);
  if (document.errors.length) throw new Error(`This Markdown frontmatter is invalid: ${document.errors[0].message}`);
  const value: unknown = document.toJS({ maxAliasCount: 50 }) ?? {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Markdown frontmatter must be a field mapping.');
  safeValue(value);
  return { value, document, parts };
}

function mediaEntry(value: unknown, url: string, staged = true): EditorMediaEntry {
  const entry = value as EditorMediaEntry;
  const match = previewPath.exec(url);
  if (!match || !entry || typeof entry !== 'object' || Array.isArray(entry)
    || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256) || (staged && !entry.sha256.startsWith(match[1]))
    || !['image', 'video', 'audio'].includes(entry.kind)
    || Object.keys(entry).some(key => !['sha256', 'kind', 'width', 'height', 'duration', 'loop', 'poster'].includes(key))
    || (entry.loop !== undefined && (entry.loop !== true || entry.kind !== 'video'))
    || (entry.poster !== undefined && (entry.loop !== true || typeof entry.poster !== 'string' || previewPath.exec(entry.poster)?.[2] !== 'webp'))
    || (entry.kind === 'image' && !['webp', 'gif'].includes(match[2]))
    || (entry.kind === 'video' && match[2] !== 'mp4') || (entry.kind === 'audio' && match[2] !== 'mp3')) {
    throw new Error('Only prepared media previews can be staged.');
  }
  for (const key of ['width', 'height', 'duration'] as const) {
    if (entry[key] !== undefined && (typeof entry[key] !== 'number' || !Number.isFinite(entry[key]) || entry[key]! <= 0)) {
      throw new Error('The prepared preview metadata is invalid.');
    }
  }
  if (entry.kind !== 'audio' && (!Number.isSafeInteger(entry.width) || !Number.isSafeInteger(entry.height))) throw new Error('The prepared preview dimensions are invalid.');
  if (entry.kind !== 'image' && entry.duration === undefined) throw new Error('The prepared preview duration is missing.');
  return { ...entry };
}

function registryFrom(content: string): PreviewRegistry {
  const value = JSON.parse(content);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1
    || !value.files || typeof value.files !== 'object' || Array.isArray(value.files)) throw new Error('The media preview registry is invalid.');
  const files: PreviewRegistry['files'] = {};
  for (const [url, entry] of Object.entries(value.files)) files[url] = mediaEntry(entry, url, false);
  return { files };
}

function collectMediaReferences(value: unknown, urls: Set<string>): void {
  if (typeof value === 'string') {
    const references = /(?<![\w/.:-])\/media\/[a-z0-9]+(?:-[a-z0-9]+)*-preview-[a-f0-9]{32}\.(?:webp|gif|mp4|mp3)(?![\w./%+-])/g;
    for (const match of value.matchAll(references)) urls.add(match[0]);
  } else if (value && typeof value === 'object') {
    for (const child of Object.values(value)) collectMediaReferences(child, urls);
  }
}

/** fetch, with a readable message instead of the browser's bare "Failed to fetch". */
async function reach(controller: AbortController, url: string, init: RequestInit, message: string): Promise<Response> {
  try { return await fetch(url, init); }
  catch (error) {
    if (controller.signal.aborted) throw error;
    if ((error as { name?: string })?.name === 'TimeoutError') throw failure('The editor service took too long to answer. Try again in a moment; your changes are still saved here.', 0);
    throw failure(message, 0);
  }
}

function base64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let index = 0; index < bytes.length; index += 0x8000) chunks.push(String.fromCharCode(...bytes.subarray(index, index + 0x8000)));
  return btoa(chunks.join(''));
}

function entryFrom(path: string, content: string, changed: boolean, isNew: boolean): EntrySummary {
  let data: Record<string, unknown> = {};
  try { data = bindingDocument(content, true).value as Record<string, unknown>; } catch { /* Listed with its path so it can still be opened. */ }
  const date = data.date instanceof Date ? data.date.toISOString().slice(0, 10) : typeof data.date === 'string' ? data.date : '';
  return {
    path, changed, isNew,
    title: typeof data.title === 'string' ? data.title : '',
    permalink: typeof data.permalink === 'string' ? data.permalink : '',
    section: data.section === 'life' ? 'life' : 'devlog',
    draft: data.draft !== false,
    date,
    publishAt: data.publishAt instanceof Date ? data.publishAt.toISOString() : typeof data.publishAt === 'string' ? data.publishAt : '',
    cover: typeof data.cover === 'string' ? data.cover : '',
  };
}

/** Owner drafts: private to this browser until published, then committed in one atomic change. */
export class SiteEditorStore {
  private readonly authOrigin: string;
  private readonly siteOrigin: string;
  private readonly auth: OwnerAuth;
  readonly local: boolean;
  private session?: Session;
  private generation = 0;
  private pendingAuth?: AbortController;
  private writes: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  private objectURLs = new Map<string, string>();
  private warning?: string;
  private channel?: BroadcastChannel;
  private restoring?: Promise<boolean>;

  constructor(options: { authOrigin: string; siteOrigin: string; auth: OwnerAuth; local?: boolean }) {
    const auth = new URL(options.authOrigin);
    const site = new URL(options.siteOrigin);
    if (!options.local && (auth.protocol !== 'https:' || site.protocol !== 'https:')) throw new Error('The editor requires HTTPS origins.');
    if (auth.username || auth.password || site.username || site.password) throw new Error('The editor origins cannot contain credentials.');
    this.authOrigin = options.local ? options.authOrigin.replace(/\/$/, '') : auth.origin;
    this.siteOrigin = site.origin;
    this.auth = options.auth;
    this.local = Boolean(options.local);
    try {
      // Other tabs of the site share one draft; follow their saves instead of conflicting with them.
      this.channel = new BroadcastChannel('gwenlium-site-editor');
      this.channel.onmessage = event => { if (event.data?.key === this.session?.key) void this.follow(String(event.data.head)); };
    } catch { /* Without BroadcastChannel, the revision check still prevents lost writes. */ }
  }

  private follow(head: string): Promise<void> {
    return this.enqueue(async session => {
      const saved = await readRecord<SavedDraft>('drafts', session.key);
      this.active(session);
      if ((saved?.revision ?? 0) === session.revision && head === session.snapshot.head) return;
      session.revision = saved?.revision ?? 0;
      session.files = new Map((saved?.files ?? []).map(file => [file.path, { ...file }]));
      session.media = new Map((saved?.media ?? []).map(media => [media.url, { ...media, entry: mediaEntry(media.entry, media.url) }]));
      if (head !== session.snapshot.head) {
        // The other tab published: load the version it published.
        session.snapshot = saved?.snapshot.head === head ? snapshotFrom(saved.snapshot) : snapshotFrom(await this.api(session.controller, '/editor'));
        session.cache.clear();
      }
      this.emit();
    }).catch(() => undefined);
  }

  get authenticated(): boolean { return !!this.session; }
  get dirty(): boolean { return !!this.session?.files.size; }
  get snapshot(): EditorSnapshot | undefined { return this.session ? structuredClone(this.session.snapshot) : undefined; }
  get draftFiles(): EditorDraftFile[] { return this.session ? Array.from(this.session.files.values(), file => ({ ...file })) : []; }
  get storageWarning(): string | undefined { return this.warning; }
  get remembered(): boolean { return this.auth.remembered; }

  subscribe(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => { this.listeners.delete(callback); };
  }

  private emit(): void {
    for (const callback of this.listeners) {
      try { callback(); } catch (error) { queueMicrotask(() => { throw error; }); }
    }
  }

  private active(session = this.session): Session {
    if (!session || this.session !== session || session.controller.signal.aborted) throw failure('Sign in with the website owner account before editing.', 401);
    return session;
  }

  private enqueue<T>(operation: (session: Session) => Promise<T>): Promise<T> {
    const session = this.session;
    const result = this.writes.then(() => operation(this.active(session)));
    this.writes = result.catch(() => undefined);
    return result;
  }

  /**
   * Check a prepared file, then store it in the repository as a Git blob. In production this goes
   * straight to GitHub with the owner's token (a Cloudflare Worker cannot carry tens of megabytes);
   * locally, the dev stand-in keeps it. Returns the blob SHA, checked against the bytes sent.
   */
  private async uploadBlob(session: Session, url: string, entry: EditorMediaEntry, file: Blob, retried = false): Promise<string> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    // The privacy boundary: no camera, location or other private metadata may leave this device.
    await checkPreparedMedia(url, entry, bytes);
    const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
    const framed = new Uint8Array(header.length + bytes.length);
    framed.set(header); framed.set(bytes, header.length);
    const expected = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-1', framed)), byte => byte.toString(16).padStart(2, '0')).join('');
    const repository = session.snapshot.repository;
    if (!this.local && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw failure('The website repository is unknown. Reload the editor.');
    const token = this.local ? '' : await this.auth.token(retried);
    const response = await reach(session.controller, this.local ? `${this.authOrigin}/editor/blob` : `https://api.github.com/repos/${repository}/git/blobs`, {
      method: 'POST', mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'error', signal: session.controller.signal,
      ...(this.local
        ? { headers: { 'Content-Type': 'application/octet-stream' }, body: bytes }
        : { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' }, body: JSON.stringify({ content: base64(bytes), encoding: 'base64' }) }),
    }, 'GitHub could not be reached to upload a file. Check your connection and try again; your changes are still saved here.');
    if (response.status === 401 && !this.local && !retried) return this.uploadBlob(session, url, entry, file, true);
    const value = await response.json().catch(() => undefined) as { sha?: unknown; message?: unknown } | undefined;
    if (!response.ok) throw failure(`GitHub did not accept a file (${typeof value?.message === 'string' ? value.message : `HTTP ${response.status}`}). Nothing was published.`, response.status);
    if (value?.sha !== expected) throw failure('GitHub stored a different file than was sent. Nothing was published; try again.');
    return expected;
  }

  private async api(controller: AbortController, path: string, body?: EditorPublishRequest | Record<string, unknown>, retried = false): Promise<unknown> {
    const token = await this.auth.token(retried);
    const response = await reach(controller, `${this.authOrigin}${path}`, {
      method: body ? 'POST' : 'GET', mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'error',
      // A stalled request would otherwise leave "Opening the editor…" up forever.
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(body ? 90_000 : 30_000)]),
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }, 'The editor service could not be reached. Check your connection and try again; your changes are still saved here.');
    // A token GitHub revoked early gets one quiet renewal before asking to sign in.
    if (response.status === 401 && !retried) return this.api(controller, path, body, true);
    let value: unknown;
    try { value = await response.json(); }
    catch { throw failure('The editor service returned an unreadable response.', response.status); }
    if (!response.ok) {
      const data = value as { error?: unknown; message?: unknown };
      const message = typeof data?.error === 'string' ? data.error : typeof data?.message === 'string' ? data.message : 'The editor request failed.';
      throw failure(message, response.status);
    }
    return value;
  }

  /** Call from a click handler: the popup opens synchronously. */
  signIn(): Promise<void> {
    const signingIn = this.auth.signIn();
    return signingIn.then(() => this.connect());
  }

  /** Reconnect a remembered sign-in without any popup. Resolves false when there is none. */
  restore(): Promise<boolean> {
    if (this.session) return Promise.resolve(true);
    // The page controls and the writing page both ask at load; share one connection.
    this.restoring ??= (async () => {
      try {
        await this.auth.token();
      } catch (error) {
        if ((error as { status?: number }).status === 401) return false;
        throw error;
      }
      await this.connect();
      return true;
    })().finally(() => { this.restoring = undefined; });
    return this.restoring;
  }

  async connect(): Promise<void> {
    if (!this.local && window.location.origin !== this.siteOrigin) throw failure('Open the editor on the website itself.', 403);
    this.close();
    const generation = this.generation;
    const controller = new AbortController();
    this.pendingAuth = controller;
    try {
      const verified = snapshotFrom(await this.api(controller, '/editor'));
      if (generation !== this.generation) throw failure('Sign-in was cancelled.', 401);
      const key = JSON.stringify([this.siteOrigin, verified.owner.id, verified.repository]);
      let saved: SavedDraft | undefined;
      try { saved = await readRecord<SavedDraft>('drafts', key); }
      catch (error) { this.storageFailure(error); throw error; }
      if (generation !== this.generation) throw failure('Sign-in was cancelled.', 401);
      const session: Session = {
        controller, key, revision: saved?.revision ?? 0, snapshot: verified,
        files: new Map(), media: new Map(), cache: new Map(),
      };
      if (saved) {
        const snapshot = snapshotFrom(saved.snapshot);
        if (snapshot.owner.id !== verified.owner.id || snapshot.repository !== verified.repository || snapshot.branch !== verified.branch
          || !Number.isSafeInteger(saved.revision) || saved.revision <= 0 || !Array.isArray(saved.files) || !Array.isArray(saved.media)) {
          throw new Error('The saved private draft does not match this owner and repository. It has not been overwritten.');
        }
        for (const file of saved.files) {
          assertPath(file.path, true);
          if ((file.baseContent !== null && typeof file.baseContent !== 'string') || typeof file.content !== 'string' || session.files.has(file.path)) throw new Error('The saved private draft is invalid. It has not been overwritten.');
          if (file.content !== file.baseContent || file.deleted) session.files.set(file.path, { ...file });
        }
        for (const media of saved.media) {
          if (!(media.file instanceof Blob) || !media.file.size || session.media.has(media.url)) throw new Error('The saved private media draft is invalid. It has not been overwritten.');
          session.media.set(media.url, { ...media, entry: mediaEntry(media.entry, media.url) });
        }
        if (session.files.size || session.media.size) session.snapshot = { ...snapshot, owner: verified.owner };
      }
      this.session = session;
      this.warning = undefined;
      this.emit();
      // Learn which published videos are animations, so editors show them the way the site does.
      void this.media().then(() => this.emit(), () => undefined);
      // Drafts made against an older version are re-based quietly when nothing conflicts.
      if (session.files.size && session.snapshot.head !== verified.head) void this.refresh().catch(() => undefined);
    } finally {
      if (this.pendingAuth === controller) this.pendingAuth = undefined;
    }
  }

  private close(): void {
    this.generation++;
    this.pendingAuth?.abort();
    this.pendingAuth = undefined;
    if (this.session) {
      this.session.controller.abort();
      this.session.files.clear();
      this.session.media.clear();
      this.session.cache.clear();
      this.session.conflicts = undefined;
      this.session = undefined;
    }
    this.revokeMedia();
    this.warning = undefined;
  }

  /** Sign out on this device (or everywhere). Unpublished drafts stay saved for the next sign-in. */
  async signOut(everywhere = false): Promise<string | undefined> {
    this.close();
    const warning = await this.auth.signOut(everywhere);
    this.emit();
    return warning;
  }

  private async remote(session: Session, snapshot: EditorSnapshot, path: string, cache: Map<string, Promise<string>>): Promise<string> {
    assertPath(path);
    const expected = snapshot.files.find(file => file.path === path);
    if (!expected) throw failure('This file does not exist at the draft base commit.', 404);
    let pending = cache.get(path);
    if (!pending) {
      pending = this.api(session.controller, `/editor/file?${new URLSearchParams({ path, ref: snapshot.head })}`).then(value => {
        this.active(session);
        const file = value as EditorFile;
        if (!file || file.path !== path || typeof file.content !== 'string' || file.sha !== expected.sha) throw new Error('The editor returned a source file that does not match the draft base.');
        return file.content;
      });
      cache.set(path, pending);
      void pending.catch(() => { if (cache.get(path) === pending) cache.delete(path); });
    }
    return pending;
  }

  /** Load many published files in one request (one owner check and one tree on the worker). */
  private async prefetch(session: Session, paths: string[]): Promise<void> {
    const snapshot = session.snapshot;
    const cache = session.cache;
    const missing = paths.filter(path => !cache.has(path) && !session.files.has(path) && snapshot.files.some(file => file.path === path));
    if (missing.length < 2) return;
    const loading = this.api(session.controller, '/editor/files', { ref: snapshot.head, paths: missing }).then(value => {
      this.active(session);
      const files = new Map(((value as { files?: EditorFile[] })?.files ?? []).map(file => [file.path, file]));
      return files;
    });
    for (const path of missing) {
      const expected = snapshot.files.find(file => file.path === path)!;
      const pending = loading.then(files => {
        const file = files.get(path);
        if (!file || typeof file.content !== 'string' || file.sha !== expected.sha) throw new Error('The editor returned a source file that does not match the draft base.');
        return file.content;
      });
      cache.set(path, pending);
      void pending.catch(() => { if (cache.get(path) === pending) cache.delete(path); });
    }
    await loading.catch(() => undefined);
  }

  private source(session: Session, path: string): Promise<string> {
    assertPath(path);
    const draft = session.files.get(path);
    if (draft?.deleted) return Promise.reject(failure('This entry is deleted in your unpublished changes.', 404));
    return draft ? Promise.resolve(draft.content) : this.remote(session, session.snapshot, path, session.cache);
  }

  async read(path: string): Promise<string> {
    const session = this.active();
    await this.writes;
    return this.source(this.active(session), path);
  }

  exists(path: string): boolean {
    const session = this.session;
    if (!session) return false;
    const draft = session.files.get(path);
    if (draft) return !draft.deleted;
    return session.snapshot.files.some(file => file.path === path);
  }

  private async update(session: Session, path: string, content: string): Promise<void> {
    assertPath(path, true);
    if (typeof content !== 'string') throw new Error('File content must be text.');
    const prior = session.files.get(path);
    const baseContent = prior ? prior.baseContent : session.snapshot.files.some(file => file.path === path)
      ? await this.remote(session, session.snapshot, path, session.cache) : null;
    this.active(session);
    if (!this.warning && !prior?.deleted && content === (prior?.content ?? baseContent)) return;
    if (content === baseContent) session.files.delete(path);
    else session.files.set(path, { path, baseContent, content });
    this.emit();
    await this.save(session);
  }

  write(path: string, content: string): Promise<void> {
    return this.enqueue(session => this.update(session, path, content));
  }

  /** Delete a journal entry. A never-published entry simply disappears from the draft. */
  remove(path: string): Promise<void> {
    return this.enqueue(async session => {
      if (!isPostPath(path)) throw new Error('Only journal entries can be deleted.');
      const published = session.snapshot.files.some(file => file.path === path);
      if (!published) session.files.delete(path);
      else {
        const prior = session.files.get(path);
        const baseContent = prior ? prior.baseContent : await this.remote(session, session.snapshot, path, session.cache);
        this.active(session);
        session.files.set(path, { path, baseContent, content: '', deleted: true });
      }
      this.emit();
      await this.save(session);
    });
  }

  /** Undo every unpublished change to one file. */
  revert(path: string): Promise<void> {
    return this.enqueue(async session => {
      if (!session.files.delete(path)) return;
      this.emit();
      await this.save(session);
    });
  }

  async get(binding: EditorBinding): Promise<unknown> {
    const content = await this.read(binding.file);
    const parts = pointerParts(binding.field);
    if (binding.file.endsWith('.md') && parts.length === 1 && parts[0] === 'body') return markdownParts(content).body;
    return locate(bindingDocument(content, binding.file.endsWith('.md')).value, parts, false).value;
  }

  set(binding: EditorBinding, value: unknown): Promise<void> {
    return this.enqueue(async session => {
      assertPath(binding.file, true);
      const parts = pointerParts(binding.field);
      const content = await this.source(session, binding.file);
      this.active(session);
      if (binding.file.endsWith('.md') && parts.length === 1 && parts[0] === 'body') {
        if (typeof value !== 'string') throw new Error('Markdown body content must be text.');
        const { prefix } = markdownParts(content);
        await this.update(session, binding.file, prefix + (prefix && !prefix.endsWith('\n') && value ? '\n' : '') + value);
        return;
      }
      safeValue(value);
      const parsed = bindingDocument(content, binding.file.endsWith('.md'));
      const target = locate(parsed.value, parts, true);
      if (!this.warning && Object.is(target.value, value)) return;
      let result: string;
      if (parsed.document && parsed.parts) {
        if (!parts.length) throw new Error('Edit a named Markdown frontmatter field or its body.');
        parsed.document.setIn(target.path, value);
        result = parsed.parts.opening + parsed.document.toString() + parsed.parts.closing + parsed.parts.body;
      } else {
        if (!parts.length) result = `${JSON.stringify(value, null, 2)}\n`;
        else {
          let parent = parsed.value as Record<string | number, unknown>;
          for (const key of target.path.slice(0, -1)) parent = parent[key] as Record<string | number, unknown>;
          parent[target.path[target.path.length - 1]] = value;
          result = `${JSON.stringify(parsed.value, null, 2)}\n`;
        }
      }
      await this.update(session, binding.file, result);
    });
  }

  /** Every journal entry, drafts and unpublished new ones included. */
  async entries(): Promise<EntrySummary[]> {
    const session = this.active();
    await this.writes;
    const paths = new Set(session.snapshot.files.map(file => file.path).filter(isPostPath));
    for (const [path, file] of session.files) {
      if (!isPostPath(path)) continue;
      if (file.deleted) paths.delete(path); else paths.add(path);
    }
    await this.prefetch(session, [...paths]);
    const entries = await Promise.all([...paths].map(async path => {
      const draft = session.files.get(path);
      return entryFrom(path, await this.source(session, path), Boolean(draft), draft?.baseContent === null);
    }));
    this.active(session);
    return entries.sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : a.title.localeCompare(b.title)));
  }

  addMedia(prepared: PreparedPreview): Promise<string> {
    return this.enqueue(async session => {
      if (!(prepared.file instanceof File) || !prepared.file.size || prepared.file.size > 32 * 1024 * 1024 || prepared.url !== `/media/${prepared.file.name}`) throw new Error('Choose a prepared preview file of at most 32 MiB.');
      const entry = mediaEntry(prepared.entry, prepared.url);
      const registered = registryFrom(await this.source(session, registryPath)).files[prepared.url];
      this.active(session);
      if (registered) {
        if (registered.sha256 !== entry.sha256) throw new Error('A different published preview already uses that filename.');
        return prepared.url;
      }
      const existing = session.media.get(prepared.url);
      if (existing && existing.entry.sha256 !== entry.sha256) throw new Error('Another private preview already uses that filename.');
      // The same picture added twice is one file; pictures already showing keep their preview.
      if (existing) return prepared.url;
      session.media.set(prepared.url, { url: prepared.url, file: prepared.file, entry });
      this.emit();
      await this.save(session);
      return prepared.url;
    });
  }

  async media(): Promise<{ registry: PreviewRegistry; creator: string }> {
    const session = this.active();
    await this.writes;
    this.active(session);
    const [raw, site] = await Promise.all([this.source(session, registryPath), this.source(session, sitePath)]);
    this.active(session);
    const registry = registryFrom(raw);
    this.knownMedia = registry.files;
    for (const media of session.media.values()) {
      const existing = registry.files[media.url];
      if (existing && existing.sha256 !== media.entry.sha256) throw new Error('A private preview conflicts with the published media registry.');
      registry.files[media.url] = { ...media.entry };
    }
    const settings = JSON.parse(site);
    const creator = normalizeWatermarkCredit(settings.watermarkText)
      || (typeof settings.name === 'string' && settings.name.trim() ? normalizeWatermarkCredit(`© ${settings.name}`) : '');
    if (!creator) throw new Error('Set your site display name or watermark text before adding pictures.');
    return { registry, creator };
  }

  /** A prepared file's entry if known here (staged in this draft, or seen in the published registry). */
  mediaInfo(url: string): EditorMediaEntry | undefined {
    return this.session?.media.get(url)?.entry ?? this.knownMedia[url];
  }

  private knownMedia: Record<string, EditorMediaEntry> = {};

  mediaKind(url: string): EditorMediaEntry['kind'] | undefined {
    return this.session?.media.get(url)?.entry.kind ?? (previewPath.exec(url)?.[2] === 'mp4' ? 'video' : previewPath.exec(url)?.[2] === 'mp3' ? 'audio' : previewPath.test(url) ? 'image' : undefined);
  }

  resolveMedia(url: string): string {
    const draft = this.session?.media.get(url);
    if (draft) {
      let objectURL = this.objectURLs.get(url);
      if (!objectURL) { objectURL = URL.createObjectURL(draft.file); this.objectURLs.set(url, objectURL); }
      return objectURL;
    }
    // Published minutes ago but not deployed yet: GitHub already has the file.
    if (!this.local && this.session && previewPath.test(url)) {
      return `https://raw.githubusercontent.com/${this.session.snapshot.repository}/${this.session.snapshot.head}/public${url}`;
    }
    return url;
  }

  /** Progress of a publish that is running (shown in the taskbar); undefined when none is. */
  publishing?: string;

  /**
   * Publish all changes, or only the listed files (and the new media they use).
   * `mediaDeletions` removes unused prepared media files (as /media/... URLs) in the same commit.
   * It runs in the background: what goes live is fixed when it starts, uploads happen outside the
   * edit queue so editing and saving keep working, and later edits stay as drafts.
   */
  publish(paths?: string[], options: { message?: string; mediaDeletions?: string[]; onProgress?: (text: string) => void } = {}): Promise<EditorPublishResult> {
    if (this.publishing !== undefined) return Promise.reject(failure('A publish is already running. Wait for it to finish.'));
    const progress = (text: string) => { this.publishing = text; this.emit(); options.onProgress?.(text); };
    progress('Publishing…');
    return this.publishInBackground(paths, options, progress).finally(() => { this.publishing = undefined; this.emit(); });
  }

  private async publishInBackground(paths: string[] | undefined, options: { message?: string; mediaDeletions?: string[] }, progress: (text: string) => void): Promise<EditorPublishResult> {
    // 1. Fix what goes live, from the saved drafts.
    const plan = await this.enqueue(async session => {
      const selected = Array.from(session.files.values()).filter(file => !paths || paths.includes(file.path));
      const changes = selected.filter(file => !file.deleted).map(({ path, content }) => ({ path, content }));
      const deletions = [
        ...selected.filter(file => file.deleted && file.baseContent !== null).map(file => file.path),
        ...(options.mediaDeletions ?? []).filter(url => previewPath.test(url)).map(url => `public${url}`),
      ];
      if (!changes.length && !deletions.length) throw new Error('There is nothing selected to publish.');
      const references = new Set<string>();
      for (const change of changes) {
        const parsed = bindingDocument(change.content, change.path.endsWith('.md'));
        collectMediaReferences(parsed.value, references);
        if (parsed.parts) collectMediaReferences(parsed.parts.body, references);
      }
      // An animation brings its still along (the registry entry names it, the text does not).
      for (const media of session.media.values()) if (references.has(media.url) && media.entry.poster) references.add(media.entry.poster);
      const referenced = Array.from(session.media.values()).filter(media => references.has(media.url));
      return { session, baseCommit: session.snapshot.head, changes, deletions, references, referenced };
    });
    // 2. Each file goes straight to GitHub, one at a time: the editor service only names them.
    const media: EditorMediaUpload[] = [];
    for (const [index, item] of plan.referenced.entries()) {
      const size = item.file.size >= 1024 * 1024 ? `${(item.file.size / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(item.file.size / 1024))} KB`;
      progress(`Uploading ${plan.referenced.length > 1 ? `${index + 1} of ${plan.referenced.length}` : 'the file'} (${size})…`);
      media.push({ path: `public${item.url}`, blob: await this.uploadBlob(plan.session, item.url, item.entry, item.file), size: item.file.size, entry: item.entry });
      this.active(plan.session);
    }
    progress('Publishing…');
    // 3. Commit, then move everything else onto the new version.
    return this.enqueue(async session => {
      if (session !== plan.session) throw failure('The editor reconnected while publishing. Nothing was published; publish again.');
      const message = options.message?.replace(/\s+/g, ' ').trim().slice(0, 200) || undefined;
      // The base is the version the plan was made from: a publish from elsewhere meanwhile is a conflict.
      const value = await this.api(session.controller, '/editor/publish', { baseCommit: plan.baseCommit, changes: plan.changes, media, deletions: plan.deletions, ...(message ? { message } : {}) });
      this.active(session);
      const result = value as EditorPublishResult;
      if (!result || !/^[a-f0-9]{40}$/.test(result.commit) || typeof result.htmlUrl !== 'string'
        || result.htmlUrl !== `https://github.com/${session.snapshot.repository}/commit/${result.commit}`) throw new Error('The publish response could not be confirmed. Keep this draft and refresh before trying again.');
      let snapshot: EditorSnapshot;
      try {
        snapshot = snapshotFrom(await this.api(session.controller, '/editor'));
        this.active(session);
        this.sameOwner(session, snapshot);
      } catch (error) {
        const status = (error as { status?: number })?.status;
        throw failure(`Published, but the editor could not reload the latest version. Reload the page before editing more. ${error instanceof Error ? error.message : ''}`, status);
      }
      // Unselected changes, and edits made while uploading, stay as drafts on the new version.
      const published = new Map<string, string | null>([...plan.changes.map(change => [change.path, change.content] as const), ...plan.deletions.map(path => [path, null] as const)]);
      const remaining = new Map<string, EditorDraftFile>();
      for (const [path, file] of session.files) {
        const base = published.has(path) ? published.get(path)! : snapshot.files.some(item => item.path === path) ? await this.remote(session, snapshot, path, new Map()) : null;
        if (file.deleted) { if (base !== null) remaining.set(path, { ...file, baseContent: base }); }
        else if (file.content !== base) remaining.set(path, { ...file, baseContent: base });
      }
      const keep = new Map(Array.from(session.media).filter(([url]) => !plan.references.has(url)));
      await this.save(session, snapshot, remaining, keep);
      this.active(session);
      // Files the publish did not touch keep their loaded content.
      const unchanged = new Map<string, Promise<string>>();
      for (const [path, pending] of session.cache) {
        const before = session.snapshot.files.find(file => file.path === path)?.sha;
        if (before && snapshot.files.find(file => file.path === path)?.sha === before) unchanged.set(path, pending);
      }
      session.snapshot = snapshot;
      session.files = remaining;
      session.media = keep;
      session.cache = unchanged;
      for (const [url, objectURL] of this.objectURLs) {
        if (!keep.has(url)) { URL.revokeObjectURL(objectURL); this.objectURLs.delete(url); }
      }
      this.warning = undefined;
      this.emit();
      return result;
    });
  }

  discard(): Promise<void> {
    return this.enqueue(async session => {
      // Read first so a failed network request cannot erase the owner's saved work.
      const snapshot = snapshotFrom(await this.api(session.controller, '/editor'));
      this.active(session);
      this.sameOwner(session, snapshot);
      await this.save(session, snapshot, new Map(), new Map());
      this.active(session);
      session.snapshot = snapshot;
      session.files.clear();
      session.media.clear();
      session.cache.clear();
      this.revokeMedia();
      this.warning = undefined;
      this.emit();
    });
  }

  private sameOwner(session: Session, snapshot: EditorSnapshot): void {
    if (snapshot.owner.id !== session.snapshot.owner.id || snapshot.repository !== session.snapshot.repository || snapshot.branch !== session.snapshot.branch) throw failure('The editor owner or repository configuration changed. Sign in again before continuing.', 403);
  }

  /** Move drafts onto the latest published version. Returns files changed on both sides. */
  refresh(resolutions?: Record<string, 'draft' | 'remote'>): Promise<EditorConflict[]> {
    return this.enqueue(async session => {
      const snapshot = snapshotFrom(await this.api(session.controller, '/editor'));
      this.active(session);
      this.sameOwner(session, snapshot);
      const cache = new Map<string, Promise<string>>();
      const remoteFiles = new Map<string, string | null>();
      const [, registry] = await Promise.all([
        Promise.all(Array.from(session.files.values(), async file => {
          remoteFiles.set(file.path, snapshot.files.some(item => item.path === file.path)
            ? await this.remote(session, snapshot, file.path, cache) : null);
        })),
        session.media.size ? this.remote(session, snapshot, registryPath, cache).then(registryFrom) : undefined,
      ]);
      this.active(session);
      const media = new Map(session.media);
      if (registry) {
        for (const [url, staged] of media) {
          const registered = registry.files[url];
          if (!registered) continue;
          if (registered.sha256 !== staged.entry.sha256) throw new Error('A published picture now uses a private draft filename with different contents. Your draft has been kept unchanged.');
          media.delete(url);
        }
      }
      const conflicts: EditorConflict[] = [];
      for (const file of session.files.values()) {
        const remote = remoteFiles.get(file.path)!;
        if (remote !== file.baseContent && remote !== file.content) conflicts.push({ path: file.path, base: file.baseContent, draft: file.content, remote });
      }
      const unseen = conflicts.some(conflict => !session.conflicts?.some(previous => previous.path === conflict.path
        && previous.base === conflict.base && previous.draft === conflict.draft && previous.remote === conflict.remote));
      if (conflicts.length && (unseen || conflicts.some(conflict => !resolutions || !own(resolutions, conflict.path) || !['draft', 'remote'].includes(resolutions[conflict.path])))) {
        session.conflicts = conflicts.map(conflict => ({ ...conflict }));
        return conflicts;
      }
      const conflicted = new Set(conflicts.map(conflict => conflict.path));
      const files = new Map<string, EditorDraftFile>();
      for (const file of session.files.values()) {
        const remote = remoteFiles.get(file.path)!;
        if ((!file.deleted && remote === file.content) || (conflicted.has(file.path) && resolutions?.[file.path] === 'remote')) continue;
        if (file.deleted && remote === null) continue;
        files.set(file.path, { ...file, baseContent: remote });
      }
      await this.save(session, snapshot, files, media);
      this.active(session);
      session.snapshot = snapshot;
      session.files = files;
      session.media = media;
      for (const [url, objectURL] of this.objectURLs) {
        if (!media.has(url)) { URL.revokeObjectURL(objectURL); this.objectURLs.delete(url); }
      }
      session.cache = cache;
      session.conflicts = undefined;
      this.emit();
      return [];
    });
  }

  private revokeMedia(): void {
    for (const url of this.objectURLs.values()) URL.revokeObjectURL(url);
    this.objectURLs.clear();
  }

  private storageFailure(error: unknown): void {
    this.warning = `Your changes could not be saved on this device. ${error instanceof Error ? error.message : 'Browser storage is unavailable.'} Keep this tab open until you publish.`;
    this.emit();
  }

  private async persist(session: Session, record: SavedDraft): Promise<void> {
    const empty = !record.files.length && !record.media.length;
    await writeIfRevision('drafts', session.key, session.revision, empty ? undefined : record);
    this.active(session);
    session.revision = empty ? 0 : record.revision;
    this.channel?.postMessage({ key: session.key, head: record.snapshot.head });
  }

  private async save(session: Session, snapshot = session.snapshot, files = session.files, media = session.media): Promise<void> {
    try {
      await this.persist(session, {
        key: session.key, revision: session.revision + 1, snapshot,
        files: Array.from(files.values()), media: Array.from(media.values()),
      });
      if (this.warning) { this.warning = undefined; this.emit(); }
    } catch (error) { if (this.session === session) this.storageFailure(error); throw error; }
  }

  /** Prepared media nothing uses: not published content, not site code, and not your unpublished changes. */
  async unusedMedia(): Promise<Array<{ url: string; entry: EditorMediaEntry }>> {
    const session = this.active();
    await this.writes;
    const value = await this.api(session.controller, '/editor/unused-media') as { head?: string; media?: Array<{ url: string; entry: EditorMediaEntry }> };
    this.active(session);
    const drafts = new Set<string>();
    for (const file of session.files.values()) if (!file.deleted) collectMediaReferences(file.content, drafts);
    return (value.media ?? []).filter(item => previewPath.test(item.url) && !drafts.has(item.url));
  }

  /** Earlier published versions of a file, newest first. */
  async history(path: string): Promise<Array<{ commit: string; message: string; date: string }>> {
    const session = this.active();
    assertPath(path, true);
    const value = await this.api(session.controller, `/editor/history?${new URLSearchParams({ path })}`) as { versions?: Array<{ commit: string; message: string; date: string }> };
    return (value.versions ?? []).filter(item => /^[a-f0-9]{40}$/.test(item.commit));
  }

  /** A file exactly as it was in one earlier commit. */
  async version(path: string, commit: string): Promise<string> {
    const session = this.active();
    assertPath(path, true);
    const value = await this.api(session.controller, `/editor/version?${new URLSearchParams({ path, commit })}`) as { content?: unknown };
    if (typeof value.content !== 'string') throw new Error('That version could not be read.');
    return value.content;
  }

  /** For owner-only services outside the editor API (analytics). */
  accessToken(): Promise<string> {
    return this.auth.token();
  }

  /** Throws on a missing sign-in so callers can show the sign-in prompt. */
  requireSession(): void {
    if (!this.session) throw authFailure('Sign in with GitHub to edit the website.');
  }
}
