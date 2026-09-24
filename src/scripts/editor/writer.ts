import { Document, parseDocument } from 'yaml';
import { navigate } from 'astro:transitions/client';
import { storePreview } from './preview';
import { ownerStore, writerUrl } from './session';
import { isPostPath, markdownParts, type EntrySummary, type SiteEditorStore } from './store';
import { createRichText, type RichTextHandle } from './rich-text';
import { chooseFromLibrary, stageFiles } from './media';
import { openPublish, resolveConflicts } from './publish';
import { button, confirmAction, errorText, node, openDialog, toast } from './ui';
import '../../styles/owner-editor.css';

type Section = 'devlog' | 'life';
type MediaItem = { type: 'image' | 'video' | 'audio'; src: string; alt: string; caption: string; poster: string };
type Model = {
  section: Section; draft: boolean; title: string; permalink: string; date: string; publishAt: string; excerpt: string;
  tags: string[]; featured: boolean; cover: string; coverAlt: string; media: MediaItem[]; body: string;
};

const journals: Record<Section, string> = { devlog: 'Devlog', life: 'Life' };
const today = () => new Date().toISOString().slice(0, 10);
const dateFormat = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const formatDate = (value: string) => {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) ? dateFormat.format(date) : 'No date';
};

export function slugify(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
}

function stringValue(value: unknown): string { return typeof value === 'string' ? value : ''; }

function readModel(content: string): { model: Model; photos: string[] } {
  const parts = markdownParts(content);
  const document = parseDocument(parts.yaml);
  const data = (document.toJS({ maxAliasCount: 50 }) ?? {}) as Record<string, unknown>;
  const date = data.date instanceof Date ? data.date.toISOString().slice(0, 10) : stringValue(data.date);
  const photos = Array.isArray(data.photos) ? data.photos.filter((item): item is string => typeof item === 'string' && Boolean(item)) : [];
  const media = Array.isArray(data.media) ? data.media.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const value = item as Record<string, unknown>;
    const type = value.type === 'video' || value.type === 'audio' ? value.type : 'image';
    return stringValue(value.src) ? [{ type, src: stringValue(value.src), alt: stringValue(value.alt), caption: stringValue(value.caption), poster: stringValue(value.poster) } as MediaItem] : [];
  }) : [];
  return {
    photos,
    model: {
      section: data.section === 'life' ? 'life' : 'devlog',
      draft: data.draft !== false,
      title: stringValue(data.title),
      permalink: stringValue(data.permalink),
      date,
      publishAt: data.publishAt instanceof Date ? data.publishAt.toISOString() : stringValue(data.publishAt),
      excerpt: stringValue(data.excerpt),
      tags: Array.isArray(data.tags) ? data.tags.filter((tag): tag is string => typeof tag === 'string') : [],
      featured: data.featured === true,
      cover: stringValue(data.cover),
      coverAlt: stringValue(data.coverAlt),
      // Older entries kept undescribed pictures in a separate list; they show first, so they stay first.
      media: [...photos.map(src => ({ type: 'image' as const, src, alt: '', caption: '', poster: '' })), ...media],
      body: parts.body.replace(/^\r?\n/, ''),
    },
  };
}

/** Write the model back, touching only fields that changed so hand-written YAML keeps its shape. */
function composePost(original: string | null, before: Model | undefined, model: Model, mediaTouched: boolean): string {
  const parts = original ? markdownParts(original) : undefined;
  const document = parts ? parseDocument(parts.yaml) : new Document({});
  const assign = (key: keyof Model | 'photos', value: unknown, empty: boolean) => {
    const previous = before ? (key === 'photos' ? undefined : before[key as keyof Model]) : undefined;
    if (before && key !== 'photos' && JSON.stringify(previous) === JSON.stringify(value)) return;
    if (empty) document.delete(key);
    else document.set(key, value);
  };
  assign('section', model.section, false);
  assign('draft', model.draft, false);
  assign('title', model.title, false);
  assign('permalink', model.permalink, !model.permalink);
  assign('date', model.date, !model.date);
  assign('publishAt', model.publishAt, !model.publishAt);
  assign('excerpt', model.excerpt, !model.excerpt.trim());
  assign('tags', model.tags, !model.tags.length);
  assign('featured', model.featured, !model.featured);
  assign('cover', model.cover, !model.cover);
  assign('coverAlt', model.coverAlt, !model.cover);
  if (mediaTouched) {
    document.delete('photos');
    if (model.media.length) document.set('media', model.media.map(item => ({ type: item.type, src: item.src, alt: item.alt, caption: item.caption, ...(item.poster ? { poster: item.poster } : {}) })));
    else document.delete('media');
  }
  const body = model.body.trim() ? `${model.body.replace(/\s+$/, '')}\n` : '';
  const yaml = document.toString();
  return `${parts?.opening ?? '---\n'}${yaml}${parts?.closing ?? '---\n'}${body}`;
}

let active: Writer | undefined;
const placeKey = 'gwenlium:writer-place';

export async function mountWriter(root: HTMLElement): Promise<void> {
  active?.destroy();
  active = new Writer(root, ownerStore());
  await active.start();
}

export function unmountWriter(): void {
  active?.destroy();
  active = undefined;
}

class Writer {
  private lifetime = new AbortController();
  private path?: string;
  private original: string | null = null;
  private saved?: Model;
  private model?: Model;
  private mediaTouched = false;
  private slugTouched = false;
  private entries: EntrySummary[] = [];
  private editor?: RichTextHandle;
  private saveTimer?: number;
  private saving: Promise<void> = Promise.resolve();
  private status = node('p', '', 'writer-status');
  private unsubscribe?: () => void;

