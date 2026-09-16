import { navigate } from 'astro:transitions/client';

type SearchEntry = { title: string; url: string; kind: 'page' | 'post'; text: string };
type WindowCommand = { id: string; action: 'restore' } | { action: 'restore-all' };
type StartMenu = {
  dialog: HTMLDialogElement;
  input: HTMLInputElement;
  form: HTMLFormElement;
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
let entries: SearchEntry[] = [];
let navigationPrefixExpires = 0;
const navigationShortcuts: Record<string, string | undefined> = {
  h: '/', d: '/devlog/', p: '/game/', i: '/gallery/', m: '/music/', a: '/about/',
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
      entries = payload.entries.map((entry: unknown) => {
        if (!entry || typeof entry !== 'object'
          || !('title' in entry) || typeof entry.title !== 'string'
          || !('url' in entry) || typeof entry.url !== 'string' || !entry.url.startsWith('/') || entry.url.startsWith('//')
          || !('kind' in entry) || (entry.kind !== 'page' && entry.kind !== 'post')
          || !('text' in entry) || typeof entry.text !== 'string') {
          throw new Error('Invalid search entry');
        }
        return { title: entry.title, url: entry.url, kind: entry.kind, text: entry.text.normalize('NFKC').toLocaleLowerCase('en') };
      });
      searchState = 'ready';
      renderSearch();
    })
    .catch(() => {
      searchState = 'failed';
      renderSearch();
    });
}

function renderSearch(): void {
  if (!menu) return;
  const { input, results, status } = menu;
  results.replaceChildren();
  results.hidden = true;
  results.setAttribute('aria-busy', searchState === 'loading' ? 'true' : 'false');
  if (searchState === 'loading') {
    status.textContent = 'Loading search…';
    return;
  }
  if (searchState === 'failed') {
    status.textContent = 'Search could not load. Page links and window recovery are still available below.';
    return;
  }
  const terms = input.value.normalize('NFKC').toLocaleLowerCase('en').trim().split(/\s+/).filter(Boolean);
  if (searchState !== 'ready' || terms.length === 0) {
    status.textContent = 'Search pages and published posts.';
    return;
  }

  const matches: SearchEntry[] = [];
  let count = 0;
  for (const entry of entries) {
    if (!terms.every((term) => entry.text.includes(term))) continue;
    count += 1;
    if (matches.length < 10) matches.push(entry);
  }
  status.textContent = count === 0
    ? 'No matching pages or posts.'
    : count > 10 ? `Showing the first 10 of ${count} results. Refine your search to narrow them down.`
      : `${count} ${count === 1 ? 'result' : 'results'}.`;
  const fragment = document.createDocumentFragment();
  for (const entry of matches) {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = entry.url;
    const title = document.createElement('span');
    title.textContent = entry.title;
    const kind = document.createElement('small');
    kind.textContent = entry.kind === 'post' ? 'Post' : 'Page';
    link.append(title, kind);
    item.append(link);
    fragment.append(item);
  }
  results.append(fragment);
  results.hidden = count === 0;
}

function renderWindows(): void {
  if (!menu) return;
  const { windows, windowCount, emptyWindows, restoreAll, input } = menu;
  const focusedId = document.activeElement instanceof HTMLButtonElement && windows.contains(document.activeElement)
    ? document.activeElement.dataset.restoreWindow : undefined;
  let nextFocus: HTMLButtonElement | undefined;
  let count = 0;
  const fragment = document.createDocumentFragment();
  for (const root of document.querySelectorAll<HTMLElement>('[data-desktop-window]')) {
    const { windowId: id, windowTitle: title, windowState: state } = root.dataset;
    if (!id || (state !== 'minimized' && state !== 'closed')) continue;
    count += 1;
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.restoreWindow = id;
    button.setAttribute('aria-label', `Restore ${title || 'window'}`);
    const label = document.createElement('span');
    const name = document.createElement('span');
    name.textContent = title || 'Window';
    const windowState = document.createElement('small');
    windowState.textContent = state === 'minimized' ? 'Minimized' : 'Closed';
    label.append(name, windowState);
    const action = document.createElement('span');
    action.textContent = 'Restore';
    button.append(label, action);
    item.append(button);
    fragment.append(item);
    if (id === focusedId) nextFocus = button;
  }
  windows.replaceChildren(fragment);
  windowCount.textContent = String(count);
  windowCount.setAttribute('aria-label', `${count} hidden ${count === 1 ? 'window' : 'windows'}`);
  emptyWindows.hidden = count > 0;
  restoreAll.disabled = count === 0;
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
  renderWindows();
  menu.dialog.showModal();
  positionMenu();
  menu.input.focus({ preventScroll: true });
  loadIndex();
}

function showShortcuts(): void {
  if (!menu?.dialog.open) return;
  menu.shortcuts.open = true;
  const summary = menu.shortcuts.querySelector('summary');
  summary?.focus({ preventScroll: true });
  summary?.scrollIntoView({ block: 'nearest' });
}

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
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
    return;
  }
  if (!dialog.contains(event.target)) return;
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
  if (event.target === menu?.input) renderSearch();
}, listenerOptions);

document.addEventListener('submit', (event) => {
  if (!menu || event.target !== menu.form) return;
  event.preventDefault();
  menu.results.querySelector<HTMLAnchorElement>('a')?.focus();
}, listenerOptions);

document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || event.isComposing || event.repeat) return;
  const key = event.key.toLowerCase();
  const searchShortcut = key === 'k' && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
  if ((event.altKey || event.ctrlKey || event.metaKey) && !searchShortcut) {
    navigationPrefixExpires = 0;
    return;
  }
  if (event.key === 'ArrowDown' && menu?.dialog.open && event.target === menu.input) {
    const firstResult = menu.results.querySelector<HTMLAnchorElement>('a');
    if (firstResult) {
      event.preventDefault();
      firstResult.focus();
    }
    return;
  }
  if (event.target instanceof HTMLElement
    && (event.target.isContentEditable || event.target.closest('input, textarea, select, [role="textbox"]'))) {
    navigationPrefixExpires = 0;
    return;
  }

  const openDialog = document.querySelector<HTMLDialogElement>('dialog[open]');
  if (searchShortcut || key === '/' || key === '?') {
    navigationPrefixExpires = 0;
    if (openDialog && openDialog !== menu?.dialog) return;
    const trigger = document.querySelector<HTMLElement>('[data-open-start]');
    if (!trigger) return;
    event.preventDefault();
    openMenu(trigger);
    if (key === '?') showShortcuts();
    else menu?.input.focus({ preventScroll: true });
    return;
  }
  if (openDialog) {
    navigationPrefixExpires = 0;
    return;
  }

  const now = performance.now();
  if (navigationPrefixExpires > now) {
    navigationPrefixExpires = 0;
    const destination = Object.hasOwn(navigationShortcuts, key) ? navigationShortcuts[key] : undefined;
    if (destination) {
      event.preventDefault();
      void navigate(destination);
      return;
    }
  }
  if (key === 'g') {
    navigationPrefixExpires = now + 1000;
    event.preventDefault();
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
  navigationPrefixExpires = 0;
  const previous = menu;
  menu = null;
  dockObserver.disconnect();
  if (previous?.dialog.open) previous.dialog.close();
}, listenerOptions);
window.addEventListener('resize', positionMenu, listenerOptions);
window.addEventListener('blur', () => { navigationPrefixExpires = 0; }, listenerOptions);
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
