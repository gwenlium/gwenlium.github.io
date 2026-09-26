import { navigate } from 'astro:transitions/client';
import { handleControlKeydown } from './controls';
import { createSearchIndex } from '../lib/search';
import { searchKindLabels, type SearchEntry, type SearchIndex, type SearchKind } from '../lib/search-types';
import { availableMobileWindow } from './mobile-windows';

type WindowCommand = { id: string; action: 'restore' } | { action: 'restore-all' };
type StartMenu = {
  dialog: HTMLDialogElement;
  input: HTMLInputElement;
  form: HTMLFormElement;
  kind: HTMLSelectElement;
  clear: HTMLButtonElement;
  more: HTMLButtonElement;
  results: HTMLUListElement;
  status: HTMLElement;
  windows: HTMLUListElement;
  windowCount: HTMLElement;
  emptyWindows: HTMLElement;
  restoreAll: HTMLButtonElement;
  shortcuts: HTMLDetailsElement;
  returnTrigger: HTMLElement | null;
  pendingCommand: WindowCommand | null;
};

const lifetime = new AbortController();
const listenerOptions = { signal: lifetime.signal };
const dockObserver = new ResizeObserver(positionMenu);
let menu: StartMenu | null = null;
let indexPromise: Promise<void> | undefined;
let searchState: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';
let searchIndex: SearchIndex | undefined;
let resultLimit = 10;
const navigationShortcuts: Record<string, string | undefined> = {
  h: '/', d: '/devlog/', l: '/life/', i: '/gallery/', m: '/music/', a: '/about/', s: '/subscribe/',
};


function loadIndex(): void {
  if (indexPromise) return;
  searchState = 'loading';
  renderSearch();
  indexPromise = fetch('/search-index.json')
    .then(async (response) => {
      if (!response.ok) throw new Error(`Search index returned ${response.status}`);
      const payload: unknown = await response.json();
      if (!payload || typeof payload !== 'object' || !('entries' in payload) || !Array.isArray(payload.entries)) {
        throw new Error('Invalid search index');
      }
      const entries: SearchEntry[] = payload.entries.map((entry: unknown) => {
        if (!entry || typeof entry !== 'object'
          || !('id' in entry) || typeof entry.id !== 'string'
          || !('title' in entry) || typeof entry.title !== 'string'
          || !('url' in entry) || typeof entry.url !== 'string' || !entry.url.startsWith('/') || entry.url.startsWith('//')
          || !('kind' in entry) || typeof entry.kind !== 'string' || !Object.hasOwn(searchKindLabels, entry.kind)
          || !('text' in entry) || typeof entry.text !== 'string'
          || !('tags' in entry) || !Array.isArray(entry.tags) || !entry.tags.every((tag) => typeof tag === 'string')) {
          throw new Error('Invalid search entry');
        }
        return { id: entry.id, title: entry.title, url: entry.url, kind: entry.kind as SearchKind, text: entry.text, tags: entry.tags };
      });
      searchIndex = createSearchIndex(entries);
      searchState = 'ready';
      renderSearch();
    })
    .catch(() => {
      searchState = 'failed';
      renderSearch();
    });
}

function highlightedText(text: string, terms: string[]): DocumentFragment {
  const fragment = document.createDocumentFragment();
  let position = 0;
  for (const match of text.matchAll(/[\p{L}\p{N}\p{M}]+/gu)) {
    const word = match[0].normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
    if (!terms.includes(word)) continue;
    fragment.append(text.slice(position, match.index));
    const mark = document.createElement('mark');
    mark.textContent = match[0];
    fragment.append(mark);
    position = match.index + match[0].length;
  }
  fragment.append(text.slice(position));
  return fragment;
}

