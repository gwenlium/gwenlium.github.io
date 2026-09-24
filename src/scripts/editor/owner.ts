import { builtinWindowPages, systemWindowIds, windowPages, windowTones } from '../../lib/window-catalogue.mjs';
import { previewText } from '../../lib/preview-text.mjs';
import type { EditorBinding } from '../../lib/editor-types';
import type { WindowDefinition } from '../../lib/windows';
import { ownerStore, writerUrl } from './session';
import { isPostPath, type SiteEditorStore } from './store';
import { renderMarkdownPreview } from './markdown';
import { createRichText, type RichTextHandle } from './rich-text';
import { chooseFromLibrary, stageFiles } from './media';
import { openPublish, resumeLiveCheck } from './publish';
import { openAnalytics } from './analytics';
import { anchoredPanel, button, confirmAction, errorText, node, openDialog, toast } from './ui';
import { hasOwnerHint } from './auth';
import '../../styles/owner-editor.css';

const windowsFile = 'src/content/windows.json';
const galleryFile = 'src/content/gallery.json';
const root = document.documentElement;
const pointerPart = (value: string) => value.replace(/~/g, '~0').replace(/\//g, '~1');
const binding = (file: string, field: string, label: string, format: EditorBinding['format'] = 'text'): EditorBinding => ({ file, field, label, format });

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

/** The journal entry this page shows, if any (from the post window's own bindings). */
function currentEntry(): string | undefined {
  const title = document.querySelector<HTMLElement>('#post-entry [data-site-edit-field="/title"]');
  const file = title?.dataset.siteEditFile;
  return file && isPostPath(file) ? file : undefined;
}

function currentSection(): 'devlog' | 'life' {
  return location.pathname.startsWith('/life') ? 'life' : 'devlog';
}

function placeCaret(element: HTMLElement, event?: MouseEvent): void {
  const selection = getSelection();
  if (!selection) return;
  const range = event && 'caretPositionFromPoint' in document
    ? (() => { const position = document.caretPositionFromPoint(event.clientX, event.clientY); if (!position || !element.contains(position.offsetNode)) return undefined; const r = document.createRange(); r.setStart(position.offsetNode, position.offset); return r; })()
    : undefined;
  const target = range ?? (() => { const r = document.createRange(); r.selectNodeContents(element); r.collapse(false); return r; })();
  selection.removeAllRanges();
  selection.addRange(target);
}

let controls: OwnerControls | undefined;

/** Load the owner controls. Interactive starts (hotkey, ?edit=1) ask to sign in when needed. */
export async function startOwner(interactive: boolean): Promise<void> {
  controls ??= new OwnerControls(ownerStore());
  await controls.start(interactive);
}

class OwnerControls {
  private editing = false;
  private busy = false;
  private rendering = 0;
  private dialogue?: string;
  private down = { x: 0, y: 0 };
  private pendingLayouts = new Map<string, { id: string; x: number; y: number; width: number; height: number; floating: boolean }>();
  private savingLayouts = false;
  private createdWindows = new Set<HTMLElement>();
  private windowVersions = new Map<HTMLElement, string>();
  private windowTemplates = new Map<string, HTMLElement>();
  private inline?: { element: HTMLElement; finish(save: boolean): Promise<void> };
  private connecting = false;
  private banner?: HTMLElement;

  constructor(private store: SiteEditorStore) {
    store.subscribe(() => this.renderTaskbar());
    document.addEventListener('pointerdown', event => { this.down = { x: event.clientX, y: event.clientY }; }, true);
    document.addEventListener('click', event => this.handleClick(event), true);
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && this.editing && !this.inline && !document.querySelector('dialog[open], :popover-open.owner-popover')) this.setEditing(false);
    });
    document.addEventListener('astro:before-swap', event => {
      void this.inline?.finish(true);
      this.renderTaskbar((event as Event & { newDocument: Document }).newDocument);
      this.rendering++;
      this.windowTemplates.clear();
      this.windowVersions.clear();
      this.createdWindows.clear();
    });
    document.addEventListener('astro:page-load', () => {
      if (!this.store.authenticated) return;
      this.renderTaskbar();
      if (this.editing) this.showBanner();
      void this.applyDraft();
    });
    document.addEventListener('gwenlium:editor-window-layout', event => this.saveLayout(event));
    addEventListener('beforeunload', event => { if (this.busy || this.inline) event.preventDefault(); });
  }

  async start(interactive: boolean): Promise<void> {
    if (!this.store.authenticated) {
      // A remembered browser shows its buttons right away; connecting to GitHub can take a second.
      this.connecting = hasOwnerHint();
      this.renderTaskbar();
      try {
        if (!await this.store.restore()) { this.connecting = false; this.renderTaskbar(); if (interactive) this.signInPrompt(); return; }
      } catch (error) {
        this.connecting = false;
        this.renderTaskbar();
        toast(errorText(error, 'The editor could not connect. Try again in a moment.'));
        return;
      }
      this.connecting = false;
      this.renderTaskbar();
      void this.applyDraft();
      resumeLiveCheck(this.store);
      if (interactive) toast(`Signed in. Use Edit in the taskbar to write or change the site.`);
    } else if (interactive) this.openMenu();
  }

  private signInPrompt(): void {
    const { dialog, body, footer, status } = openDialog('Edit your website');
    body.append(node('p', 'Sign in with your GitHub account. You stay signed in on this browser, so next time the Edit button is simply there.'));
    const signIn = button('Sign in with GitHub', () => {
      // The popup must open inside this click.
      const signing = this.store.signIn();
      signIn.disabled = true;
      status.textContent = 'Waiting for GitHub…';
      signing.then(() => {
        // Analytics already running in this tab would share it with the new sign-in: start clean.
        if ((window as { gwenliumBeacon?: boolean }).gwenliumBeacon) { location.reload(); return; }
        dialog.close();
        this.renderTaskbar();
        void this.applyDraft();
        resumeLiveCheck(this.store);
        toast('Signed in. Use Edit in the taskbar to write or change the site.');
      }, error => { status.textContent = errorText(error); signIn.disabled = false; });
    }, 'owner-button owner-button--primary');
    footer.append(button('Not now', () => dialog.close()), signIn);
    signIn.focus();
  }

  /** Show the owner's taskbar buttons (Edit, Publish) in this page or the incoming one. */
  private renderTaskbar(target: Document = document): void {
    const signedIn = this.store.authenticated;
    for (const control of target.querySelectorAll<HTMLElement>('[data-owner-editor]')) control.hidden = !signedIn && !this.connecting;
    const count = this.store.draftFiles.length;
    for (const publish of target.querySelectorAll<HTMLButtonElement>('[data-owner-publish]')) {
      publish.hidden = !signedIn || !count;
      publish.textContent = this.store.local ? `Save to files (${count})` : `Publish (${count})`;
      publish.title = count === 1 ? '1 unpublished change' : `${count} unpublished changes`;
    }
    if (target === document && !signedIn && this.editing) this.setEditing(false);
  }

  private handleClick(event: MouseEvent): void {
    if (!(event.target instanceof Element)) return;
    const menu = event.target.closest('[data-owner-menu]');
    if (menu && (this.store.authenticated || this.connecting)) {
      event.preventDefault();
      document.dispatchEvent(new Event('gwenlium:open-site-editor'));
      this.openMenu(menu);
      return;
    }
    if (event.target.closest('[data-owner-publish]') && this.store.authenticated) {
      event.preventDefault();
      void openPublish(this.store, () => this.applyDraft());
      return;
    }
    if (!this.editing || this.busy || event.target.closest('.owner-inline, .owner-dialog, .owner-popover, .owner-banner, .media-library, .taskbar')) return;
    // A drag (moving a window) is not a click on its content.
    if (Math.hypot(event.clientX - this.down.x, event.clientY - this.down.y) > 6 && event.detail) return;
    const element = event.target.closest<HTMLElement>('[data-site-edit-file][data-site-edit-field]');
    const target = element && sourceBinding(element);
    if (!element || !target) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void this.edit(element, target, event);
  }

  private openMenu(anchor: Element = document.querySelector('.taskbar [data-owner-menu]') ?? document.body): void {
    if (!this.store.authenticated) { toast('Still connecting to GitHub…'); return; }
    const { panel, close } = anchoredPanel(anchor, 'owner-popover owner-menu');
    panel.setAttribute('role', 'menu');
    panel.setAttribute('aria-label', 'Edit website');
    const entry = currentEntry();
    const item = (label: string, hint: string, run: () => void, primary = false) => {
      const element = button('', () => { close(); run(); }, `owner-menu__item${primary ? ' owner-menu__item--primary' : ''}`);
      element.setAttribute('role', 'menuitem');
      element.append(node('strong', label), node('small', hint));
      return element;
    };
    const go = (href: string) => { location.href = href; };
    panel.append(node('p', this.store.local ? 'Editing local files' : 'Edit website', 'owner-menu__heading'));
    panel.append(item('New entry', `Write a new ${currentSection() === 'life' ? 'Life' : 'Devlog'} post`, () => go(writerUrl({ fresh: true, section: currentSection() })), true));
    if (entry) panel.append(item('Edit this entry', 'Text, pictures, tags and visibility', () => go(writerUrl({ entry }))));
    panel.append(item(this.editing ? 'Stop editing this page' : 'Edit this page', this.editing ? 'Back to browsing' : 'Click text or pictures on the page to change them', () => this.setEditing(!this.editing)));
    panel.append(item('All entries', 'Drafts, published and scheduled posts', () => go(writerUrl())));
    if (pageName() === 'gallery') panel.append(item('Add to gallery', 'Pictures or video from this device', () => this.pickGallery()));
    const more = node('div', undefined, 'owner-menu__more');
    more.append(
      button('Windows', () => { close(); void this.windowList(); }, 'owner-menu__small'),
      ...(this.store.local ? [] : [button('Analytics', () => { close(); openAnalytics(() => this.store.accessToken()); }, 'owner-menu__small')]),
      button('Discard changes', () => { close(); void this.discard(); }, 'owner-menu__small'),
      button('Sign out', () => { close(); this.signOut(); }, 'owner-menu__small'),
    );
    panel.append(more);
    queueMicrotask(() => panel.querySelector<HTMLElement>('[role="menuitem"]')?.focus());
    panel.addEventListener('keydown', event => {
      const items = [...panel.querySelectorAll<HTMLElement>('button')];
      const index = items.indexOf(document.activeElement as HTMLElement);
      if (event.key === 'ArrowDown') { event.preventDefault(); items[(index + 1) % items.length]?.focus(); }
      if (event.key === 'ArrowUp') { event.preventDefault(); items[(index - 1 + items.length) % items.length]?.focus(); }
    });
  }

  private pickGallery(): void {
    const input = node('input');
    input.type = 'file'; input.multiple = true; input.accept = '.jpg,.jpeg,.png,.webp,.gif,.mp4,.mov,.m4v,.webm';
    input.addEventListener('change', () => void (async () => {
      const files = [...(input.files ?? [])];
      if (!files.length) return;
      try {
        await addGalleryPicture(this.store, files, text => toast(text, { sticky: true }));
        await this.applyDraft();
        this.setEditing(true);
        toast(files.length === 1 ? 'Added. Click its title and description to fill them in.' : 'Added. Click each title and description to fill them in.');
      } catch (error) { toast(errorText(error)); }
    })());
    input.click();
  }

  private setEditing(on: boolean): void {
    if (on === this.editing) return;
    this.editing = on;
    if (on) {
      root.dataset.siteEditing = 'true';
      this.dialogue ??= root.dataset.dialogue;
      root.dataset.dialogue = 'off';
      this.showBanner();
    } else {
      void this.inline?.finish(true);
      delete root.dataset.siteEditing;
      if (this.dialogue !== undefined) root.dataset.dialogue = this.dialogue;
      this.dialogue = undefined;
      this.banner?.remove();
      this.banner = undefined;
    }
    document.dispatchEvent(new CustomEvent('gwenlium:editor-mode-changed'));
  }

  private showBanner(): void {
    this.banner?.remove();
    const banner = node('div', undefined, 'owner-banner');
    banner.popover = 'manual';
    banner.append(node('span', 'Click outlined text or pictures to change them. Moving a window sets where it opens for visitors.'), button('Done', () => this.setEditing(false), 'owner-button owner-button--primary'));
    document.body.append(banner);
    banner.showPopover();
    this.banner = banner;
  }

  private async discard(): Promise<void> {
    if (!this.store.dirty) { toast('There are no unpublished changes.'); return; }
    if (!await confirmAction('Discard unpublished changes?', 'This removes every change and prepared picture you have not published yet, on this browser. The live website is not affected.', 'Discard changes', true)) return;
    try { await this.store.discard(); this.windowVersions.clear(); await this.applyDraft(); toast('Unpublished changes discarded.'); }
    catch (error) { toast(errorText(error)); }
  }

  private signOut(): void {
    const { dialog, body, footer, status } = openDialog('Sign out');
    const note = this.store.dirty ? ' Your unpublished changes stay saved on this browser for when you sign in again.' : '';
    body.append(node('p', `You will need to sign in with GitHub again to edit from this browser.${note}`));
    const everywhere = node('label', undefined, 'owner-check');
    const box = node('input');
    box.type = 'checkbox';
    const text = node('span');
    text.append(node('strong', 'Also sign out on every other device'), node('small', 'Use this if a laptop or phone that was signed in is lost or shared.'));
    everywhere.append(box, text);
    if (!this.store.local) body.append(everywhere);
    const confirm = button('Sign out', () => void (async () => {
      footer.querySelectorAll('button').forEach(item => { item.disabled = true; });
      status.textContent = 'Signing out…';
      this.setEditing(false);
      const warning = await this.store.signOut(box.checked);
      if (warning) {
        status.textContent = warning;
        footer.replaceChildren(button('Close', () => location.reload(), 'owner-button owner-button--primary'));
      } else location.reload();
    })(), 'owner-button owner-button--primary');
    footer.append(button('Cancel', () => dialog.close()), confirm);
    confirm.focus();
  }

  // Editing in place

  private async edit(element: HTMLElement, target: EditorBinding, event: MouseEvent): Promise<void> {
    await this.inline?.finish(true);
    if (isPostPath(target.file)) { location.href = writerUrl({ entry: target.file }); return; }
    try {
      if (target.format === 'markdown') await this.editRichText(element, target);
      else if (target.format === 'image') await this.editPicture(element, target);
      else if (!element.dataset.siteEditTemplate && [...element.childNodes].every(child => child.nodeType === Node.TEXT_NODE)) await this.editText(element, target, event);
      else await this.editTextPanel(element, target);
    } catch (error) { toast(errorText(error)); }
  }

  private async editText(element: HTMLElement, target: EditorBinding, event: MouseEvent): Promise<void> {
    const value = String(await this.store.get(target) ?? '');
    const before = element.textContent ?? '';
    const multiline = value.includes('\n') || /^(P|DIV|FIGCAPTION|BLOCKQUOTE|DD)$/.test(element.tagName);
    element.textContent = value;
    element.contentEditable = 'plaintext-only';
    if (element.contentEditable !== 'plaintext-only') element.contentEditable = 'true';
    element.classList.add('owner-inline', 'owner-inline--text');
    element.focus({ preventScroll: true });
    placeCaret(element, event);
    const lifetime = new AbortController();
    const finish = async (save: boolean) => {
      if (lifetime.signal.aborted) return;
      lifetime.abort();
      if (this.inline?.element === element) this.inline = undefined;
      element.contentEditable = 'false';
      element.removeAttribute('contenteditable');
      element.classList.remove('owner-inline', 'owner-inline--text');
      const next = (element.innerText ?? '').replace(/\r/g, '').replace(/\n+$/, '');
      if (!save || next === value) { element.textContent = before; return; }
      try { await this.store.set(target, next); await this.applyDraft(); }
      catch (error) { element.textContent = before; toast(errorText(error)); }
    };
    this.inline = { element, finish };
    element.addEventListener('keydown', keyEvent => {
      if (keyEvent.key === 'Escape') { keyEvent.preventDefault(); keyEvent.stopPropagation(); void finish(false); }
      else if (keyEvent.key === 'Enter' && (!multiline || keyEvent.ctrlKey || keyEvent.metaKey) && !keyEvent.shiftKey) { keyEvent.preventDefault(); element.blur(); }
    }, { signal: lifetime.signal });
    element.addEventListener('paste', pasteEvent => {
      if (element.contentEditable === 'plaintext-only') return;
      pasteEvent.preventDefault();
      const selection = getSelection();
      if (!selection?.rangeCount) return;
      const range = selection.getRangeAt(0);
      range.deleteContents();
      const text = document.createTextNode(pasteEvent.clipboardData?.getData('text/plain') ?? '');
      range.insertNode(text);
      range.setStartAfter(text);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    }, { signal: lifetime.signal });
    element.addEventListener('blur', () => void finish(true), { signal: lifetime.signal });
  }

  private async editTextPanel(element: HTMLElement, target: EditorBinding): Promise<void> {
    const value = String(await this.store.get(target) ?? '');
    const { panel, close } = anchoredPanel(element);
    const field = node('textarea', undefined, 'owner-field');
    field.value = value;
    field.rows = Math.min(8, Math.max(2, value.split('\n').length + 1));
    field.setAttribute('aria-label', target.label);
    const hint = element.dataset.siteEditTemplate === 'site-name' ? node('small', 'Write {name} where your display name should appear.') : undefined;
    const save = button('Save', () => void (async () => {
      try { await this.store.set(target, field.value); await this.applyDraft(); close(); }
      catch (error) { toast(errorText(error)); }
    })(), 'owner-button owner-button--primary');
    const actions = node('div', undefined, 'owner-popover__actions');
    actions.append(button('Cancel', close), save);
    panel.append(node('strong', target.label), field, ...(hint ? [hint] : []), actions);
    field.addEventListener('keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) save.click(); });
    queueMicrotask(() => field.focus());
  }

  private async editRichText(element: HTMLElement, target: EditorBinding): Promise<void> {
    const value = String(await this.store.get(target) ?? '');
    const saved = [...element.childNodes];
    const host = node('div', undefined, 'owner-inline owner-inline--rich');
    host.dataset.typewriterSkip = '';
    const status = node('p', '', 'owner-inline__status');
    status.setAttribute('role', 'status');
    let handle: RichTextHandle | undefined;
    const lifetime = new AbortController();
    const finish = async (save: boolean) => {
      if (lifetime.signal.aborted) return;
      lifetime.abort();
      if (this.inline?.element === element) this.inline = undefined;
      const markdown = handle?.getMarkdown() ?? value;
      handle?.destroy();
      element.replaceChildren(...saved);
      if (!save || markdown === value) return;
      try { await this.store.set(target, markdown); await this.applyDraft(); }
      catch (error) { toast(errorText(error)); }
    };
    const actions = node('div', undefined, 'owner-inline__actions');
    actions.append(button('Cancel', () => void finish(false)), button('Done', () => void finish(true), 'owner-button owner-button--primary'));
    element.replaceChildren(host);
    handle = createRichText(host, {
      markdown: value, placeholder: 'Write here…', label: target.label, compact: true,
      resolveMedia: url => this.store.resolveMedia(url),
      addPictures: async files => (await stageFiles(this.store, files, text => { status.textContent = text; })).map(file => file.url),
      chooseFromLibrary: () => chooseFromLibrary(this.store, true),
      onChange: () => undefined,
      onStatus: text => { status.textContent = text; },
    });
    host.append(status, actions);
    this.inline = { element, finish };
    handle.focus();
  }

  private async editPicture(element: HTMLElement, target: EditorBinding): Promise<void> {
    const current = String(await this.store.get(target) ?? '');
    const currentAlt = target.altField ? String(await this.store.get({ ...target, field: target.altField }) ?? '') : '';
    const { panel, close } = anchoredPanel(element);
    let source = current;
    const preview = node('img', undefined, 'owner-popover__image');
    const render = () => { preview.hidden = !source; if (source) preview.src = this.store.resolveMedia(source); };
    render();
    const status = node('small', '');
    const file = node('input');
    file.type = 'file'; file.accept = '.jpg,.jpeg,.png,.webp,.gif'; file.hidden = true;
    file.addEventListener('change', () => void (async () => {
      const picked = file.files?.[0];
      file.value = '';
      if (!picked) return;
      try { source = (await stageFiles(this.store, [picked], text => { status.textContent = text; }))[0].url; render(); }
      catch (error) { status.textContent = errorText(error); }
    })());
    const alt = node('input', undefined, 'owner-field');
    alt.value = currentAlt;
    alt.placeholder = 'Describe this picture';
    alt.setAttribute('aria-label', 'Picture description');
    const choices = node('div', undefined, 'owner-popover__actions owner-popover__actions--start');
    choices.append(
      button('Replace…', () => file.click()),
      button('From library', () => void chooseFromLibrary(this.store, true).then(url => { if (url) { source = url; render(); } })),
      button('Remove', () => { source = ''; render(); }),
    );
    const actions = node('div', undefined, 'owner-popover__actions');
    actions.append(button('Cancel', close), button('Save', () => void (async () => {
      try {
        await this.store.set(target, source);
        if (target.altField) await this.store.set({ ...target, field: target.altField }, source ? alt.value.trim() : '');
        await this.applyDraft();
        close();
      } catch (error) { status.textContent = errorText(error); }
    })(), 'owner-button owner-button--primary'));
    panel.append(node('strong', target.label), preview, choices, ...(target.altField ? [alt] : []), status, file, actions);
  }

  // Window arrangement and custom windows

  private saveLayout(event: Event): void {
    if (!this.store.authenticated || !this.editing || !(event instanceof CustomEvent)) return;
    const layout = event.detail;
    if (!layout || typeof layout.id !== 'string' || systemWindowIds.includes(layout.id) || typeof layout.floating !== 'boolean'
      || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(layout[key]))) return;
    this.pendingLayouts.set(layout.id, { id: layout.id, x: Math.round(layout.x), y: Math.round(layout.y), width: Math.round(layout.width), height: Math.round(layout.height), floating: layout.floating });
    if (this.savingLayouts) return;
    this.savingLayouts = true;
    void (async () => {
      try {
        while (this.pendingLayouts.size) {
          const records = await this.windows();
          for (const next of this.pendingLayouts.values()) {
            const item = records.find(record => record.id === next.id);
            if (item) Object.assign(item, next);
          }
          this.pendingLayouts.clear();
          await this.store.set(binding(windowsFile, '/windows', 'Windows'), records);
        }
      } catch (error) { toast(errorText(error)); }
      finally { this.savingLayouts = false; }
    })();
  }

  private async windows(): Promise<WindowDefinition[]> {
    return await this.store.get(binding(windowsFile, '/windows', 'Windows')) as WindowDefinition[];
  }

  private async windowList(): Promise<void> {
    const records = await this.windows();
    const { dialog, body, footer } = openDialog('Windows');
    body.append(node('p', 'Your own windows can hold text, pictures or links. Built-in windows can be renamed, recoloured or hidden.'));
    const list = node('div', undefined, 'owner-choice-list');
    for (const item of records.filter(record => !systemWindowIds.includes(record.id))) {
      const choice = button('', () => { dialog.close(); void this.windowForm(item); }, 'owner-choice');
      choice.append(node('strong', item.title || item.id), node('small', `${item.page === 'all' ? 'Every page' : item.page}${item.enabled ? '' : ', hidden'}`));
      list.append(choice);
    }
    body.append(list);
    footer.append(button('Close', () => dialog.close()), button('New window', () => { dialog.close(); void this.windowForm(); }, 'owner-button owner-button--primary'));
  }

  private async windowForm(existing?: WindowDefinition): Promise<void> {
    const { dialog, body, footer, status } = openDialog(existing ? 'Window settings' : 'New window');
    const field = (label: string, input: HTMLElement) => { const wrap = node('label', undefined, 'owner-label'); wrap.append(node('span', label), input); body.append(wrap); return input; };
    const title = field('Title', Object.assign(node('input', undefined, 'owner-field'), { value: existing?.title || '' })) as HTMLInputElement;
    const page = field('Shows on', node('select', undefined, 'owner-field')) as HTMLSelectElement;
    for (const value of windowPages) { const option = node('option', value === 'all' ? 'Every page' : value === 'not-found' ? 'Page not found' : value === 'post' ? 'Every journal entry' : value[0].toUpperCase() + value.slice(1)); option.value = value; page.append(option); }
    page.value = existing?.page || pageName();
    page.disabled = Boolean(existing && Object.hasOwn(builtinWindowPages, existing.id));
    const tone = field('Colour', node('select', undefined, 'owner-field')) as HTMLSelectElement;
    for (const value of windowTones) { const option = node('option', value[0].toUpperCase() + value.slice(1)); option.value = value; tone.append(option); }
    tone.value = existing?.tone || 'sage';
    const check = (label: string, checked: boolean) => { const wrap = node('label', undefined, 'owner-check'); const input = node('input'); input.type = 'checkbox'; input.checked = checked; wrap.append(input, node('span', label)); body.append(wrap); return input; };
    const enabled = check('Visible', existing?.enabled ?? true);
    const closed = check('Starts closed (visitors open it from the taskbar)', existing?.initiallyClosed ?? false);
    body.append(node('p', 'To place or resize it, use Edit this page and move the window where you want it.', 'owner-hint'));
    footer.append(button('Cancel', () => dialog.close()));
    if (existing && !Object.hasOwn(builtinWindowPages, existing.id)) footer.append(button('Delete window', () => void (async () => {
      if (!await confirmAction('Delete this window?', 'It disappears from the website when you publish.', 'Delete window', true)) return;
      await this.store.set(binding(windowsFile, '/windows', 'Windows'), (await this.windows()).filter(item => item.id !== existing.id));
      await this.applyDraft(); dialog.close();
    })().catch(error => { status.textContent = errorText(error); }), 'owner-button owner-button--danger'));
    footer.append(button(existing ? 'Save' : 'Create window', () => void (async () => {
      try {
        if (!title.value.trim()) throw new Error('Give the window a title.');
        const records = await this.windows();
        const item: WindowDefinition = { ...(existing || { id: `custom-${crypto.randomUUID()}`, content: 'text', body: '', media: [], links: [], items: [], limit: 0, width: 480, height: 0, floating: false }),
          title: title.value.trim(), page: page.value as WindowDefinition['page'], tone: tone.value as WindowDefinition['tone'],
          enabled: enabled.checked, initiallyClosed: closed.checked };
        const index = records.findIndex(row => row.id === item.id);
        if (index >= 0) records[index] = item; else records.push(item);
        await this.store.set(binding(windowsFile, '/windows', 'Windows'), records);
        await this.applyDraft(); dialog.close();
        if (!existing && (item.page === pageName() || item.page === 'all')) {
          this.setEditing(true);
          toast('Window created. Click its text area to write in it.');
        } else if (!existing) toast('Window created. It shows on its page once you get there.');
      } catch (error) { status.textContent = errorText(error); }
    })(), 'owner-button owner-button--primary'));
    title.focus();
  }

  // Show unpublished changes on the page itself

  async applyDraft(): Promise<void> {
    if (!this.store.authenticated) return;
    const version = ++this.rendering;
    try {
      await this.syncWindows();
      if (version !== this.rendering) return;
      await this.syncGallery();
      if (version !== this.rendering) return;
      // Only files with unpublished changes differ from what the page already shows.
      const changed = new Set(this.store.draftFiles.filter(file => !file.deleted).map(file => file.path));
      const targets = [...document.querySelectorAll<HTMLElement>('[data-site-edit-file][data-site-edit-field]')];
      await Promise.all(targets.map(async element => {
        const target = sourceBinding(element);
        if (!target || element.classList.contains('owner-inline') || !changed.has(target.file)) return;
        const value = await this.store.get(target);
        if (version !== this.rendering || !element.isConnected) return;
        if (target.format === 'image') {
          const image = element instanceof HTMLImageElement ? element : element.querySelector('img');
          if (image && typeof value === 'string') {
            const next = value ? this.store.resolveMedia(value) : '';
            if (image.getAttribute('src') !== next) {
              image.src = next;
              image.removeAttribute('srcset');
              image.closest('picture')?.querySelectorAll('source').forEach(source => source.removeAttribute('srcset'));
            }
            image.hidden = !value;
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
          const text = String(value ?? '');
          const shown = element.dataset.siteEditTemplate === 'site-name'
            ? text.replaceAll('{name}', String(await this.store.get(binding('src/content/site.json', '/name', 'Site name'))))
            : text;
          // Typewriter and other decorated labels keep their markup when the text is unchanged.
          if (element.textContent !== shown) element.textContent = shown;
        }
      }));
      document.dispatchEvent(new CustomEvent('gwenlium:editor-windows-changed'));
    } catch (error) {
      if (version === this.rendering) toast(errorText(error, 'Some unpublished changes could not be shown on this page.'));
    }
  }

  private async syncWindows(): Promise<void> {
    if (!this.store.draftFiles.some(file => file.path === windowsFile)) return;
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
      const item = records.find(record => record.id === element.id);
      if (!item || !item.enabled || (item.page !== page && item.page !== 'all')) { element.remove(); this.createdWindows.delete(element); }
    }
    for (const item of records) {
      if (systemWindowIds.includes(item.id)) continue;
      let element = document.getElementById(item.id);
      const belongs = item.page === page || item.page === 'all';
      if (!element && item.enabled && belongs) {
        const template = [...document.querySelectorAll<HTMLTemplateElement>('template[data-site-editor-window]')].find(candidate => candidate.dataset.siteEditorWindow === item.id);
        const frame = template?.content.firstElementChild || this.windowTemplates.get(item.id);
        if (frame instanceof HTMLElement) {
          element = frame.cloneNode(true) as HTMLElement;
          document.getElementById('main-content')?.append(element);
          this.createdWindows.add(element);
        }
      }
      if (!element && item.enabled && belongs && !Object.hasOwn(builtinWindowPages, item.id)) {
        element = node('section', undefined, `window window--${item.tone} owner-created-window`);
        element.id = item.id; element.dataset.desktopWindow = ''; element.tabIndex = -1;
        const titlebar = node('div', undefined, 'window-titlebar');
        titlebar.append(node('span', '', 'window-titlebar__mark'), node('span', item.title, 'window-titlebar__title'));
        element.append(titlebar, node('div', undefined, 'window-body'));
        (document.querySelector('#page-scroll main') || document.querySelector('main'))?.append(element);
        this.createdWindows.add(element);
      }
      if (!element || !belongs) continue;
      if (!item.enabled) { element.hidden = true; continue; }
      const serialized = JSON.stringify(item);
      if (this.windowVersions.get(element) === serialized) continue;
      this.windowVersions.set(element, serialized);
      element.dataset.windowState = item.initiallyClosed ? 'closed' : 'normal';
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
    if (pageName() !== 'gallery' || !this.store.draftFiles.some(file => file.path === galleryFile)) return;
    const version = this.rendering;
    const data = await this.store.get(binding(galleryFile, '/items', 'Gallery')) as Array<Record<string, unknown>>;
    if (version !== this.rendering) return;
    let grid = document.querySelector<HTMLElement>('.gallery-grid');
    if (!grid && data.length) {
      grid = node('div', undefined, 'gallery-grid');
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
      const card = node('article', undefined, 'window gallery-item window--pink');
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
}

/** Gallery pictures are added from the Gallery page's own editing. */
export async function addGalleryPicture(store: SiteEditorStore, files: File[], onStatus: (text: string) => void): Promise<void> {
  const staged = await stageFiles(store, files, onStatus);
  const items = await store.get(binding(galleryFile, '/items', 'Gallery')) as Record<string, unknown>[];
  for (const file of staged) items.push({ id: `picture-${crypto.randomUUID()}`, title: 'Untitled', type: file.kind === 'video' ? 'video' : 'image', src: file.url, alt: '', caption: '', poster: '', topics: [] });
  await store.set(binding(galleryFile, '/items', 'Gallery'), items);
}
