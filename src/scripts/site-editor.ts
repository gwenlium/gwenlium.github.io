import { SiteEditorStore } from './site-editor-store';
import { createPreviewPicker } from './admin-library';
import { mountMarkdownEditor, renderMarkdownPreview, type MarkdownEditorHandle } from './site-editor-markdown';
import { builtinWindowPages, systemWindowIds, windowPages, windowTones } from '../lib/window-catalogue.mjs';
import { previewText } from '../lib/preview-text.mjs';
import type { EditorBinding, EditorConflict } from '../lib/site-editor-types';
import type { WindowDefinition } from '../lib/windows';
import '../styles/site-editor.css';

const windowsFile = 'src/content/windows.json';
const galleryFile = 'src/content/gallery.json';
const root = document.documentElement;
const pointerPart = (value: string) => value.replace(/~/g, '~0').replace(/\//g, '~1');
const binding = (file: string, field: string, label: string, format: EditorBinding['format'] = 'text'): EditorBinding => ({ file, field, label, format });
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function button(label: string, callback: () => void): HTMLButtonElement {
  const element = node('button', label);
  element.type = 'button';
  element.addEventListener('click', callback);
  return element;
}
function sourceBinding(element: HTMLElement): EditorBinding | undefined {
  const { siteEditFile: file, siteEditField: field, siteEditFormat: format, siteEditLabel: label, siteEditAltField: altField } = element.dataset;
  if (!file || !field) return;
  return { file, field, format: format === 'markdown' || format === 'image' ? format : 'text', label: label || 'Content', altField };
}
function annotate(element: HTMLElement, target: EditorBinding): void {
  element.dataset.siteEditFile = target.file;
  element.dataset.siteEditField = target.field;
  element.dataset.siteEditFormat = target.format;
  element.dataset.siteEditLabel = target.label;
  if (target.altField) element.dataset.siteEditAltField = target.altField;
}
function pageName(): string {
  const segments = location.pathname.split('/').filter(Boolean);
  if (segments.length > 1 && ['devlog', 'life'].includes(segments[0])) return 'post';
  const page = segments[0] || 'home';
  return windowPages.includes(page) ? page : 'not-found';
}
let controller: SiteEditor | undefined;
export function openSiteEditor(shell: HTMLElement): void {
  controller ??= new SiteEditor(shell);
  controller.open(true);
}

class SiteEditor {
  private store: SiteEditorStore;
  private bar = node('div', undefined, 'site-editor-bar');
  private status = node('p', '', 'site-editor-status');
  private message = '';
  private operations: Promise<void> = Promise.resolve();
  private pendingLayouts = new Map<string, { id: string; x: number; y: number; width: number; height: number; floating: boolean }>();
  private savingLayouts = false;
  private frontingToolbar = false;
  private busy = false;
  private preview = false;
  private rendering = 0;
  private selected?: EditorBinding;
  private down = { x: 0, y: 0 };
  private createdWindows = new Set<HTMLElement>();
  private windowVersions = new Map<HTMLElement, string>();
  private windowTemplates = new Map<string, HTMLElement>();
  private dialogue?: string;
  private activeDialogs = new Set<HTMLDialogElement>();
  constructor(private shell: HTMLElement) {
    this.store = new SiteEditorStore({ authOrigin: shell.dataset.authOrigin!, siteOrigin: shell.dataset.siteOrigin! });
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    shell.replaceChildren(this.bar, this.status);
    this.store.subscribe(() => this.renderBar());
    this.shell.addEventListener('toggle', () => this.syncAccess());
    document.addEventListener('gwenlium:windows-changed', () => this.frontToolbar());
    document.addEventListener('focusin', event => {
      if (event.target instanceof Element && event.target.closest('[data-desktop-window]')) this.frontToolbar();
    });
    document.addEventListener('pointerdown', event => { this.down = { x: event.clientX, y: event.clientY }; }, true);
    document.addEventListener('click', event => {
      if (!this.store.authenticated || this.preview || this.busy || !(event.target instanceof Element) ||
        event.target.closest('.site-editor-shell, .site-editor-dialog, .admin-media')) return;
      if (Math.hypot(event.clientX - this.down.x, event.clientY - this.down.y) > 6 && event.detail) return;
      const target = event.target.closest<HTMLElement>('[data-site-edit-file][data-site-edit-field]');
      const source = target && sourceBinding(target);
      if (!source) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.selected = source;
      void this.run(() => this.edit(source));
    }, true);
    document.addEventListener('astro:before-swap', event => {
      // Keep the owner taskbar's size stable before the next page is laid out.
      this.syncAccess((event as Event & { newDocument: Document }).newDocument);
      this.rendering++;
      for (const dialog of this.activeDialogs) dialog.close();
      this.selected = undefined;
      this.windowTemplates.clear();
      this.windowVersions.clear();
      this.createdWindows.clear();
    });
    document.addEventListener('astro:page-load', () => {
      if (!this.store.authenticated) return;
      this.setMode();
      this.open();
      void this.run(() => this.applyDraft());
    });
    document.addEventListener('gwenlium:editor-window-layout', event => {
      if (!this.store.authenticated || this.preview || !(event instanceof CustomEvent)) return;
      const layout = event.detail;
      if (!layout || typeof layout.id !== 'string' || systemWindowIds.includes(layout.id) || typeof layout.floating !== 'boolean'
        || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(layout[key]))) return;
      this.pendingLayouts.set(layout.id, { id: layout.id, x: Math.round(layout.x), y: Math.round(layout.y), width: Math.round(layout.width), height: Math.round(layout.height), floating: layout.floating });
      if (this.savingLayouts) return;
      this.savingLayouts = true;
      void this.run(async () => {
        try {
          while (this.pendingLayouts.size) {
            const records = await this.windows();
            for (const next of this.pendingLayouts.values()) {
              const item = records.find(item => item.id === next.id);
              if (item) Object.assign(item, next);
            }
            this.pendingLayouts.clear();
            await this.store.set(binding(windowsFile, '/windows', 'Windows'), records);
          }
          this.message = 'Window arrangement saved in your private draft.';
        } finally { this.savingLayouts = false; }
      });
    });
    window.addEventListener('beforeunload', event => {
      if (this.busy) event.preventDefault();
    });
    this.renderBar();
  }
  open(focus = false): void {
    if (!this.shell.matches(':popover-open')) this.shell.showPopover();
    this.frontToolbar();
    this.syncAccess();
    if (focus) this.bar.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }
  private syncAccess(target: Document = document): void {
    // Only a session verified by the owner API reveals editing entry points.
    const authenticated = this.store.authenticated;
    const expanded = String(this.shell.matches(':popover-open'));
    for (const control of target.querySelectorAll<HTMLElement>('[data-open-site-editor]')) {
      if (control.hasAttribute('data-owner-editor')) control.hidden = !authenticated;
      else if (control.hasAttribute('data-owner-sign-in')) control.hidden = authenticated;
      control.setAttribute('aria-expanded', expanded);
    }
  }
  private hideToolbar(): void {
    this.shell.hidePopover();
    this.syncAccess();
    document.querySelector<HTMLElement>(this.store.authenticated ? '.taskbar [data-owner-editor]' : '[data-open-start]')?.focus({ preventScroll: true });
  }
  private frontToolbar(): void {
    if (this.frontingToolbar || !this.shell.isConnected || !this.shell.matches(':popover-open') || document.querySelector('dialog[open]')) return;
    const focused = document.activeElement instanceof HTMLElement && this.shell.contains(document.activeElement) ? document.activeElement : undefined;
    this.frontingToolbar = true;
    try {
      this.shell.hidePopover();
      this.shell.showPopover();
      focused?.focus({ preventScroll: true });
    } finally { this.frontingToolbar = false; }
  }
  private run(work: () => Promise<void>): Promise<void> {
    this.operations = this.operations.then(async () => {
      this.busy = true;
      this.renderBar();
      try { await work(); }
      catch (error) { this.message = error instanceof Error ? error.message : 'The operation failed. Your draft has not been published.'; }
      finally { this.busy = false; this.renderBar(); }
    });
    return this.operations;
  }
  private setMode(): void {
    root.dataset.siteEditing = 'true';
    root.dataset.sitePreview = String(this.preview);
    this.dialogue ??= root.dataset.dialogue;
    root.dataset.dialogue = 'off';
    document.dispatchEvent(new CustomEvent('gwenlium:editor-mode-changed'));
  }
  private renderBar(): void {
    this.syncAccess();
    this.bar.replaceChildren();
    if (!this.store.authenticated) {
      this.bar.append(node('strong', 'Owner editing'), button('Sign in with GitHub', () => {
        // signIn opens its popup before its first await; keep the user activation.
        const signingIn = this.store.signIn();
        void this.run(async () => {
          await signingIn;
          this.setMode();
          await this.resolveConflicts();
          this.message = 'Click outlined text or pictures to edit. Move and resize windows normally. Publish is the only public write.';
        }).then(() => this.open(true));
      }), button('Close', () => this.hideToolbar()));
      this.status.textContent = this.message || 'Only the site owner can sign in. Drafts stay in this browser until Publish.';
    } else {
      this.bar.append(node('strong', this.preview ? 'Draft preview' : 'Edit site'),
        button('Page content', () => void this.run(() => this.contentList())),
        button('Windows', () => void this.run(() => this.windowList())),
        button('New window', () => void this.run(() => this.windowForm())),
        button('Add picture', () => void this.run(() => this.insertPicture())),
        button(this.preview ? 'Resume editing' : 'Preview', () => {
          this.preview = !this.preview;
          root.dataset.sitePreview = String(this.preview);
          this.renderBar();
        }),
        button('Review & publish', () => void this.run(() => this.review())),
        button('Refresh source', () => void this.run(() => this.resolveConflicts())),
        button('Discard draft', () => void this.run(async () => {
          if (!await this.confirm('Discard private draft?', 'This removes your saved local edits and prepared pictures. Published content is not changed.', 'Discard draft')) return;
          await this.store.discard();
          this.windowVersions.clear();
          await this.applyDraft();
          this.message = 'Private draft discarded.';
        })),
        button('Hide toolbar', () => this.hideToolbar()),
        button('Sign out', () => this.signOut()));
      const publish = [...this.bar.querySelectorAll('button')].find(item => item.textContent === 'Review & publish');
      if (publish) publish.disabled = !this.store.dirty;
      this.status.textContent = this.busy ? 'Working…' : [this.store.storageWarning, this.message,
        this.store.dirty ? `${this.store.draftFiles.length} changed file(s), private to this browser.` : 'No unpublished changes.'].filter(Boolean).join(' ');
    }
    if (this.busy) this.bar.querySelectorAll('button').forEach(item => { item.disabled = true; });
  }
  private signOut(): void {
    if (this.busy) return;
    this.store.signOut();
    delete root.dataset.siteEditing;
    delete root.dataset.sitePreview;
    if (this.dialogue !== undefined) root.dataset.dialogue = this.dialogue;
    document.dispatchEvent(new CustomEvent('gwenlium:editor-mode-changed'));
    const url = new URL(location.href);
    url.searchParams.delete('edit');
    history.replaceState(history.state, '', url);
    // Recreate the untouched public surface; local draft remains owner-bound in IndexedDB.
    location.reload();
  }
  private dialog(title: string) {
    const dialog = node('dialog', undefined, 'site-editor-dialog');
    const heading = node('h2', title);
    heading.id = `site-editor-title-${crypto.randomUUID()}`;
    dialog.setAttribute('aria-labelledby', heading.id);
    const body = node('div', undefined, 'site-editor-dialog-body');
    const footer = node('div', undefined, 'site-editor-actions');
    const status = node('p', '', 'site-editor-dialog-status');
    status.setAttribute('role', 'status');
    dialog.append(heading, body, status, footer);
    document.body.append(dialog);
    this.activeDialogs.add(dialog);
    dialog.addEventListener('close', () => { this.activeDialogs.delete(dialog); dialog.remove(); this.frontToolbar(); }, { once: true });
    dialog.showModal();
    return { dialog, body, footer, status };
  }
  private confirm(title: string, description: string, accept: string): Promise<boolean> {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const { dialog, body, footer } = this.dialog(title);
    body.append(node('p', description));
    let accepted = false;
    footer.append(button('Cancel', () => dialog.close()), button(accept, () => { accepted = true; dialog.close(); }));
    dialog.addEventListener('close', () => resolve(accepted), { once: true });
    return promise;
  }
  private input(parent: HTMLElement, label: string, value = '', type = 'text'): HTMLInputElement {
    const wrap = node('label', label);
    const input = node('input');
    input.type = type;
    input.value = value;
    wrap.append(input);
    parent.append(wrap);
    return input;
  }
  private chooseImage(file?: File): Promise<{ src: string; alt: string } | undefined> {
    const { promise, resolve } = Promise.withResolvers<{ src: string; alt: string } | undefined>();
      let settled = false;
      const finish = (result?: { src: string; alt: string }) => {
        if (settled) return;
        settled = true;
        picker.destroy();
        resolve(result);
      };
      const picker = createPreviewPicker({
        mode: 'draft', load: () => this.store.media(), save: preview => this.store.addMedia(preview),
        resolveURL: url => this.store.resolveMedia(url), onCancel: () => finish(),
        onInsert: value => {
          const src = Array.isArray(value) ? value[0] : value;
          if (!src) return finish();
          const { dialog, body, footer } = this.dialog('Describe this picture');
          const image = node('img'); image.src = this.store.resolveMedia(src); image.alt = '';
          body.append(image);
          const alt = this.input(body, 'Image description (alt text)');
          body.append(node('p', 'Describe what the picture shows. This also helps people using screen readers.'));
          footer.append(button('Cancel', () => dialog.close()), button('Use picture', () => {
            if (!alt.value.trim()) { alt.setCustomValidity('Add a description for this picture.'); alt.reportValidity(); return; }
            finish({ src, alt: alt.value.trim() });
            dialog.close();
          }));
          alt.addEventListener('input', () => alt.setCustomValidity(''));
          dialog.addEventListener('close', () => finish(), { once: true });
        },
      });
      void picker.show({ imagesOnly: true, allowMultiple: false, file }).catch(error => { this.message = String(error); finish(); });
    return promise;
  }
  private async edit(target: EditorBinding): Promise<void> {
    const initial = await this.store.get(target);
    const { dialog, body, footer, status } = this.dialog(target.label);
    let value: unknown = initial;
    let altValue = target.altField ? String(await this.store.get({ ...target, field: target.altField }) ?? '') : '';
    let markdown: MarkdownEditorHandle | undefined;
    const preview = node('div', undefined, 'site-editor-field-preview prose');
    const updatePreview = () => {
      preview.replaceChildren();
      if (target.format === 'image') {
        if (typeof value === 'string' && value) { const image = node('img'); image.src = this.store.resolveMedia(value); image.alt = altValue; preview.append(image); }
      } else if (target.format === 'markdown') preview.append(renderMarkdownPreview(String(value ?? ''), url => this.store.resolveMedia(url)));
      else preview.textContent = String(value ?? '');
    };
    if (target.format === 'markdown') {
      const editor = node('div'); body.append(editor);
      markdown = mountMarkdownEditor(editor, { value: String(initial ?? ''), onChange: next => { value = next; updatePreview(); }, chooseImage: file => this.chooseImage(file), resolveMedia: url => this.store.resolveMedia(url) });
      dialog.addEventListener('close', () => markdown?.destroy(), { once: true });
    } else if (target.format === 'image') {
      body.append(button('Choose or prepare picture', () => {
        void this.chooseImage().then(selected => { if (selected) { value = selected.src; altValue = selected.alt; alt.value = selected.alt; updatePreview(); } });
      }));
      const alt = this.input(body, 'Image description', altValue);
      alt.addEventListener('input', () => { altValue = alt.value; updatePreview(); });
      body.append(button('Remove picture', () => { value = ''; updatePreview(); }));
    } else if (typeof initial === 'boolean') {
      const input = this.input(body, target.label, '', 'checkbox'); input.checked = initial;
      input.addEventListener('change', () => { value = input.checked; updatePreview(); });
    } else if (typeof initial === 'number') {
      const input = this.input(body, target.label, String(initial), 'number'); input.step = '1';
      input.addEventListener('input', () => { value = input.valueAsNumber; updatePreview(); });
    } else {
      const input = node('textarea'); input.value = String(initial ?? ''); input.rows = 5; input.setAttribute('aria-label', target.label);
      body.append(input);
      input.addEventListener('input', () => { value = input.value; updatePreview(); });
    }
    body.append(node('h3', 'Preview'), preview, node('small', 'Save draft applies this change only in your browser.'));
    updatePreview();
    footer.append(button('Cancel', () => dialog.close()), button('Save draft', () => {
      void (async () => {
        footer.querySelectorAll('button').forEach(item => { item.disabled = true; });
        try {
          if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Enter a finite number.');
          await this.store.set(target, markdown ? markdown.getValue() : value ?? '');
          if (target.altField) await this.store.set({ ...target, field: target.altField }, altValue);
          await this.applyDraft();
          this.message = 'Change saved in your private draft.';
          dialog.close();
        } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
        finally { footer.querySelectorAll('button').forEach(item => { item.disabled = false; }); this.renderBar(); }
      })();
    }));
  }
  private async contentList(): Promise<void> {
    const { dialog, body, footer } = this.dialog('Page content');
    const list = node('div', undefined, 'site-editor-choice-list');
    const targets = new Map<string, EditorBinding>();
    document.querySelectorAll<HTMLElement>('[data-site-edit-file][data-site-edit-field]').forEach(element => {
      const target = sourceBinding(element); if (target) targets.set(`${target.file}:${target.field}`, target);
    });
    const pageFile = `src/content/pages/${pageName()}.json`;
    const files = new Set([pageFile, 'src/content/site.json']);
    for (const file of files) {
      if (!this.store.snapshot?.files.some(item => item.path === file)) continue;
      const data = JSON.parse(await this.store.read(file));
      const visit = (record: Record<string, unknown>, prefix = '') => {
        for (const [key, value] of Object.entries(record)) {
          if (['id', 'permalink'].includes(key)) continue;
          const field = `${prefix}/${pointerPart(key)}`;
          if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
            const image = ['src', 'cover', 'avatar', 'poster'].includes(key);
            const target = binding(file, field, `${prefix ? prefix.slice(1) + ' · ' : ''}${key}`, image ? 'image' : key === 'body' ? 'markdown' : 'text');
            const altKey = key === 'src' ? 'alt' : `${key}Alt`;
            if (image && Object.hasOwn(record, altKey)) target.altField = `${prefix}/${altKey}`;
            targets.set(`${file}:${field}`, targets.get(`${file}:${field}`) || target);
          } else if (value && !Array.isArray(value) && typeof value === 'object') visit(value as Record<string, unknown>, field);
        }
      };
      visit(data);
    }
    if (pageName() === 'gallery') {
      const items = await this.store.get(binding(galleryFile, '/items', 'Gallery')) as Array<{ id: string; title: string }>;
      for (const item of items) for (const field of ['title', 'caption', 'alt']) {
        const target = binding(galleryFile, `/items/@${pointerPart(item.id)}/${field}`, `${item.title || item.id} · ${field}`);
        targets.set(`${galleryFile}:${target.field}`, targets.get(`${galleryFile}:${target.field}`) || target);
      }
    }
    for (const target of targets.values()) list.append(button(target.label, () => { dialog.close(); void this.run(() => this.edit(target)); }));
    body.append(node('p', 'Choose a field, or close this panel and click its outline on the page.'), list);
    footer.append(button('Done', () => dialog.close()));
  }
  private async windows(): Promise<WindowDefinition[]> {
    return await this.store.get(binding(windowsFile, '/windows', 'Windows')) as WindowDefinition[];
  }
  private async windowList(): Promise<void> {
    const records = await this.windows();
    const { dialog, body, footer } = this.dialog('Windows');
    const list = node('div', undefined, 'site-editor-choice-list');
    for (const item of records.filter(item => !systemWindowIds.includes(item.id))) {
      list.append(button(`${item.title || item.id} · ${item.page}${item.enabled ? '' : ' · hidden'}`, () => { dialog.close(); void this.run(() => this.windowForm(item)); }));
    }
    body.append(list);
    footer.append(button('Done', () => dialog.close()), button('New window', () => { dialog.close(); void this.run(() => this.windowForm()); }));
  }
  private async windowForm(existing?: WindowDefinition): Promise<void> {
    const { dialog, body, footer, status } = this.dialog(existing ? 'Window settings' : 'New window');
    const title = this.input(body, 'Window title', existing?.title || '');
    const pageLabel = node('label', 'Page'); const page = node('select'); pageLabel.append(page); body.append(pageLabel);
    for (const value of windowPages) { const option = node('option', value); option.value = value; page.append(option); }
    page.value = existing?.page || pageName(); page.disabled = Boolean(existing && Object.hasOwn(builtinWindowPages, existing.id));
    const toneLabel = node('label', 'Colour'); const tone = node('select'); toneLabel.append(tone); body.append(toneLabel);
    for (const value of windowTones) { const option = node('option', value); option.value = value; tone.append(option); }
    tone.value = existing?.tone || 'sage';
    const width = this.input(body, 'Width (pixels; 0 = automatic)', String(existing?.width ?? 480), 'number'); width.min = '0'; width.max = '2400';
    const height = this.input(body, 'Height (pixels; 0 = automatic)', String(existing?.height ?? 360), 'number'); height.min = '0'; height.max = '2400';
    const floating = this.input(body, 'Custom default placement', '', 'checkbox'); floating.checked = existing?.floating ?? true;
    const enabled = this.input(body, 'Visible', '', 'checkbox'); enabled.checked = existing?.enabled ?? true;
    const closed = this.input(body, 'Initially closed', '', 'checkbox'); closed.checked = existing?.initiallyClosed ?? false;
    body.append(node('p', 'Every window stays pinned while its content scrolls. Move and resize a window to save its default placement; visitors can still arrange their own desktop.'));
    footer.append(button('Cancel', () => dialog.close()), button('Save draft', () => {
      void (async () => {
        try {
          if (!title.value.trim()) throw new Error('Give the window a title.');
          if (!width.checkValidity() || !height.checkValidity() || !Number.isInteger(width.valueAsNumber) || !Number.isInteger(height.valueAsNumber)) throw new Error('Use whole-number sizes from 0 to 2400 pixels.');
          const records = await this.windows();
          const item: WindowDefinition = { ...(existing || { id: `custom-${crypto.randomUUID()}`, content: 'text', body: '', media: [], links: [], items: [], limit: 0 }),
            title: title.value.trim(), page: page.value as WindowDefinition['page'], tone: tone.value as WindowDefinition['tone'],
            width: width.valueAsNumber, height: height.valueAsNumber, floating: floating.checked, enabled: enabled.checked, initiallyClosed: closed.checked };
          const index = records.findIndex(row => row.id === item.id);
          if (index >= 0) records[index] = item; else records.push(item);
          await this.store.set(binding(windowsFile, '/windows', 'Windows'), records);
          await this.applyDraft(); dialog.close();
          if (!existing) await this.edit(binding(windowsFile, `/windows/@${item.id}/body`, 'Window text', 'markdown'));
        } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
      })();
    }));
    if (existing && !Object.hasOwn(builtinWindowPages, existing.id)) footer.append(button('Delete window', () => {
      void (async () => {
        if (!await this.confirm('Delete this window?', 'It will be removed from your draft. The public window stays until you publish.', 'Delete window')) return;
        await this.store.set(binding(windowsFile, '/windows', 'Windows'), (await this.windows()).filter(item => item.id !== existing.id));
        await this.applyDraft(); dialog.close();
      })().catch(error => { status.textContent = String(error); });
    }));
  }
  private async insertPicture(): Promise<void> {
    if (pageName() === 'gallery') {
      const selected = await this.chooseImage(); if (!selected) return;
      const items = await this.store.get(binding(galleryFile, '/items', 'Gallery')) as Record<string, unknown>[];
      const item = { id: `picture-${crypto.randomUUID()}`, title: selected.alt, type: 'image', src: selected.src, alt: selected.alt, caption: '', poster: '', topics: [] };
      items.push(item); await this.store.set(binding(galleryFile, '/items', 'Gallery'), items);
      await this.applyDraft();
      await this.edit(binding(galleryFile, `/items/@${item.id}/caption`, 'Picture description'));
      return;
    }
    const targets = [...document.querySelectorAll<HTMLElement>('[data-site-edit-format="markdown"]')].map(sourceBinding).filter((item): item is EditorBinding => Boolean(item));
    const selected = this.selected?.format === 'markdown' ? this.selected : targets[0];
    if (!selected) { this.message = 'Create a text window first, or open a post or the Gallery to add a picture.'; return; }
    // The text editor image action inserts at the cursor, not at an arbitrary page position.
    await this.edit(selected);
  }
  private async applyDraft(): Promise<void> {
    const version = ++this.rendering;
    await this.syncWindows();
    if (version !== this.rendering) return;
    await this.syncGallery();
    if (version !== this.rendering) return;
    const targets = [...document.querySelectorAll<HTMLElement>('[data-site-edit-file][data-site-edit-field]')];
    await Promise.all(targets.map(async element => {
      const target = sourceBinding(element); if (!target) return;
      const value = await this.store.get(target);
      if (version !== this.rendering || !element.isConnected) return;
      if (target.format === 'image') {
        const image = element instanceof HTMLImageElement ? element : element.querySelector('img');
        if (image && typeof value === 'string') {
          image.src = value ? this.store.resolveMedia(value) : '';
          image.hidden = !value; image.removeAttribute('srcset');
          image.closest('picture')?.querySelectorAll('source').forEach(source => source.removeAttribute('srcset'));
          if (target.altField) image.alt = String(await this.store.get({ ...target, field: target.altField }) ?? '');
        }
      } else if (element.dataset.siteEditTemplate === 'post-preview') {
        let text = String(value ?? '');
        if (!text.trim()) {
          const source = String(await this.store.get({ ...target, field: '/body' }) ?? '');
          if (version !== this.rendering || !element.isConnected) return;
          const fragment = renderMarkdownPreview(source, url => this.store.resolveMedia(url));
          fragment.querySelectorAll('p, li, pre, blockquote, h1, h2, h3, h4, h5, h6, br').forEach(block => block.append(' '));
          text = fragment.textContent ?? '';
        }
        element.textContent = previewText(text);
      } else if (element.dataset.siteEditTemplate === 'post-summary') {
        element.replaceChildren(...String(value ?? '').split(/\n\s*\n/).map(text => node('p', text, 'entry-excerpt')));
      } else if (target.format === 'markdown') {
        element.replaceChildren(renderMarkdownPreview(String(value ?? ''), url => this.store.resolveMedia(url)));
      } else {
        // Keep titlebar icons/control siblings: annotations identify only authored text.
        const text = String(value ?? '');
        element.textContent = element.dataset.siteEditTemplate === 'site-name'
          ? text.replaceAll('{name}', String(await this.store.get(binding('src/content/site.json', '/name', 'Site name')))) : text;
      }
    }));
    document.dispatchEvent(new CustomEvent('gwenlium:editor-windows-changed'));
    this.renderBar();
    this.frontToolbar();
  }
  private async syncWindows(): Promise<void> {
    const version = this.rendering;
    const records = await this.windows();
    if (version !== this.rendering) return;
    const page = pageName();
    for (const element of document.querySelectorAll<HTMLElement>('[data-desktop-window][id^="custom-"]')) {
      if (!records.some(item => item.id === element.id)) {
        this.windowTemplates.set(element.id, element.cloneNode(true) as HTMLElement);
        element.remove();
      }
    }
    for (const element of this.createdWindows) {
      const item = records.find(item => item.id === element.id);
      if (!item || !item.enabled || (item.page !== page && item.page !== 'all')) { element.remove(); this.createdWindows.delete(element); }
    }
    for (const item of records) {
      if (systemWindowIds.includes(item.id)) continue;
      let element = document.getElementById(item.id);
      const belongs = item.page === page || item.page === 'all';
      if (!element && item.enabled && belongs) {
        const template = [...document.querySelectorAll<HTMLTemplateElement>('template[data-site-editor-window]')].find(template => template.dataset.siteEditorWindow === item.id);
        const saved = this.windowTemplates.get(item.id);
        const frame = template?.content.firstElementChild || saved;
        if (frame instanceof HTMLElement) {
          element = frame.cloneNode(true) as HTMLElement;
          document.getElementById('main-content')?.append(element);
          this.createdWindows.add(element);
        }
      }
      if (!element && item.enabled && belongs && !Object.hasOwn(builtinWindowPages, item.id)) {
        element = node('section', undefined, `window window--${item.tone} site-editor-created-window`);
        element.id = item.id; element.dataset.desktopWindow = ''; element.tabIndex = -1;
        const titlebar = node('div', undefined, 'window-titlebar');
        titlebar.append(node('span', '', 'window-titlebar__mark'), node('span', item.title, 'window-titlebar__title'));
        const controls = node('div', undefined, 'window-controls'); controls.dataset.windowControls = '';
        for (const [action, label, symbol] of [['minimize', 'Minimize', '−'], ['maximize', 'Maximize', '□'], ['close', 'Close', '×']]) {
          const control = node('button', symbol, 'window-control'); control.type = 'button'; control.dataset.windowAction = action;
          if (action === 'maximize') control.dataset.windowMaximize = '';
          control.setAttribute('aria-label', `${label} ${item.title}`); controls.append(control);
        }
        titlebar.append(controls); element.append(titlebar, node('div', undefined, 'window-body'));
        (document.querySelector('#page-scroll main') || document.querySelector('main') || document.getElementById('page-scroll'))?.append(element);
        this.createdWindows.add(element);
      }
      if (!element || !belongs) continue;
      if (!item.enabled) { element.hidden = true; continue; }
      const serialized = JSON.stringify(item);
      if (this.windowVersions.get(element) === serialized) continue;
      this.windowVersions.set(element, serialized);
      element.hidden = false; element.dataset.windowState = item.initiallyClosed ? 'closed' : 'normal';
      element.hidden = item.initiallyClosed;
      element.dataset.windowTitle = item.title; element.setAttribute('aria-label', item.title);
      element.classList.remove('window--sage', 'window--pink', 'window--lavender'); element.classList.add(`window--${item.tone}`);
      const title = element.querySelector<HTMLElement>('.window-titlebar__title');
      if (title) { title.textContent = item.title; annotate(title, binding(windowsFile, `/windows/@${item.id}/title`, 'Window title')); }
      const body = element.querySelector<HTMLElement>('.window-body');
      if (body && item.content === 'text') {
        const prose = node('div', undefined, 'prose window-authored-text');
        annotate(prose, binding(windowsFile, `/windows/@${item.id}/body`, 'Window text', 'markdown'));
        prose.append(renderMarkdownPreview(item.body, url => this.store.resolveMedia(url)));
        body.replaceChildren(prose);
      }
      document.dispatchEvent(new CustomEvent('gwenlium:editor-windows-changed'));
      document.dispatchEvent(new CustomEvent('gwenlium:editor-apply-layout', { detail: { id: item.id, x: item.x, y: item.y, width: item.width, height: item.height, floating: item.floating } }));
    }
  }
  private async syncGallery(): Promise<void> {
    if (pageName() !== 'gallery') return;
    const version = this.rendering;
    const data = await this.store.get(binding(galleryFile, '/items', 'Gallery')) as Array<Record<string, unknown>>;
    if (version !== this.rendering) return;
    let grid = document.querySelector<HTMLElement>('.gallery-grid');
    if (!grid && data.length) {
      grid = node('div', undefined, 'gallery-grid site-editor-gallery-grid');
      document.getElementById('main-content')?.append(grid);
    }
    const empty = document.querySelector<HTMLElement>('#main-content > .empty-state');
    if (empty) empty.hidden = data.length > 0;
    if (!grid) return;
    grid.querySelectorAll('[data-site-editor-gallery]').forEach(card => card.remove());
    const originalIds = new Set([...grid.querySelectorAll<HTMLElement>('[data-site-edit-field]')].map(item => item.dataset.siteEditField?.split('/')[2]?.replace(/^@/, '')));
    for (const item of data) {
      const id = pointerPart(String(item.id));
      if (originalIds.has(id)) continue;
      const card = node('article', undefined, 'window gallery-item window--pink site-editor-gallery-card');
      card.dataset.siteEditorGallery = ''; card.dataset.galleryType = String(item.type); card.dataset.itemTopics = JSON.stringify(item.topics || []);
      const titlebar = node('div', undefined, 'window-titlebar');
      const title = node('h2', String(item.title), 'window-titlebar__title'); annotate(title, binding(galleryFile, `/items/@${id}/title`, 'Picture title'));
      titlebar.append(title);
      const content = node('div', undefined, 'gallery-item-body');
      const media = item.type === 'video' ? node('video') : node('img');
      media.src = this.store.resolveMedia(String(item.src));
      if (media instanceof HTMLImageElement) {
        media.alt = String(item.alt || '');
        annotate(media, { ...binding(galleryFile, `/items/@${id}/src`, 'Gallery picture', 'image'), altField: `/items/@${id}/alt` });
      } else media.controls = true;
      const caption = node('p', String(item.caption || '')); annotate(caption, binding(galleryFile, `/items/@${id}/caption`, 'Picture description'));
      content.append(media, caption); card.append(titlebar, content); grid.append(card);
    }
  }
  private async review(): Promise<void> {
    const { dialog, body, footer, status } = this.dialog('Review and publish');
    body.append(node('p', 'Publish commits these changes and referenced prepared pictures to the public GitHub repository. Visitors see the update after the site deployment completes. Originals are never uploaded.'));
    for (const file of this.store.draftFiles) {
      const details = node('details'); details.append(node('summary', file.path));
      const columns = node('div', undefined, 'site-editor-diff');
      for (const [label, content] of [['Published source at draft start', file.baseContent || '(new file)'], ['Your draft', file.content]]) {
        const section = node('section'); const code = node('pre', content); section.append(node('h3', label), code); columns.append(section);
      }
      details.append(columns); body.append(details);
    }
    footer.append(button('Cancel', () => dialog.close()), button('Publish now', () => {
      void this.run(async () => {
        footer.querySelectorAll('button').forEach(item => { item.disabled = true; });
        status.textContent = 'Publishing… Keep this page open.';
        try {
          const result = await this.store.publish();
          body.replaceChildren(node('p', 'Saved to GitHub. Deployment is pending; visitors keep seeing the previous version until it succeeds.'));
          const commit = node('a', 'View published commit'); commit.href = result.htmlUrl; commit.target = '_blank'; commit.rel = 'noopener noreferrer';
          const deploy = node('a', 'View deployment'); deploy.href = `https://github.com/${this.store.snapshot!.repository}/actions`; deploy.target = '_blank'; deploy.rel = 'noopener noreferrer';
          body.append(commit, node('br'), deploy); status.textContent = '';
          footer.replaceChildren(button('Done', () => dialog.close()));
          this.message = 'Published to GitHub. The public site changes when deployment completes.';
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : String(error);
          if (error && typeof error === 'object' && 'status' in error && error.status === 409) {
            footer.append(button('Review latest source', () => { dialog.close(); void this.run(() => this.resolveConflicts()); }));
          }
          footer.querySelectorAll('button').forEach(item => { item.disabled = false; });
        } finally { this.renderBar(); }
      });
    }));
  }
  private async resolveConflicts(): Promise<void> {
    const conflicts = await this.store.refresh();
    if (!conflicts.length) { await this.applyDraft(); this.message = 'Draft updated against the latest source. Review and publish again.'; return; }
    const { dialog, body, footer, status } = this.dialog('Resolve source changes');
    body.append(node('p', 'These files changed on GitHub while you edited. Choose which version to retain. Nothing is overwritten until you review and publish again.'));
    const resolutions: Record<string, 'draft' | 'remote'> = {};
    for (const conflict of conflicts) this.conflictChoice(body, conflict, resolutions);
    footer.append(button('Keep draft unchanged', () => dialog.close()), button('Apply choices', () => {
      void (async () => {
        if (conflicts.some(item => !resolutions[item.path])) { status.textContent = 'Choose a version for every conflicting file.'; return; }
        try {
          const remaining = await this.store.refresh(resolutions);
          if (remaining.length) { status.textContent = 'Source changed again. Close this panel and review the latest source again.'; return; }
          await this.applyDraft(); dialog.close(); this.message = 'Conflicts resolved privately. Review before publishing.';
        } catch (error) { status.textContent = String(error); }
      })();
    }));
  }
  private conflictChoice(parent: HTMLElement, conflict: EditorConflict, resolutions: Record<string, 'draft' | 'remote'>): void {
    const section = node('section'); section.append(node('h3', conflict.path));
    for (const [value, label, content] of [['remote', 'Latest source', conflict.remote ?? '(deleted)'], ['draft', 'Your draft', conflict.draft]] as const) {
      const input = this.input(section, `Keep ${label.toLowerCase()}`, value, 'radio'); input.name = conflict.path;
      input.addEventListener('change', () => { resolutions[conflict.path] = value; });
      section.append(node('pre', content));
    }
    parent.append(section);
  }
}