function renderSearch(): void {
  if (!menu) return;
  const { input, kind, clear, more, results, status } = menu;
  results.replaceChildren();
  results.hidden = true;
  more.hidden = true;
  clear.hidden = !input.value && kind.value === 'all';
  results.setAttribute('aria-busy', String(searchState === 'loading'));
  if (searchState === 'loading') {
    status.textContent = 'Loading search…';
    return;
  }
  if (searchState === 'failed') {
    status.textContent = 'Search could not load. Page links and window recovery are still available below.';
    return;
  }
  if (!searchIndex || (!input.value.trim() && kind.value === 'all')) {
    status.textContent = 'Search the site. Typos and partial words work too.';
    return;
  }
  const matches = searchIndex.search(input.value, kind.value as SearchKind | 'all');
  const count = matches.length;
  status.textContent = count === 0 ? 'No matching content.'
    : count > resultLimit ? `Showing ${resultLimit} of ${count} results, ranked by relevance.`
      : `${count} ${count === 1 ? 'result' : 'results'}.`;
  const fragment = document.createDocumentFragment();
  for (const entry of matches.slice(0, resultLimit)) {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = entry.url;
    const title = document.createElement('span');
    title.className = 'start-result-title';
    title.append(highlightedText(entry.title, entry.terms));
    const category = document.createElement('small');
    category.textContent = searchKindLabels[entry.kind];
    link.append(title, category);
    if (entry.snippet) {
      const snippet = document.createElement('span');
      snippet.className = 'start-result-snippet';
      snippet.append(highlightedText(entry.snippet, entry.terms));
      link.append(snippet);
    }
    item.append(link);
    fragment.append(item);
  }
  results.append(fragment);
  results.hidden = count === 0;
  more.hidden = count <= resultLimit;
}

function renderWindows(): void {
  if (!menu) return;
  const { windows, windowCount, emptyWindows, restoreAll, input } = menu;
  const mobile = document.documentElement.hasAttribute('data-mobile-window-mode');
  const active = document.documentElement.dataset.mobileActiveWindow;
  windows.setAttribute('aria-label', mobile ? 'Available views' : 'Hidden windows');
  emptyWindows.textContent = mobile ? 'No additional views on this page.' : 'All windows are open.';
  const focusedId = document.activeElement instanceof HTMLButtonElement && windows.contains(document.activeElement)
    ? document.activeElement.dataset.restoreWindow : undefined;
  let nextFocus: HTMLButtonElement | undefined;
  let count = 0;
  const fragment = document.createDocumentFragment();
  for (const root of document.querySelectorAll<HTMLElement>('[data-desktop-window]')) {
    const { windowId: id, windowTitle: title, windowState: state } = root.dataset;
    if (!id || (mobile ? !availableMobileWindow(root) : state !== 'minimized' && state !== 'closed')) continue;
    count += 1;
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.restoreWindow = id;
    button.setAttribute('aria-label', `${mobile ? 'Open' : 'Restore'} ${title || 'window'}`);
    if (mobile && id === active) button.setAttribute('aria-current', 'true');
    const label = document.createElement('span');
    const name = document.createElement('span');
    name.textContent = title || 'Window';
    const windowState = document.createElement('small');
    windowState.textContent = mobile ? (id === active ? 'Current view' : 'Available') : state === 'minimized' ? 'Minimized' : 'Closed';
    label.append(name, windowState);
    const action = document.createElement('span');
    action.textContent = mobile ? (id === active ? 'Current' : 'Open') : 'Restore';
    button.append(label, action);
    item.append(button);
    fragment.append(item);
    if (id === focusedId) nextFocus = button;
  }
  windows.replaceChildren(fragment);
  windowCount.textContent = String(count);
  windowCount.setAttribute('aria-label', `${count} ${mobile ? 'available views' : `hidden ${count === 1 ? 'window' : 'windows'}`}`);
  emptyWindows.hidden = count > 0;
  restoreAll.disabled = mobile || count === 0;
  if (focusedId && menu.dialog.open) (nextFocus ?? (count > 0 ? restoreAll : input)).focus({ preventScroll: true });
}

function positionMenu(): void {
  if (!menu?.dialog.open) return;
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft ?? 0;
  const top = viewport?.offsetTop ?? 0;
  const width = viewport?.width ?? window.innerWidth;
  const height = viewport?.height ?? window.innerHeight;
  const gap = 12;
  const dock = document.querySelector<HTMLElement>('.taskbar')?.getBoundingClientRect();
  const bottom = Math.max(top + gap, Math.min(top + height - gap, dock ? dock.top - gap : top + height - gap));
  const availableWidth = Math.max(0, width - gap * 2);
  const { dialog } = menu;
  dialog.style.setProperty('--start-available-width', `${availableWidth}px`);
  dialog.style.setProperty('--start-max-height', `${Math.max(0, bottom - top - gap)}px`);
  dialog.style.setProperty('--start-bottom', `${window.innerHeight - bottom}px`);
  const menuWidth = dialog.getBoundingClientRect().width;
  const alignedLeft = Math.max(left + gap, Math.min(dock?.left ?? left + gap, left + width - menuWidth - gap));
  dialog.style.setProperty('--start-left', `${alignedLeft}px`);
}