  constructor(private root: HTMLElement, private store: SiteEditorStore) {
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    addEventListener('beforeunload', () => { void this.flush(); }, { signal: this.lifetime.signal });
    // Ctrl+S (Cmd+S on a Mac) saves right away instead of opening the browser's save dialog.
    addEventListener('keydown', event => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 's') return;
      event.preventDefault();
      if (this.model) void this.flush().then(() => { this.status.textContent = this.store.storageWarning ?? 'Saved on this browser'; });
    }, { signal: this.lifetime.signal });
  }

  destroy(): void {
    void this.flush();
    this.lifetime.abort();
    this.editor?.destroy();
    this.unsubscribe?.();
  }

  async start(): Promise<void> {
    this.root.replaceChildren(node('p', 'Opening the editor…', 'writer-loading'));
    try {
      if (!await this.store.restore()) { this.signIn(); return; }
    } catch (error) {
      this.root.replaceChildren(node('p', errorText(error, 'The editor could not connect.'), 'writer-loading'));
      return;
    }
    this.unsubscribe = this.store.subscribe(() => this.refreshChrome());
    await this.route();
    requestAnimationFrame(() => this.makeRoom());
  }

  /** Floating windows (like the music player) go to the taskbar while they cover the writing desk. */
  private makeRoom(): void {
    const desk = this.root.getBoundingClientRect();
    const focused = document.activeElement instanceof HTMLElement && this.root.contains(document.activeElement) ? document.activeElement : undefined;
    // Minimizing moves focus to the taskbar; the writer keeps it.
    setTimeout(() => {
      if (focused) focused.focus({ preventScroll: true });
      else if (document.activeElement instanceof HTMLElement && document.activeElement.closest('.taskbar')) document.activeElement.blur();
    }, 400);
    for (const window of document.querySelectorAll<HTMLElement>('[data-desktop-window][data-window-floating]:not([hidden])')) {
      const box = window.getBoundingClientRect();
      const overlaps = box.left < desk.right && box.right > desk.left && box.top < desk.bottom && box.bottom > desk.top;
      if (overlaps && window.id) document.dispatchEvent(new CustomEvent('gwenlium:window-command', { detail: { id: window.id, action: 'minimize' } }));
    }
  }

  private signIn(): void {
    const window = this.frame('Owner sign-in', 'sage', 'writer-signin');
    const body = window.querySelector('.window-body')!;
    const status = node('p', '', 'owner-hint');
    const signIn = button('Sign in with GitHub', () => {
      const signing = this.store.signIn();
      signIn.disabled = true;
      status.textContent = 'Waiting for GitHub…';
      signing.then(() => location.reload(), error => { status.textContent = errorText(error); signIn.disabled = false; });
    }, 'owner-button owner-button--primary');
    body.append(node('h1', 'Write on your website', 'writer-signin__title'), node('p', 'This page is only for the site owner. Sign in once and this browser stays signed in.'), signIn, status);
    this.root.replaceChildren(window);
  }

  private async route(): Promise<void> {
    const params = new URL(location.href).searchParams;
    const entry = params.get('entry');
    const fresh = params.get('new');
    this.entries = await this.store.entries();
    if (entry && isPostPath(entry)) {
      if (!this.store.exists(entry)) { toast('That entry no longer exists.'); history.replaceState(history.state, '', writerUrl()); this.renderList(); return; }
      await this.open(entry);
    } else if (fresh) this.create(fresh === 'life' ? 'life' : 'devlog');
    else this.renderList();
  }

  private frame(title: string, tone: 'sage' | 'pink' | 'lavender', className: string): HTMLElement {
    const section = node('section', undefined, `window window--${tone} ${className}`);
    const titlebar = node('div', undefined, 'window-titlebar');
    titlebar.append(node('span', '', 'window-titlebar__mark'), node('span', title, 'window-titlebar__title'));
    section.append(titlebar, node('div', undefined, 'window-body'));
    return section;
  }

  private topBar(list = false): HTMLElement {
    const bar = node('div', undefined, 'writer-top');
    if (!list) {
      const all = node('a', '← All entries', 'owner-button');
      all.href = writerUrl();
      all.addEventListener('click', event => { event.preventDefault(); this.goto(writerUrl()); });
      const create = button('+ New entry', () => this.goto(writerUrl({ fresh: true, section: this.model?.section ?? 'devlog' })), 'owner-button');
      bar.append(all, create);
    }
    bar.append(this.status);
    return bar;
  }

  /** Every move inside the writer goes through the site's router, so Back and Forward always agree. */
  private goto(href: string): void {
    void this.flush().then(() => navigate(href));
  }

  // The list of entries

  private renderList(filter: 'all' | Section = 'all'): void {
    this.editor?.destroy();
    this.editor = undefined;
    const window = this.frame('Your entries', 'sage', 'writer-list');
    const body = window.querySelector('.window-body')!;
    const actions = node('div', undefined, 'writer-list__actions');
    actions.append(
      button('+ New Devlog entry', () => this.goto(writerUrl({ fresh: true, section: 'devlog' })), 'owner-button owner-button--primary'),
      button('+ New Life entry', () => this.goto(writerUrl({ fresh: true, section: 'life' })), 'owner-button'),
    );
    const filters = node('div', undefined, 'writer-segmented');
    filters.setAttribute('role', 'group');
    filters.setAttribute('aria-label', 'Show');
    for (const [value, label] of [['all', 'All'], ['devlog', 'Devlog'], ['life', 'Life']] as const) {
      const choice = button(label, () => this.renderList(value), 'writer-segmented__option');
      choice.setAttribute('aria-pressed', String(filter === value));
      filters.append(choice);
    }
    const list = node('ul', undefined, 'writer-entries');
    const shown = this.entries.filter(entry => filter === 'all' || entry.section === filter);
    if (!shown.length) list.append(node('li', 'Nothing here yet. Start a new entry above.', 'writer-entries__empty'));
    for (const entry of shown) {
      const item = node('li');
      const link = node('a', undefined, 'writer-entry');
      link.href = writerUrl({ entry: entry.path });
      link.addEventListener('click', event => { event.preventDefault(); this.goto(link.href); });
      const thumb = node('span', undefined, 'writer-entry__thumb');
      if (entry.cover) { const image = node('img'); image.src = this.store.resolveMedia(entry.cover); image.alt = ''; thumb.append(image); }
      const text = node('span', undefined, 'writer-entry__text');
      text.append(node('strong', entry.title || 'Untitled entry'), node('small', `${journals[entry.section]} · ${entry.date ? formatDate(entry.date) : 'No date'}`));
      const badges = node('span', undefined, 'writer-entry__badges');
      badges.append(this.badge(entry));
      if (entry.changed) badges.append(node('span', entry.isNew ? 'Not published yet' : 'Unpublished changes', 'writer-badge writer-badge--changed'));
      link.append(thumb, text, badges);
      item.append(link);
      list.append(item);
    }
    body.append(actions, filters, list);
    this.root.replaceChildren(this.topBar(true), window);
    this.refreshChrome();
  }

  private badge(entry: { draft: boolean; date: string; publishAt?: string }): HTMLElement {
    if (entry.draft) return node('span', 'Hidden', 'writer-badge writer-badge--hidden');
    if (entry.date > today() || (entry.publishAt && Date.parse(entry.publishAt) > Date.now())) return node('span', `Scheduled`, 'writer-badge writer-badge--scheduled');
    return node('span', 'Public', 'writer-badge writer-badge--public');
  }

  // Opening and creating entries

  private uniquePermalink(base: string): string {
    const taken = new Set(this.entries.filter(entry => entry.path !== this.path).map(entry => entry.permalink));
    const root = base || 'entry';
    if (!taken.has(root)) return root;
    for (let index = 2; ; index++) if (!taken.has(`${root}-${index}`)) return `${root}-${index}`;
  }

  private uniquePath(permalink: string): string {
    const base = permalink || `untitled-${today()}`;
    let candidate = `src/content/posts/${base}.md`;
    for (let index = 2; this.store.exists(candidate) && candidate !== this.path; index++) candidate = `src/content/posts/${base}-${index}.md`;
    return candidate;
  }

  private create(section: Section): void {
    this.original = null;
    this.saved = undefined;
    this.path = undefined;
    this.mediaTouched = true;
    this.slugTouched = false;
    this.model = { section, draft: false, title: '', permalink: '', date: today(), publishAt: '', excerpt: '', tags: [], featured: false, cover: '', coverAlt: '', media: [], body: '' };
    this.render(true);
  }

  private async open(path: string): Promise<void> {
    const content = await this.store.read(path);
    const draft = this.store.draftFiles.find(file => file.path === path);
    this.path = path;
    this.original = content;
    const { model, photos } = readModel(content);
    this.model = model;
    this.saved = structuredClone(model);
    this.mediaTouched = false;
    // A published address is part of shared links; a never-published one follows the title.
    this.slugTouched = !(draft?.baseContent === null) || Boolean(model.permalink && model.permalink !== slugify(model.title));
    if (photos.length) this.mediaTouched = false;
    this.render(false);
  }

  private get isNew(): boolean {
    return !this.path || this.store.draftFiles.find(file => file.path === this.path)?.baseContent === null;
  }

  private get wasPublished(): boolean {
    if (!this.path || this.isNew) return false;
    const base = this.store.draftFiles.find(file => file.path === this.path)?.baseContent ?? this.original;
    try { return base !== null && readModel(base).model.draft === false; } catch { return false; }
  }

  // Saving

  /** Words and reading time of the text (about 200 words a minute). */
  private countWords(): void {
    const counter = this.root.querySelector('.writer-count');
    if (!counter) return;
    const text = this.root.querySelector('.rt-surface .ProseMirror')?.textContent ?? '';
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    counter.textContent = words ? `${words} word${words === 1 ? '' : 's'} · ${Math.max(1, Math.round(words / 200))} min read` : '';
  }

  private changed(): void {
    clearTimeout(this.saveTimer);
    this.countWords();
    this.status.textContent = 'Saving…';
    this.saveTimer = window.setTimeout(() => void this.flush(), 450);
    this.updateHeader();
  }

  private flush(): Promise<void> {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    const model = this.model;
    if (!model) return this.saving;
    this.saving = this.saving.then(async () => {
      if (this.lifetime.signal.aborted && !model) return;
      const empty = !model.title.trim() && !model.body.trim() && !model.media.length && !model.cover;
      if (!this.path && empty) { this.status.textContent = ''; return; }
      try {
        if (!this.slugTouched && this.isNew) model.permalink = this.uniquePermalink(slugify(model.title));
        const nextPath = this.isNew ? this.uniquePath(model.permalink) : this.path!;
        const content = composePost(this.isNew ? null : this.original, this.isNew ? undefined : this.saved, model, this.mediaTouched);
        const previous = this.path;
        await this.store.write(nextPath, content);
        // A new entry's file follows its address until it is first published.
        if (previous && previous !== nextPath) await this.store.remove(previous);
        if (this.path !== nextPath) {
          this.path = nextPath;
          if (!this.lifetime.signal.aborted) history.replaceState(history.state, '', writerUrl({ entry: nextPath }));
        }
        if (!this.lifetime.signal.aborted) this.status.textContent = this.store.storageWarning ?? 'Saved on this browser';
      } catch (error) {
        this.status.textContent = errorText(error, 'Could not save. Keep this tab open.');
      }
    });
    return this.saving;
  }

  private refreshChrome(): void {
    if (this.lifetime.signal.aborted) return;
    const publish = this.root.querySelector<HTMLButtonElement>('[data-writer-publish]');
    if (publish) {
      const dirty = Boolean(this.path && this.store.draftFiles.some(file => file.path === this.path));
      publish.disabled = !dirty;
      publish.textContent = this.store.local ? 'Save to files' : !dirty ? 'Published' : this.model?.draft ? 'Save hidden draft' : this.isNew || !this.wasPublished ? 'Publish' : 'Publish changes';
    }
    const revert = this.root.querySelector<HTMLButtonElement>('[data-writer-revert]');
    if (revert) revert.hidden = !this.path || this.isNew || !this.store.draftFiles.some(file => file.path === this.path);
  }

  // The editing surface

  private render(focusTitle: boolean): void {
    const model = this.model!;
    this.editor?.destroy();
    const layout = node('div', undefined, 'writer-layout');
    const entry = this.frame(`${journals[model.section]} entry`, 'sage', 'writer-entry-window');
    entry.querySelector('.window-titlebar')!.append(node('span', '', 'writer-state'));
    const body = entry.querySelector('.window-body')!;
    const article = node('article', undefined, 'entry writer-article');
    const eyebrow = node('p', '', 'eyebrow writer-eyebrow');
    const title = node('textarea', undefined, 'writer-title');
    title.rows = 1;
    title.value = model.title;
    title.placeholder = 'Title';
    title.setAttribute('aria-label', 'Title');
    const grow = () => { title.style.height = 'auto'; title.style.height = `${title.scrollHeight}px`; };
    title.addEventListener('input', () => { model.title = title.value.replace(/\n/g, ' '); if (title.value.includes('\n')) title.value = model.title; grow(); this.changed(); this.syncAddress(); });
    title.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); this.editor?.focus(); } });
    const textHost = node('div', undefined, 'writer-text');
    article.append(eyebrow, title, textHost);
    const footer = node('div', undefined, 'writer-footer');
    footer.append(node('span', '', 'writer-count'));
    const publish = button('Publish', () => void this.publish(), 'owner-button owner-button--primary');
    publish.dataset.writerPublish = '';
    const revert = button('Undo all changes', () => void this.revert(), 'owner-button');
    revert.dataset.writerRevert = '';
    const preview = button('Preview', () => void this.preview(), 'owner-button');
    preview.title = 'See the entry exactly as visitors will, before publishing';
    footer.append(revert, preview, publish);
    body.append(article, footer);

    const side = node('div', undefined, 'writer-side');
    side.append(this.settingsWindow(), this.mediaWindow(), this.moreWindow());
    layout.append(entry, side);
    this.root.replaceChildren(this.topBar(), layout);

    this.editor = createRichText(textHost, {
      markdown: model.body,
      placeholder: 'Write your entry here. Drop or paste pictures anywhere in the text.',
      label: 'Entry text',
      resolveMedia: url => this.store.resolveMedia(url),
      addPictures: async files => (await stageFiles(this.store, files, text => { this.status.textContent = text; })).map(file => file.url),
      chooseFromLibrary: () => chooseFromLibrary(this.store, true),
      onChange: markdown => { model.body = markdown; this.changed(); },
      onStatus: text => { this.status.textContent = text; },
    });
    requestAnimationFrame(grow);
    requestAnimationFrame(() => this.countWords());
    this.updateHeader();
    this.refreshChrome();
    if (focusTitle) title.focus();
    else this.restorePlace();
  }

  private updateHeader(): void {
    const model = this.model;
    if (!model) return;
    const eyebrow = this.root.querySelector('.writer-eyebrow');
    if (eyebrow) eyebrow.textContent = formatDate(model.date);
    const state = this.root.querySelector('.writer-state');
    if (state) state.replaceChildren(this.isNew && !this.path ? node('span', 'New', 'writer-badge writer-badge--changed') : this.badge(model));
    const titlebar = this.root.querySelector('.writer-entry-window .window-titlebar__title');
    if (titlebar) titlebar.textContent = `${journals[model.section]} entry`;
    this.refreshChrome();
  }

  private settingsWindow(): HTMLElement {
    const model = this.model!;
    const window = this.frame('Settings', 'lavender', 'writer-settings');
    const body = window.querySelector('.window-body')!;
    const segmented = <T extends string>(label: string, options: [T, string][], value: T, onChange: (value: T) => void) => {
      const group = node('div', undefined, 'writer-field');
      group.append(node('span', label, 'writer-field__label'));
      const row = node('div', undefined, 'writer-segmented');
      row.setAttribute('role', 'radiogroup');
      row.setAttribute('aria-label', label);
      for (const [option, text] of options) {
        const choice = button(text, () => {
          row.querySelectorAll('button').forEach(item => item.setAttribute('aria-checked', String(item === choice)));
          onChange(option);
        }, 'writer-segmented__option');
        choice.setAttribute('role', 'radio');
        choice.setAttribute('aria-checked', String(option === value));
        row.append(choice);
      }
      group.append(row);
      return group;
    };
    const visibilityHint = node('p', '', 'owner-hint');
    const localTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short' });
    const describeVisibility = () => {
      const at = model.publishAt ? Date.parse(model.publishAt) : NaN;
      visibilityHint.textContent = model.draft
        ? 'Hidden entries are saved to GitHub so you can keep working on any device, but they do not show on the website. The repository is public, so the text can be read there.'
        : at > Date.now()
          ? `Scheduled: it goes live ${localTime.format(at)} (your time). The website checks every 15 minutes, so allow a few minutes after that.`
          : model.date > today()
            ? `Scheduled: it appears on ${formatDate(model.date)}, shortly after midnight UTC.`
            : 'Shows on the website when you publish.';
    };
    body.append(
      segmented('Journal', [['devlog', 'Devlog'], ['life', 'Life']], model.section, value => { model.section = value; this.changed(); this.syncAddress(); }),
      segmented('Visibility', [['public', 'Public'], ['hidden', 'Hidden']], model.draft ? 'hidden' : 'public', value => { model.draft = value === 'hidden'; describeVisibility(); this.changed(); }),
      visibilityHint,
    );
    const date = node('input', undefined, 'owner-field');
    date.type = 'date';
    date.value = model.date;
    date.addEventListener('change', () => { model.date = date.value || today(); date.value = model.date; describeVisibility(); this.changed(); });
    const dateField = node('label', undefined, 'writer-field');
    dateField.append(node('span', 'Date', 'writer-field__label'), date);
    // A go-live time, entered in local time and stored in UTC; the shown date follows it.
    const localValue = (iso: string) => { const time = new Date(iso); const offset = time.getTimezoneOffset() * 60000; return new Date(time.getTime() - offset).toISOString().slice(0, 16); };
    const timed = node('label', undefined, 'owner-check');
    const timedBox = node('input');
    timedBox.type = 'checkbox';
    timedBox.checked = Boolean(model.publishAt);
    timed.append(timedBox, node('span', 'Go live at a set time'));
    const when = node('input', undefined, 'owner-field');
    when.type = 'datetime-local';
    when.setAttribute('aria-label', 'Go-live time');
    when.hidden = !model.publishAt;
    if (model.publishAt) when.value = localValue(model.publishAt);
    const applyTime = () => {
      const time = when.value ? new Date(when.value) : undefined;
      if (!time || !Number.isFinite(time.getTime())) return;
      model.publishAt = time.toISOString().replace(/\.\d{3}Z$/, 'Z');
      model.date = when.value.slice(0, 10);
      date.value = model.date;
      describeVisibility();
      this.changed();
    };
    timedBox.addEventListener('change', () => {
      when.hidden = !timedBox.checked;
      if (timedBox.checked) {
        // Start from the next full hour, or 09:00 on the chosen day if that is later.
        const next = new Date(); next.setMinutes(0, 0, 0); next.setHours(next.getHours() + 1);
        const morning = new Date(`${model.date}T09:00`);
        when.value = localValue((morning > next ? morning : next).toISOString());
        applyTime();
        when.focus();
      } else { model.publishAt = ''; describeVisibility(); this.changed(); }
    });
    when.addEventListener('change', applyTime);
    body.append(dateField, timed, when, this.tagsField());
    const featured = node('label', undefined, 'owner-check');
    const box = node('input');
    box.type = 'checkbox';
    box.checked = model.featured;
    box.addEventListener('change', () => { model.featured = box.checked; this.changed(); });
    featured.append(box, node('span', 'Feature on the home page'));
    body.append(featured);
    describeVisibility();
    return window;
  }

  private tagsField(): HTMLElement {
    const model = this.model!;
    const field = node('div', undefined, 'writer-field');
    field.append(node('span', model.section === 'devlog' ? 'Projects and topics' : 'Topics', 'writer-field__label'));
    const chips = node('div', undefined, 'writer-tags');
    const input = node('input', undefined, 'writer-tags__input');
    input.placeholder = 'Add a tag, then Enter';
    input.setAttribute('aria-label', 'Add a tag');
    const list = node('datalist');
    list.id = `writer-tags-${crypto.randomUUID()}`;
    input.setAttribute('list', list.id);
    const known = new Set<string>();
    void this.knownTags().then(tags => { for (const tag of tags) { if (known.has(tag)) continue; known.add(tag); list.append(Object.assign(node('option'), { value: tag })); } });
    const render = () => {
      chips.querySelectorAll('.writer-tag').forEach(chip => chip.remove());
      for (const tag of model.tags) {
        const chip = node('span', undefined, 'writer-tag');
        chip.append(node('span', tag), button('×', () => { model.tags = model.tags.filter(item => item !== tag); render(); this.changed(); }, 'writer-tag__remove'));
        chip.lastElementChild!.setAttribute('aria-label', `Remove ${tag}`);
        chips.insertBefore(chip, input);
      }
    };
    const add = () => {
      const tag = input.value.trim().replace(/\s+/g, ' ');
      input.value = '';
      if (!tag || model.tags.some(item => item.toLowerCase() === tag.toLowerCase())) return;
      model.tags = [...model.tags, tag];
      render();
      this.changed();
    };
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ',') { event.preventDefault(); add(); }
      else if (event.key === 'Backspace' && !input.value && model.tags.length) { model.tags = model.tags.slice(0, -1); render(); this.changed(); }
    });
    input.addEventListener('change', () => { if (known.has(input.value.trim())) add(); });
    input.addEventListener('blur', add);
    chips.append(input, list);
    render();
    field.append(chips);
    return field;
  }

  private async knownTags(): Promise<string[]> {
    const tags = new Set<string>();
    await Promise.all(this.entries.map(async entry => {
      try { for (const tag of readModel(await this.store.read(entry.path)).model.tags) tags.add(tag); } catch { /* Skip unreadable entries. */ }
    }));
    return [...tags].sort((a, b) => a.localeCompare(b));
  }

  private mediaWindow(): HTMLElement {
    const window = this.frame('Media', 'pink', 'writer-media');
    const body = window.querySelector('.window-body')!;
    body.append(node('p', 'Shown beside your text on the entry page. The cover is also used in lists and link previews.', 'owner-hint'));
    const list = node('ol', undefined, 'writer-media__list');
    const drop = node('label', undefined, 'writer-drop');
    const input = node('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = '.jpg,.jpeg,.png,.webp,.gif,.mp4,.mov,.m4v,.webm,.mkv,.mp3,.wav,.flac,.ogg,.m4a,.aac';
    input.hidden = true;
    drop.append(node('strong', '+ Add pictures, video or audio'), node('small', 'Click, or drop files here'), input);
    const library = button('Choose from library', () => void chooseFromLibrary(this.store, false).then(url => { if (url) this.addMedia([{ url, kind: this.store.mediaKind(url) ?? 'image' }]); }), 'owner-button');
    body.append(list, drop, library);
    const add = async (files: File[]) => {
      if (!files.length) return;
      try { this.addMedia(await stageFiles(this.store, files, text => { this.status.textContent = text; })); }
      catch (error) { this.status.textContent = errorText(error, 'That file could not be prepared.'); }
    };
    input.addEventListener('change', () => { const files = [...(input.files ?? [])]; input.value = ''; void add(files); });
    drop.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); drop.classList.add('is-over'); } });
    drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
    drop.addEventListener('drop', event => { event.preventDefault(); drop.classList.remove('is-over'); void add([...(event.dataTransfer?.files ?? [])]); });
    this.renderMedia(list);
    return window;
  }

  private addMedia(files: { url: string; kind: MediaItem['type'] }[]): void {
    const model = this.model!;
    for (const file of files) {
      // The first picture becomes the cover, so lists and link previews have one.
      if (!model.cover && file.kind === 'image' && !model.media.length) { model.cover = file.url; model.coverAlt = ''; continue; }
      model.media.push({ type: file.kind, src: file.url, alt: '', caption: '', poster: '' });
    }
    this.mediaTouched = true;
    this.changed();
    const list = this.root.querySelector<HTMLOListElement>('.writer-media__list');
    if (list) this.renderMedia(list);
    list?.querySelector<HTMLInputElement>('.writer-media__item:last-child .writer-media__alt')?.focus();
  }

  private renderMedia(list: HTMLOListElement): void {
    const model = this.model!;
    list.replaceChildren();
    type Row = { cover: boolean; item: MediaItem; index: number };
    const rows: Row[] = [
      ...(model.cover ? [{ cover: true, item: { type: 'image' as const, src: model.cover, alt: model.coverAlt, caption: '', poster: '' }, index: -1 }] : []),
      ...model.media.map((item, index) => ({ cover: false, item, index })),
    ];
    if (!rows.length) list.append(node('li', 'No media yet.', 'writer-media__empty'));
    const touch = () => { this.mediaTouched = true; this.changed(); this.renderMedia(list); };
    for (const row of rows) {
      const element = node('li', undefined, `writer-media__item${row.cover ? ' is-cover' : ''}`);
      element.draggable = !row.cover;
      const preview = node('div', undefined, 'writer-media__preview');
      if (row.item.type === 'image') { const image = node('img'); image.src = this.store.resolveMedia(row.item.src); image.alt = ''; preview.append(image); }
      else if (row.item.type === 'video') { const video = node('video'); video.src = this.store.resolveMedia(row.item.src); video.muted = true; video.preload = 'metadata'; preview.append(video); }
      else preview.append(node('span', '♪ Audio', 'writer-media__audio'));
      if (row.cover) preview.append(node('span', 'Cover', 'writer-media__badge'));
      const fields = node('div', undefined, 'writer-media__fields');
      const alt = node('input', undefined, 'owner-field writer-media__alt');
      alt.value = row.item.alt;
      alt.placeholder = row.item.type === 'image' ? (row.cover ? 'Describe the cover (required)' : 'Describe this picture') : `What is in this ${row.item.type}?`;
      alt.setAttribute('aria-label', 'Description');
      alt.addEventListener('input', () => {
        if (row.cover) model.coverAlt = alt.value; else model.media[row.index].alt = alt.value;
        element.classList.toggle('is-missing', row.cover && !alt.value.trim());
        this.mediaTouched = true; this.changed();
      });
      element.classList.toggle('is-missing', row.cover && !row.item.alt.trim());
      fields.append(alt);
      if (!row.cover) {
        const caption = node('textarea', undefined, 'owner-field writer-media__caption');
        caption.rows = 1;
        caption.value = row.item.caption;
        caption.placeholder = 'Caption (optional)';
        caption.setAttribute('aria-label', 'Caption');
        caption.addEventListener('input', () => { model.media[row.index].caption = caption.value; this.mediaTouched = true; this.changed(); });
        fields.append(caption);
      }
      const actions = node('div', undefined, 'writer-media__actions');
      if (!row.cover && row.item.type === 'image') actions.append(button('Make cover', () => {
        const [item] = model.media.splice(row.index, 1);
        if (model.cover) model.media.unshift({ type: 'image', src: model.cover, alt: model.coverAlt, caption: '', poster: '' });
        model.cover = item.src; model.coverAlt = item.alt;
        touch();
      }, 'writer-mini'));
      if (!row.cover && row.index > 0) actions.append(Object.assign(button('↑', () => { const [item] = model.media.splice(row.index, 1); model.media.splice(row.index - 1, 0, item); touch(); }, 'writer-mini'), { title: 'Move up', ariaLabel: 'Move up' }));
      if (!row.cover && row.index < model.media.length - 1) actions.append(Object.assign(button('↓', () => { const [item] = model.media.splice(row.index, 1); model.media.splice(row.index + 1, 0, item); touch(); }, 'writer-mini'), { title: 'Move down', ariaLabel: 'Move down' }));
      actions.append(button('Remove', () => {
        if (row.cover) { model.cover = ''; model.coverAlt = ''; } else model.media.splice(row.index, 1);
        touch();
      }, 'writer-mini writer-mini--danger'));
      fields.append(actions);
      element.append(preview, fields);
      if (!row.cover) {
        element.addEventListener('dragstart', event => { event.dataTransfer?.setData('text/x-writer-media', String(row.index)); element.classList.add('is-dragging'); });
        element.addEventListener('dragend', () => element.classList.remove('is-dragging'));
        element.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('text/x-writer-media')) event.preventDefault(); });
        element.addEventListener('drop', event => {
          const from = Number(event.dataTransfer?.getData('text/x-writer-media'));
          if (!Number.isInteger(from) || from === row.index) return;
          event.preventDefault();
          const [item] = model.media.splice(from, 1);
          model.media.splice(row.index, 0, item);
          touch();
        });
      }
      list.append(element);
    }
  }

  private moreWindow(): HTMLElement {
    const model = this.model!;
    const window = this.frame('More', 'sage', 'writer-more');
    const body = window.querySelector('.window-body')!;
    const address = node('label', undefined, 'writer-field');
    const prefix = node('span', '', 'writer-address__prefix');
    const slug = node('input', undefined, 'owner-field writer-address__slug');
    slug.value = model.permalink;
    slug.setAttribute('aria-label', 'Web address');
    slug.spellcheck = false;
    const addressHint = node('p', '', 'owner-hint');
    const row = node('span', undefined, 'writer-address');
    row.append(prefix, slug);
    address.append(node('span', 'Web address', 'writer-field__label'), row, addressHint);
    slug.addEventListener('input', () => {
      this.slugTouched = true;
      const value = slugify(slug.value);
      model.permalink = value;
      const taken = this.entries.some(entry => entry.path !== this.path && entry.permalink === value);
      slug.setCustomValidity(!value ? 'Use letters or numbers.' : taken ? 'Another entry already uses this address.' : '');
      addressHint.textContent = slug.validationMessage || (this.wasPublished ? 'Changing a published address breaks links people already shared.' : '');
      this.changed();
    });
    slug.addEventListener('blur', () => { slug.value = model.permalink; });
    const summary = node('label', undefined, 'writer-field');
    const excerpt = node('textarea', undefined, 'owner-field');
    excerpt.rows = 3;
    excerpt.value = model.excerpt;
    excerpt.addEventListener('input', () => { model.excerpt = excerpt.value; this.changed(); });
    summary.append(node('span', 'Summary (optional)', 'writer-field__label'), excerpt, node('p', 'Shown above your text and in entry lists. Leave it empty to use the start of your text.', 'owner-hint'));
    const actions = node('div', undefined, 'writer-more__actions');
    if (this.wasPublished && model.permalink) {
      const view = node('a', 'View on the website', 'owner-button');
      view.href = `/${model.section}/${this.saved?.permalink || model.permalink}/`;
      actions.append(view);
    }
    if (this.path && !this.isNew) actions.append(button('Earlier versions', () => void this.history(), 'owner-button'));
    actions.append(button('Delete entry', () => void this.delete(), 'owner-button owner-button--danger'));
    body.append(address, summary, actions);
    this.syncAddress = () => {
      prefix.textContent = `gwenlium.dev/${model.section}/`;
      if (!this.slugTouched && this.isNew) { model.permalink = this.uniquePermalink(slugify(model.title)); slug.value = model.permalink; }
    };
    this.syncAddress();
    return window;
  }

  private syncAddress: () => void = () => undefined;

  // Actions

  private async publish(): Promise<void> {
    await this.flush();
    if (!this.path) { toast('Write something first.'); return; }
    if (this.editor?.missingDescriptions()) {
      this.editor.focusMissingDescription();
      toast('Give every picture in the text a short description first. It helps people who cannot see it.');
      return;
    }
    if (this.model?.cover && !this.model.coverAlt.trim()) {
      this.root.querySelector<HTMLInputElement>('.writer-media__item.is-cover .writer-media__alt')?.focus();
      toast('Describe the cover picture first.');
      return;
    }
    if (!this.model?.draft && !this.model?.title.trim()) {
      this.root.querySelector<HTMLTextAreaElement>('.writer-title')?.focus();
      toast('Give the entry a title first.');
      return;
    }
    const path = this.path;
    await openPublish(this.store, async () => {
      this.entries = await this.store.entries();
      if (this.store.exists(path)) await this.open(path);
    }, [path]);
  }

  /** Show the draft in the real entry layout (same tab, so pictures prepared here still show). */
  private async preview(): Promise<void> {
    await this.flush();
    const model = this.model;
    if (!model || !this.path) { toast('Write something first, then preview it.'); return; }
    // Coming back from the preview returns to the same scroll position and cursor.
    const scroller = document.getElementById('page-scroll');
    try {
      sessionStorage.setItem(placeKey, JSON.stringify({ path: this.path, scroll: scroller?.scrollTop ?? 0, cursor: this.editor?.cursor() ?? 0, at: Date.now() }));
    } catch { /* Only the position is lost. */ }
    storePreview({ path: this.path, section: model.section, title: model.title, date: model.date, tags: model.tags, excerpt: model.excerpt,
      body: model.body, cover: model.cover, coverAlt: model.coverAlt, media: model.media,
      returnUrl: `${location.pathname}${location.search}`, returnIndex: (history.state as { index?: number } | null)?.index });
    await navigate('/write/preview/');
  }

  /** Back from the preview: put the page and the cursor where they were. */
  private restorePlace(): void {
    let place: { path?: string; scroll?: number; cursor?: number; at?: number } | undefined;
    try { place = JSON.parse(sessionStorage.getItem(placeKey) ?? 'null') ?? undefined; } catch { place = undefined; }
    if (!place || place.path !== this.path || Date.now() - (place.at ?? 0) > 30 * 60 * 1000) return;
    try { sessionStorage.removeItem(placeKey); } catch { /* Harmless. */ }
    requestAnimationFrame(() => {
      if (typeof place!.cursor === 'number') this.editor?.restoreCursor(place!.cursor);
      // Placing the cursor can scroll to it; the saved scroll position wins once that settles.
      setTimeout(() => {
        const scroller = document.getElementById('page-scroll');
        if (scroller && typeof place!.scroll === 'number') scroller.scrollTop = place!.scroll;
      }, 60);
    });
  }

  /** Every published version of this entry; any of them can come back as an unpublished change. */
  private async history(): Promise<void> {
    const path = this.path;
    if (!path) return;
    await this.flush();
    const { dialog, body, footer, status } = openDialog('Earlier versions', { wide: true });
    footer.append(button('Close', () => dialog.close()));
    status.textContent = 'Loading the history…';
    let versions: Awaited<ReturnType<SiteEditorStore['history']>>;
    try { versions = await this.store.history(path); }
    catch (error) { status.textContent = errorText(error); return; }
    status.textContent = '';
    if (versions.length < 2) { body.append(node('p', 'There are no earlier published versions of this entry yet.')); return; }
    body.append(node('p', 'Each time this entry was published. Restoring one puts it back as an unpublished change; nothing goes live until you publish.', 'owner-hint'));
    const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    const list = node('ol', undefined, 'owner-versions');
    versions.forEach((version, index) => {
      const item = node('li', undefined, 'owner-version');
      const heading = node('div', undefined, 'owner-version__heading');
      const label = node('span');
      label.append(node('strong', when.format(new Date(version.date))), node('small', index === 0 ? `${version.message} (published now)` : version.message));
      const preview = node('pre', undefined, 'owner-version__text');
      preview.hidden = true;
      const show = button('Show', () => void (async () => {
        if (!preview.hidden) { preview.hidden = true; show.textContent = 'Show'; return; }
        try {
          if (!preview.textContent) {
            const { model } = readModel(await this.store.version(path, version.commit));
            preview.textContent = [model.title && `# ${model.title}`, model.excerpt && `Summary: ${model.excerpt}`, model.body].filter(Boolean).join('\n\n') || '(empty)';
          }
          preview.hidden = false; show.textContent = 'Hide';
        } catch (error) { status.textContent = errorText(error); }
      })(), 'writer-mini');
      heading.append(label, show);
      if (index > 0) heading.append(button('Restore', () => void (async () => {
        if (!await confirmAction('Restore this version?', `The entry goes back to how it was on ${when.format(new Date(version.date))}. Your current text stays in the history, and nothing is public until you publish.`, 'Restore')) return;
        try {
          const content = await this.store.version(path, version.commit);
          await this.store.write(path, content);
          dialog.close();
          await this.open(path);
          toast('Earlier version restored. Publish when you are happy with it.');
        } catch (error) { status.textContent = errorText(error); }
      })(), 'writer-mini'));
      item.append(heading, preview);
      list.append(item);
    });
    body.append(list);
  }

  private async revert(): Promise<void> {
    if (!this.path || this.isNew) return;
    if (!await confirmAction('Undo all changes to this entry?', 'It goes back to the version that is published now.', 'Undo changes', true)) return;
    const path = this.path;
    await this.store.revert(path);
    await this.open(path);
    this.status.textContent = 'Back to the published version.';
  }

  private async delete(): Promise<void> {
    const model = this.model!;
    const published = this.wasPublished;
    const description = this.isNew
      ? 'This entry was never published. It is removed from this browser.'
      : published
        ? 'It disappears from the website when you publish. Links people shared will stop working. Git history keeps a copy.'
        : 'It is removed from GitHub when you publish.';
    if (!await confirmAction(`Delete “${model.title || 'Untitled entry'}”?`, description, 'Delete entry', true)) return;
    clearTimeout(this.saveTimer);
    const path = this.path;
    this.model = undefined;
    try {
      if (path) await this.store.remove(path);
      if (path && !this.isNew && this.store.draftFiles.some(file => file.path === path)) {
        toast('Deleted in your changes. Publish to remove it from the website.', { action: { label: 'Publish now', run: () => void openPublish(this.store, async () => undefined, [path]) } });
      } else toast('Entry deleted.');
    } catch (error) { toast(errorText(error)); }
    this.goto(writerUrl());
  }
}

/** A stale draft is detected when publishing; this is also offered from the entries list. */
export function updateDrafts(store: SiteEditorStore): Promise<void> {
  return resolveConflicts(store, () => undefined);
}
