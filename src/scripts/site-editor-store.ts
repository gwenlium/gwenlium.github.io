import { parseDocument } from 'yaml';
import type { PreparedPreview } from './admin-media';
import type { PreviewRegistry } from './admin-github';
import { normalizeWatermarkCredit } from '../lib/watermark.mjs';
import type {
  EditorBinding, EditorConflict, EditorDraftFile, EditorFile, EditorMediaEntry,
  EditorPublishRequest, EditorPublishResult, EditorSnapshot,
} from '../lib/site-editor-types';

const registryPath = 'src/content/media-previews.json';
const sitePath = 'src/content/site.json';
const previewPath = /^\/media\/[a-z0-9]+(?:-[a-z0-9]+)*-preview-([a-f0-9]{32})\.(webp|gif|mp4|mp3)$/;
const tokenPattern = /^ghu_[A-Za-z0-9]{1,508}$/;
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
  token: string;
  controller: AbortController;
  key: string;
  revision: number;
  snapshot: EditorSnapshot;
  files: Map<string, EditorDraftFile>;
  media: Map<string, StagedMedia>;
  cache: Map<string, Promise<string>>;
  conflicts?: EditorConflict[];
};

function failure(message: string, status?: number): Error & { status?: number } {
  return Object.assign(new Error(message), status === undefined ? {} : { status });
}

function editablePath(path: string): boolean {
  if (typeof path !== 'string' || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) return false;
  return /^src\/content\/(?:site|windows|gallery|music)\.json$/.test(path)
    || /^src\/content\/pages\/[^/]+\.json$/.test(path)
    || /^src\/content\/posts\/(?:[^/]+\/)*[^/]+\.md$/.test(path);
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
    || typeof item.owner.login !== 'string' || !item.owner.login || !Array.isArray(item.files)) {
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
    // The container was narrowed above; the resolved key only accesses its own entries.
    const container = current as Record<string | number, unknown>;
    current = own(container, key) ? container[key] : undefined;
    if (current === undefined && !last) throw new Error('The parent of this editable field no longer exists.');
  }
  return { path, value: current };
}

function markdownParts(content: string) {
  const opening = /^(?:\uFEFF)?---[ \t]*\r?\n/.exec(content);
  if (!opening) return { opening: '---\n', closing: '---\n', prefix: '', yaml: '', body: content };
  const rest = content.slice(opening[0].length);
  const closing = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(rest);
  if (!closing) throw new Error('This Markdown file has unclosed frontmatter.');
  const end = opening[0].length + closing.index + closing[0].length;
  return { opening: opening[0], closing: closing[0], prefix: content.slice(0, end), yaml: rest.slice(0, closing.index), body: content.slice(end) };
}

function bindingDocument(content: string, markdown: boolean) {
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
    || Object.keys(entry).some(key => !['sha256', 'kind', 'width', 'height', 'duration'].includes(key))
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

async function base64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunks: string[] = [];
  for (let index = 0; index < bytes.length; index += 0x8000) chunks.push(String.fromCharCode(...bytes.subarray(index, index + 0x8000)));
  return btoa(chunks.join(''));
}

/** Owner authorization and private, explicitly published drafts. Tokens never leave memory. */
export class SiteEditorStore {
  private readonly authOrigin: string;
  private readonly siteOrigin: string;
  private session?: Session;
  private generation = 0;
  private pendingAuth?: AbortController;
  private cancelPopup?: () => void;
  private writes: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  private objectURLs = new Map<string, string>();
  private database?: Promise<IDBDatabase>;
  private warning?: string;

  constructor(options: { authOrigin: string; siteOrigin: string }) {
    const auth = new URL(options.authOrigin);
    const site = new URL(options.siteOrigin);
    if (auth.protocol !== 'https:' || site.protocol !== 'https:' || auth.username || auth.password || site.username || site.password) throw new Error('The editor requires HTTPS origins without URL credentials.');
    this.authOrigin = auth.origin;
    this.siteOrigin = site.origin;
  }

  get authenticated(): boolean { return !!this.session; }
  get dirty(): boolean { return !!this.session?.files.size; }
  get snapshot(): EditorSnapshot | undefined { return this.session ? structuredClone(this.session.snapshot) : undefined; }
  get draftFiles(): EditorDraftFile[] { return this.session ? Array.from(this.session.files.values(), file => ({ ...file })) : []; }
  get storageWarning(): string | undefined { return this.warning; }

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