function initializeMenu(): void {
  const dialog = document.querySelector<HTMLDialogElement>('#start-menu');
  if (menu?.dialog === dialog) return;
  dockObserver.disconnect();
  menu = dialog ? {
    dialog,
    input: dialog.querySelector<HTMLInputElement>('#start-query')!,
    form: dialog.querySelector<HTMLFormElement>('[data-start-search]')!,
    kind: dialog.querySelector<HTMLSelectElement>('[data-start-kind]')!,
    clear: dialog.querySelector<HTMLButtonElement>('[data-clear-start-search]')!,
    more: dialog.querySelector<HTMLButtonElement>('[data-more-start-results]')!,
    results: dialog.querySelector<HTMLUListElement>('[data-start-results]')!,
    status: dialog.querySelector<HTMLElement>('#start-search-status')!,
    windows: dialog.querySelector<HTMLUListElement>('[data-start-windows]')!,
    windowCount: dialog.querySelector<HTMLElement>('[data-start-window-count]')!,
    emptyWindows: dialog.querySelector<HTMLElement>('[data-start-windows-empty]')!,
    restoreAll: dialog.querySelector<HTMLButtonElement>('[data-restore-all-windows]')!,
    shortcuts: dialog.querySelector<HTMLDetailsElement>('[data-start-shortcuts]')!,
    returnTrigger: null,
    pendingCommand: null,
  } : null;
  const dock = document.querySelector<HTMLElement>('.taskbar');
  if (menu && dock) dockObserver.observe(dock);
  renderWindows();
  renderSearch();
}

function openMenu(trigger: HTMLElement): void {
  if (!menu) initializeMenu();
  if (!menu || menu.dialog.open) return;
  menu.returnTrigger = trigger;
  menu.pendingCommand = null;
  menu.dialog.returnValue = '';
  const mobile = document.documentElement.hasAttribute('data-mobile-window-mode');
  menu.input.autofocus = !mobile;
  renderWindows();
  menu.dialog.showModal();
  positionMenu();
  if (mobile) menu.dialog.querySelector<HTMLButtonElement>('[data-close-start]')?.focus({ preventScroll: true });
  else menu.input.focus({ preventScroll: true });
  loadIndex();
}

function showShortcuts(): void {
  if (!menu?.dialog.open) return;
  menu.shortcuts.open = true;
  const summary = menu.shortcuts.querySelector('summary');
  summary?.focus({ preventScroll: true });
  summary?.scrollIntoView({ block: 'nearest' });
}

// Close the modal before the nonmodal owner editor receives focus.
document.addEventListener('gwenlium:open-site-editor', () => {
  if (!menu?.dialog.open) return;
  menu.returnTrigger = null;
  menu.dialog.close();
}, listenerOptions);

// Astro runs bundled scripts once; delegated listeners cover each new dialog.
document.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) return;
  const opener = event.target.closest<HTMLElement>('[data-open-start]');
  if (opener) {
    openMenu(opener);
    return;
  }
  if (!menu?.dialog.open) return;
  const { dialog } = menu;
  if (event.target === dialog) {
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) {
      dialog.close();
    }
    return;
  }
  if (!dialog.contains(event.target)) return;
  if (event.target.closest('[data-clear-start-search]')) {
    menu.input.value = '';
    menu.kind.value = 'all';
    resultLimit = 10;
    renderSearch();
    menu.input.focus();
    return;
  }
  if (event.target.closest('[data-more-start-results]')) {
    const next = resultLimit;
    resultLimit += 10;
    renderSearch();
    menu.results.querySelectorAll<HTMLAnchorElement>('a')[next]?.focus();
    return;
  }
  if (event.target.closest('[data-close-start]')) {
    dialog.close();
    return;
  }
  if (event.target.closest('[data-open-shortcuts]')) {
    showShortcuts();
    return;
  }
  const restore = event.target.closest<HTMLButtonElement>('[data-restore-window]');
  if (restore?.dataset.restoreWindow) {
    menu.pendingCommand = { id: restore.dataset.restoreWindow, action: 'restore' };
    dialog.close();
    return;
  }
  if (event.target.closest('[data-restore-all-windows]') && !menu.restoreAll.disabled) {
    menu.pendingCommand = { action: 'restore-all' };
    dialog.close();
    return;
  }
  if (event.target.closest('a[href]') && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0) {
    menu.returnTrigger = null;
    dialog.close();
  }
}, listenerOptions);

document.addEventListener('close', (event) => {
  if (!menu || event.target !== menu.dialog || menu.dialog.open) return;
  const command = menu.pendingCommand;
  const trigger = menu.returnTrigger;
  menu.pendingCommand = null;
  menu.returnTrigger = null;
  if (command) {
    // The dialog is no longer modal, so the controller can focus the restored window.
    document.dispatchEvent(new CustomEvent('gwenlium:window-command', { detail: command }));
  } else if (trigger?.isConnected) {
    trigger.focus({ preventScroll: true });
  }
}, { ...listenerOptions, capture: true });

document.addEventListener('input', (event) => {
  if (event.target === menu?.input) { resultLimit = 10; renderSearch(); }
}, listenerOptions);

document.addEventListener('change', (event) => {
  if (event.target === menu?.kind) { resultLimit = 10; renderSearch(); }
}, listenerOptions);

document.addEventListener('submit', (event) => {
  if (!menu || event.target !== menu.form) return;
  event.preventDefault();
  menu.results.querySelector<HTMLAnchorElement>('a')?.click();
}, listenerOptions);

document.addEventListener('keydown', (event) => {
  if (!event.defaultPrevented && !event.isComposing && !event.altKey && !event.ctrlKey && !event.metaKey && menu?.dialog.open) {
    const links = Array.from(menu.results.querySelectorAll<HTMLAnchorElement>('a'));
    const active = document.activeElement;
    let destination: HTMLElement | undefined;
    if (active === menu.input && event.key === 'ArrowDown') destination = links[0];
    else if (active === menu.input && event.key === 'ArrowUp') destination = links[links.length - 1];
    else if (active instanceof HTMLAnchorElement && links.includes(active)) {
      const index = links.indexOf(active);
      if (event.key === 'ArrowDown') destination = links[Math.min(index + 1, links.length - 1)];
      else if (event.key === 'ArrowUp') destination = index === 0 ? menu.input : links[index - 1];
      else if (event.key === 'Home') destination = links[0];
      else if (event.key === 'End') destination = links[links.length - 1];
    }
    if (destination) {
      event.preventDefault();
      destination.focus();
      destination.scrollIntoView({ block: 'nearest' });
      return;
    }
  }
  if (handleControlKeydown(event)) return;
  if (event.defaultPrevented || event.isComposing || event.repeat) return;
  const key = event.key.toLowerCase();
  const searchShortcut = key === 'k' && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
  if ((event.altKey || event.ctrlKey || event.metaKey) && !searchShortcut) {
    return;
  }
  if (event.target instanceof HTMLElement
    && (event.target.isContentEditable || event.target.closest('input, textarea, select, [role="textbox"]'))) {
    return;
  }

  const openDialog = document.querySelector<HTMLDialogElement>('dialog[open]');
  if (searchShortcut || key === '/' || key === '?') {
    if (openDialog && openDialog !== menu?.dialog) return;
    const trigger = document.querySelector<HTMLElement>('[data-open-start]');
    if (!trigger) return;
    event.preventDefault();
    openMenu(trigger);
    if (key === '?') showShortcuts();
    else menu?.input.focus({ preventScroll: true });
    return;
  }
  if (openDialog) return;

  const destination = Object.hasOwn(navigationShortcuts, key) ? navigationShortcuts[key] : undefined;
  if (destination) {
    event.preventDefault();
    void navigate(destination);
    return;
  }
  const control = key === 'p'
    ? document.querySelector<HTMLButtonElement>('[data-player-toggle]:not(:disabled)')
    : key === ',' ? document.querySelector<HTMLButtonElement>('[data-open-settings]:not(:disabled)') : null;
  if (control) {
    event.preventDefault();
    control.click();
  }
}, listenerOptions);

document.addEventListener('gwenlium:windows-changed', renderWindows, listenerOptions);
document.addEventListener('astro:page-load', initializeMenu, listenerOptions);
document.addEventListener('astro:before-swap', () => {
  const previous = menu;
  menu = null;
  dockObserver.disconnect();
  if (previous?.dialog.open) previous.dialog.close();
}, listenerOptions);
window.addEventListener('resize', positionMenu, listenerOptions);
document.addEventListener('gwenlium:chrome-change', positionMenu, listenerOptions);
window.visualViewport?.addEventListener('resize', positionMenu, listenerOptions);
window.visualViewport?.addEventListener('scroll', positionMenu, listenerOptions);

initializeMenu();

if (import.meta.hot) import.meta.hot.dispose(() => {
  lifetime.abort();
  dockObserver.disconnect();
  if (menu?.dialog.open) menu.dialog.close();
  menu = null;
});

export {};