  private async api(token: string, controller: AbortController, path: string, body?: EditorPublishRequest): Promise<unknown> {
    const response = await fetch(`${this.authOrigin}${path}`, {
      method: body ? 'POST' : 'GET', mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'error',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
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

  signIn(): Promise<void> {
    if (window.location.origin !== this.siteOrigin) return Promise.reject(failure('Open the editor on its configured website origin.', 403));
    this.cancelPopup?.();
    const url = new URL('/auth', this.authOrigin);
    url.searchParams.set('provider', 'github');
    url.searchParams.set('site_id', new URL(this.siteOrigin).host);
    // Opening before the first await preserves the browser's user-activation permission.
    const popup = window.open(url.href, '_blank', 'popup,width=640,height=760');
    if (!popup) return Promise.reject(new Error('Allow the GitHub sign-in popup, then try again.'));
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    let handshaken = false;
    let finished = false;
    const cleanup = () => {
      window.removeEventListener('message', receive);
      clearTimeout(timeout);
      clearInterval(closed);
      this.cancelPopup = undefined;
      try { popup.close(); } catch { /* The popup may already be closed. */ }
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
        catch { finish(new Error('The GitHub sign-in window could not complete authorization.')); }
        return;
      }
      if (!handshaken) return;
      const success = 'authorization:github:success:';
      const error = 'authorization:github:error:';
      if (event.data.startsWith(error)) {
        finish(new Error('GitHub did not authorize the configured website owner.'));
        return;
      }
      if (!event.data.startsWith(success)) return;
      let data: unknown;
      try { data = JSON.parse(event.data.slice(success.length)); }
      catch { finish(new Error('GitHub returned an invalid authorization response.')); return; }
      if (!data || typeof data !== 'object' || !('provider' in data) || data.provider !== 'github'
        || !('token' in data) || typeof data.token !== 'string' || !tokenPattern.test(data.token)) {
        finish(new Error('GitHub returned an invalid authorization token.'));
        return;
      }
      finish();
      void this.connect(data.token).then(resolve, reject);
    };
    const timeout = window.setTimeout(() => finish(new Error('GitHub sign-in timed out. Try signing in again.')), 5 * 60 * 1000);
    const closed = window.setInterval(() => { if (popup.closed) finish(new Error('GitHub sign-in was cancelled.')); }, 400);
    this.cancelPopup = () => finish(new Error('GitHub sign-in was cancelled.'));
    window.addEventListener('message', receive);
    return promise;
  }

  async connect(token: string): Promise<void> {
    if (window.location.origin !== this.siteOrigin) throw failure('Open the editor on its configured website origin.', 403);
    if (!tokenPattern.test(token)) throw failure('A valid GitHub App owner token is required.', 401);
    this.signOut();
    const generation = this.generation;
    const controller = new AbortController();
    this.pendingAuth = controller;
    try {
      const verified = snapshotFrom(await this.api(token, controller, '/editor'));
      if (generation !== this.generation) throw failure('Sign-in was cancelled.', 401);
      const key = JSON.stringify([this.siteOrigin, verified.owner.id, verified.repository]);
      let saved: SavedDraft | undefined;
      try { saved = await this.load(key); }
      catch (error) { this.storageFailure(error); throw error; }
      if (generation !== this.generation) throw failure('Sign-in was cancelled.', 401);
      const session: Session = {
        token, controller, key, revision: saved?.revision ?? 0, snapshot: verified,
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
          if (file.content !== file.baseContent) session.files.set(file.path, { ...file });
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
    } finally {
      if (this.pendingAuth === controller) this.pendingAuth = undefined;
    }
  }

  signOut(): void {
    this.generation++;
    this.cancelPopup?.();
    this.pendingAuth?.abort();
    this.pendingAuth = undefined;
    if (this.session) {
      this.session.controller.abort();
      this.session.token = '';
      this.session.files.clear();
      this.session.media.clear();
      this.session.cache.clear();
      this.session.conflicts = undefined;
      this.session = undefined;
    }
    this.revokeMedia();
    this.warning = undefined;
    this.emit();
  }

  private async remote(session: Session, snapshot: EditorSnapshot, path: string, cache: Map<string, Promise<string>>): Promise<string> {
    assertPath(path);
    const expected = snapshot.files.find(file => file.path === path);
    if (!expected) throw failure('This file does not exist at the draft base commit.', 404);
    let pending = cache.get(path);
    if (!pending) {
      pending = this.api(session.token, session.controller, `/editor/file?${new URLSearchParams({ path, ref: snapshot.head })}`).then(value => {
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

  private source(session: Session, path: string): Promise<string> {
    assertPath(path);
    const draft = session.files.get(path);
    return draft ? Promise.resolve(draft.content) : this.remote(session, session.snapshot, path, session.cache);
  }

  async read(path: string): Promise<string> {
    const session = this.active();
    await this.writes;
    return this.source(this.active(session), path);
  }

  private async update(session: Session, path: string, content: string): Promise<void> {
    assertPath(path, true);
    if (typeof content !== 'string') throw new Error('File content must be text.');
    const prior = session.files.get(path);
    const baseContent = prior ? prior.baseContent : session.snapshot.files.some(file => file.path === path)
      ? await this.remote(session, session.snapshot, path, session.cache) : null;
    this.active(session);
    if (!this.warning && content === (prior?.content ?? baseContent)) return;
    if (content === baseContent) session.files.delete(path);
    else session.files.set(path, { path, baseContent, content });
    this.emit();
    await this.save(session);
  }

  write(path: string, content: string): Promise<void> {
    return this.enqueue(session => this.update(session, path, content));
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
        const yaml = parsed.document.toString();
        result = parsed.parts.opening + yaml + parsed.parts.closing + parsed.parts.body;
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
      session.media.set(prepared.url, { url: prepared.url, file: prepared.file, entry });
      const priorURL = this.objectURLs.get(prepared.url);
      if (priorURL) { URL.revokeObjectURL(priorURL); this.objectURLs.delete(prepared.url); }
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
    for (const media of session.media.values()) {
      const existing = registry.files[media.url];
      if (existing && existing.sha256 !== media.entry.sha256) throw new Error('A private preview conflicts with the published media registry.');
      registry.files[media.url] = { ...media.entry };
    }
    const settings = JSON.parse(site);
    const creator = normalizeWatermarkCredit(settings.watermarkText)
      || (typeof settings.name === 'string' && settings.name.trim() ? normalizeWatermarkCredit(`© ${settings.name}`) : '');
    if (!creator) throw new Error('Set your site display name or watermark text before preparing media.');
    return { registry, creator };
  }

  resolveMedia(url: string): string {
    const draft = this.session?.media.get(url);
    if (draft) {
      let objectURL = this.objectURLs.get(url);
      if (!objectURL) { objectURL = URL.createObjectURL(draft.file); this.objectURLs.set(url, objectURL); }
      return objectURL;
    }
    if (this.session && previewPath.test(url)) {
      return `https://raw.githubusercontent.com/${this.session.snapshot.repository}/${this.session.snapshot.head}/public${url}`;
    }
    return url;
  }

  publish(): Promise<EditorPublishResult> {
    return this.enqueue(async session => {
      const changes = Array.from(session.files.values(), ({ path, content }) => ({ path, content }));
      if (!changes.length) throw new Error('There are no changed files to publish. Add a staged preview to a page before publishing it.');
      const references = new Set<string>();
      for (const change of changes) {
        const parsed = bindingDocument(change.content, change.path.endsWith('.md'));
        collectMediaReferences(parsed.value, references);
        if (parsed.parts) collectMediaReferences(parsed.parts.body, references);
      }
      const referenced = Array.from(session.media.values()).filter(media => references.has(media.url));
      const media = await Promise.all(referenced.map(async item => ({ path: `public${item.url}`, content: await base64(item.file), entry: item.entry })));
      this.active(session);
      const value = await this.api(session.token, session.controller, '/editor/publish', { baseCommit: session.snapshot.head, changes, media });
      this.active(session);
      const result = value as EditorPublishResult;
      if (!result || !/^[a-f0-9]{40}$/.test(result.commit) || typeof result.htmlUrl !== 'string'
        || result.htmlUrl !== `https://github.com/${session.snapshot.repository}/commit/${result.commit}`) throw new Error('The publish response could not be confirmed. Keep this draft and refresh before trying again.');
      let snapshot: EditorSnapshot;
      try {
        snapshot = snapshotFrom(await this.api(session.token, session.controller, '/editor'));
        this.active(session);
        this.sameOwner(session, snapshot);
        await this.removeSaved(session);
      } catch (error) {
        const status = error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : undefined;
        throw failure(`Published commit ${result.commit}, but the local draft could not be cleared and refreshed. Keep it and use Refresh before publishing again. ${error instanceof Error ? error.message : ''}`, status);
      }
      this.active(session);
      session.snapshot = snapshot;
      session.files.clear();
      session.media.clear();
      session.cache.clear();
      this.revokeMedia();
      this.warning = undefined;
      this.emit();
      return result;
    });
  }

  discard(): Promise<void> {
    return this.enqueue(async session => {
      // Read first so a failed network request cannot erase the owner's saved work.
      const snapshot = snapshotFrom(await this.api(session.token, session.controller, '/editor'));
      this.active(session);
      this.sameOwner(session, snapshot);
      await this.removeSaved(session);
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

  refresh(resolutions?: Record<string, 'draft' | 'remote'>): Promise<EditorConflict[]> {
    return this.enqueue(async session => {
      const snapshot = snapshotFrom(await this.api(session.token, session.controller, '/editor'));
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
          if (registered.sha256 !== staged.entry.sha256) throw new Error('A published preview now uses a private draft filename with different contents. Your private draft and preview have been kept unchanged.');
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
      if (unseen || conflicts.some(conflict => !resolutions || !own(resolutions, conflict.path) || !['draft', 'remote'].includes(resolutions[conflict.path]))) {
        session.conflicts = conflicts.map(conflict => ({ ...conflict }));
        return conflicts;
      }
      const conflicted = new Set(conflicts.map(conflict => conflict.path));
      const files = new Map<string, EditorDraftFile>();
      for (const file of session.files.values()) {
        const remote = remoteFiles.get(file.path)!;
        if (remote === file.content || (conflicted.has(file.path) && resolutions?.[file.path] === 'remote')) continue;
        files.set(file.path, { path: file.path, baseContent: remote, content: file.content });
      }
      // Persist the entire resolved rebase before replacing the original state.
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
    this.warning = `The private draft could not be saved or restored on this device. ${error instanceof Error ? error.message : 'Browser storage is unavailable.'}`;
    this.emit();
  }

  private db(): Promise<IDBDatabase> {
    if (this.database) return this.database;
    const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
    this.database = promise;
    try {
      const request = indexedDB.open('gwenlium-site-editor', 1);
      let failed = false;
      request.onupgradeneeded = () => { request.result.createObjectStore('drafts', { keyPath: 'key' }); };
      request.onerror = () => { failed = true; reject(request.error ?? new Error('Private draft storage could not be opened.')); };
      request.onblocked = () => { failed = true; reject(new Error('Close other editor tabs to open private draft storage.')); };
      request.onsuccess = () => {
        const db = request.result;
        if (failed) { db.close(); return; }
        db.onversionchange = () => { db.close(); this.database = undefined; };
        resolve(db);
      };
    } catch (error) { reject(error); }
    void promise.catch(() => { if (this.database === promise) this.database = undefined; });
    return promise;
  }

  private async load(key: string): Promise<SavedDraft | undefined> {
    const db = await this.db();
    const { promise, resolve, reject } = Promise.withResolvers<SavedDraft | undefined>();
    const transaction = db.transaction('drafts', 'readonly');
    const request = transaction.objectStore('drafts').get(key);
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error ?? new Error('The private draft could not be read.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('The private draft read was interrupted.'));
    return promise;
  }

  private async persist(session: Session, record?: SavedDraft): Promise<void> {
    const db = await this.db();
    this.active(session);
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const transaction = db.transaction('drafts', 'readwrite');
    const store = transaction.objectStore('drafts');
    const request = store.get(session.key);
    let conflict: Error | undefined;
    request.onsuccess = () => {
      const saved: SavedDraft | undefined = request.result;
      if ((saved?.revision ?? 0) !== session.revision) {
        conflict = new Error('Another editor tab changed this private draft. Your edits remain in this tab; do not close it or overwrite the other tab.');
        transaction.abort();
        return;
      }
      if (record) store.put(record);
      else store.delete(session.key);
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(conflict ?? transaction.error ?? new Error('The private draft could not be saved.'));
    transaction.onabort = () => reject(conflict ?? transaction.error ?? new Error('The private draft save was interrupted.'));
    await promise;
    this.active(session);
    session.revision = record?.revision ?? 0;
  }

  private async save(session: Session, snapshot = session.snapshot, files = session.files, media = session.media): Promise<void> {
    try {
      await this.persist(session, {
        key: session.key, revision: session.revision + 1, snapshot,
        files: Array.from(files.values()), media: Array.from(media.values()),
      });
      this.warning = undefined;
      this.emit();
    } catch (error) { if (this.session === session) this.storageFailure(error); throw error; }
  }

  private async removeSaved(session: Session): Promise<void> {
    try { await this.persist(session); }
    catch (error) { if (this.session === session) this.storageFailure(error); throw error; }
  }
}
