import 'astro:transitions/client';

type Position = { left: number; top: number };
type ScrollEntry = Position & { id: string };
type ScrollRequest = { position?: Position; hash: string; focus: boolean; traversal: boolean };
type NavigationEvent = Event & { navigationType: 'push' | 'replace' | 'traverse'; to: URL; signal: AbortSignal };

const stateKey = 'gwenlium:viewport';
const nativePushState = history.pushState;
const nativeReplaceState = history.replaceState;
const lifetime = new AbortController();
const listenerOptions = { signal: lifetime.signal };
const positions = new Map<string, Position>();
const initialEntry = readEntry(history.state);
let currentEntry = initialEntry ?? createEntry({ left: 0, top: 0 });
let entryHref = location.href;
let viewport: HTMLElement | null = null;
let footer: HTMLElement | null = null;
let taskbar: HTMLElement | null = null;
let pageController: AbortController | undefined;
let renderedPathname = location.pathname;
let suppressScroll = true;
let navigation: NavigationEvent | null = null;
let waitingForPage = false;
let pendingScroll: ScrollRequest | null = {
  position: initialEntry,
  hash: location.hash,
  focus: Boolean(location.hash),
  traversal: Boolean(initialEntry),
};
let persistenceTimer = 0;
let geometryFrame = 0;
let restoreFrame = 0;
const geometryObserver = new ResizeObserver(queueGeometry);
const dialogObserver = new MutationObserver(syncControls);

function stateRecord(state: unknown): Record<string, unknown> {
  return state !== null && typeof state === 'object' ? state as Record<string, unknown> : {};
}

function readEntry(state: unknown): ScrollEntry | undefined {
  const value = stateRecord(state)[stateKey];
  if (!value || typeof value !== 'object') return;
  const entry = value as Partial<ScrollEntry>;
  if (typeof entry.id === 'string' && typeof entry.left === 'number' && Number.isFinite(entry.left)
    && typeof entry.top === 'number' && Number.isFinite(entry.top)) return entry as ScrollEntry;
}

function createEntry(position: Position): ScrollEntry {
  return { id: crypto.randomUUID(), ...position };
}

function viewportPosition(): Position {
  return { left: viewport?.scrollLeft ?? 0, top: viewport?.scrollTop ?? 0 };
}

function rememberScroll(): void {
  if (!suppressScroll && viewport?.isConnected) positions.set(currentEntry.id, viewportPosition());
}

function persistScroll(): void {
  clearTimeout(persistenceTimer);
  persistenceTimer = 0;
  rememberScroll();
  const stored = readEntry(history.state);
  // A popstate changes history.state before its listeners run. Never save the departing viewport there.
  if (suppressScroll || stored?.id !== currentEntry.id) return;
  const position = positions.get(currentEntry.id) ?? currentEntry;
  if (stored.left === position.left && stored.top === position.top) return;
  nativeReplaceState.call(history, { ...stateRecord(history.state), [stateKey]: { id: currentEntry.id, ...position } }, '');
}

// Query filters use the native History API. Give each push its own viewport record even when
// callers copy history.state, while leaving Astro's index/scrollX/scrollY and other fields intact.
function pushState(data: unknown, unused: string, url?: string | URL | null): void {
  persistScroll();
  const entry = createEntry(suppressScroll ? { left: 0, top: 0 } : viewportPosition());
  nativePushState.call(history, { ...stateRecord(data), [stateKey]: entry }, unused, url);
  currentEntry = entry;
  entryHref = location.href;
  positions.set(entry.id, entry);
}

function replaceState(data: unknown, unused: string, url?: string | URL | null): void {
  const entry = readEntry(history.state) ?? currentEntry;
  if (entry.id === currentEntry.id) rememberScroll();
  const position = positions.get(entry.id) ?? entry;
  nativeReplaceState.call(history, { ...stateRecord(data), [stateKey]: { id: entry.id, ...position } }, unused, url);
  entryHref = location.href;
}

function adoptTraversal(state: unknown): void {
  clearTimeout(persistenceTimer);
  persistenceTimer = 0;
  const next = readEntry(state) ?? createEntry({ left: 0, top: 0 });
  if (next.id !== currentEntry.id) rememberScroll();
  currentEntry = next;
  entryHref = location.href;
  suppressScroll = true;
  pendingScroll = {
    position: positions.get(next.id) ?? readEntry(state),
    hash: location.hash,
    focus: false,
    traversal: true,
  };
}

function notifyScroll(): void {
  document.dispatchEvent(new CustomEvent('gwenlium:viewport-scroll'));
}

function onViewportScroll(): void {
  notifyScroll();
  if (suppressScroll) return;
  rememberScroll();
  clearTimeout(persistenceTimer);
  persistenceTimer = window.setTimeout(persistScroll, 400);
}

function setGeometry(name: string, value: number): boolean {
  const style = document.documentElement.style;
  const next = `${Math.round(value * 100) / 100}px`;
  if (style.getPropertyValue(name) === next) return false;
  style.setProperty(name, next);
  return true;
}

function measureGeometry(): void {
  geometryFrame = 0;
  if (!viewport?.isConnected || !footer || !taskbar) return;
  const workspaceBounds = viewport.getBoundingClientRect();
  const footerBounds = footer.getBoundingClientRect();
  const taskbarBounds = taskbar.getBoundingClientRect();
  // These outputs size floating windows, never the measured grid rows themselves.
  let changed = setGeometry('--workspace-top', workspaceBounds.top);
  changed = setGeometry('--workspace-bottom', window.innerHeight - workspaceBounds.bottom) || changed;
  changed = setGeometry('--taskbar-height', taskbarBounds.height) || changed;
  changed = setGeometry('--footer-height', footerBounds.height) || changed;
  changed = setGeometry('--chrome-bottom', window.innerHeight - footerBounds.top) || changed;
  if (changed) document.dispatchEvent(new CustomEvent('gwenlium:chrome-change'));
}

function queueGeometry(): void {
  if (!geometryFrame) geometryFrame = requestAnimationFrame(measureGeometry);
}

function syncControls(): void {
  const player = document.querySelector<HTMLElement>('gwenlium-player');
  const music = document.getElementById('music-player');
  const musicControl = document.querySelector<HTMLElement>('[data-open-player]');
  if (musicControl) {
    musicControl.setAttribute('aria-expanded', String(player?.dataset.playerState === 'open' && Boolean(music && !music.hidden)));
    musicControl.dataset.windowState = music?.dataset.windowState || 'normal';
  }
  document.querySelector('[data-open-start]')?.setAttribute('aria-expanded', String(Boolean(document.querySelector<HTMLDialogElement>('#start-menu')?.open)));
  const settings = document.getElementById('site-settings');
  document.querySelector('[data-open-settings]')?.setAttribute('aria-expanded', String(Boolean(settings && !settings.hidden)));
}

function detachPage(): void {
  pageController?.abort();
  geometryObserver.disconnect();
  dialogObserver.disconnect();
  cancelAnimationFrame(geometryFrame);
  geometryFrame = 0;
  viewport = footer = taskbar = null;
}

function bindPage(): void {
  const next = document.getElementById('page-scroll');
  if (viewport === next && pageController && !pageController.signal.aborted) return;
  detachPage();
  viewport = next;
  footer = document.querySelector<HTMLElement>('.site-footer');
  taskbar = document.querySelector<HTMLElement>('.taskbar');
  renderedPathname = location.pathname;
  pageController = new AbortController();
  viewport?.addEventListener('scroll', onViewportScroll, { passive: true, signal: pageController.signal });
  for (const element of document.querySelectorAll<HTMLElement>('.site-shell, .site-header, #page-scroll, .player-region, .site-footer, .taskbar')) geometryObserver.observe(element);
  dialogObserver.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });
  measureGeometry();
  syncControls();
}

function applyScroll(request: ScrollRequest): void {
  if (!viewport) return;
  if (request.position) {
    viewport.scrollTo({ ...request.position, behavior: 'auto' });
  } else {
    let fragment = request.hash.slice(1);
    try { fragment = decodeURIComponent(fragment); } catch { /* Keep a literal malformed fragment navigable. */ }
    const target = fragment ? document.getElementById(fragment) ?? document.getElementsByName(fragment)[0] : null;
    const desktopWindow = target?.closest<HTMLElement>('[data-desktop-window]');
    if (desktopWindow?.hidden && desktopWindow.dataset.windowId) {
      document.dispatchEvent(new CustomEvent('gwenlium:window-command', { detail: { id: desktopWindow.dataset.windowId, action: 'restore' } }));
    }
    if (target && (viewport.contains(target) || desktopWindow)) {
      target.scrollIntoView({ block: 'start', behavior: 'auto' });
      if (request.focus && target instanceof HTMLElement) {
        const temporaryTabindex = !target.hasAttribute('tabindex') && target.tabIndex < 0;
        if (temporaryTabindex) target.setAttribute('tabindex', '-1');
        target.focus({ preventScroll: true });
        if (temporaryTabindex) target.addEventListener('blur', () => target.removeAttribute('tabindex'), { once: true, signal: pageController?.signal });
      }
    } else {
      viewport.scrollTo({ left: 0, top: 0, behavior: 'auto' });
    }
  }
  notifyScroll();
}

function finishRestoration(): void {
  cancelAnimationFrame(restoreFrame);
  const request = pendingScroll;
  if (!request) return;
  suppressScroll = true;
  restoreFrame = requestAnimationFrame(() => {
    if (pendingScroll !== request) return;
    measureGeometry();
    applyScroll(request);
    // Filter page-load handlers have now run. Keep their resulting layout and the programmatic
    // scroll event out of history until the next frame, instead of overwriting a Back target.
    restoreFrame = requestAnimationFrame(() => {
      if (pendingScroll !== request) return;
      restoreFrame = 0;
      pendingScroll = null;
      navigation = null;
      waitingForPage = false;
      suppressScroll = false;
      if (!request.traversal) persistScroll();
    });
  });
}

function prepareFragment(): void {
  if (waitingForPage || pendingScroll?.traversal) return;
  if (entryHref !== location.href) {
    // Native fragment navigation creates an entry without going through pushState.
    currentEntry = createEntry(viewportPosition());
    entryHref = location.href;
    nativeReplaceState.call(history, { ...stateRecord(history.state), [stateKey]: currentEntry }, '');
  }
  pendingScroll = { hash: location.hash, focus: true, traversal: false };
  finishRestoration();
}

positions.set(currentEntry.id, currentEntry);
nativeReplaceState.call(history, { ...stateRecord(history.state), [stateKey]: currentEntry }, '');
history.pushState = pushState;
history.replaceState = replaceState;
history.scrollRestoration = 'manual';

document.addEventListener('astro:before-preparation', (event) => {
  cancelAnimationFrame(restoreFrame);
  const next = event as NavigationEvent;
  if (next.navigationType === 'traverse') adoptTraversal(history.state);
  else {
    persistScroll();
    pendingScroll = { hash: next.to.hash, focus: Boolean(next.to.hash), traversal: false };
  }
  navigation = next;
  waitingForPage = true;
  next.signal.addEventListener('abort', () => {
    if (navigation !== next) return;
    cancelAnimationFrame(restoreFrame);
    pendingScroll = null;
    navigation = null;
    waitingForPage = false;
    suppressScroll = false;
  }, { once: true });
}, listenerOptions);

document.addEventListener('astro:before-swap', (event) => {
  if ((event as NavigationEvent).navigationType !== 'traverse') persistScroll();
  suppressScroll = true;
  detachPage();
}, listenerOptions);

document.addEventListener('astro:after-swap', () => {
  bindPage();
  if (pendingScroll) applyScroll(pendingScroll);
}, listenerOptions);

document.addEventListener('astro:page-load', () => {
  bindPage();
  finishRestoration();
}, listenerOptions);

window.addEventListener('popstate', (event) => {
  adoptTraversal(event.state);
  const destination = location.href;
  // Let Astro cancel a pending fetch or start a new swap before choosing its hash-only path.
  queueMicrotask(() => {
    if (location.href !== destination || waitingForPage || renderedPathname !== location.pathname) return;
    if (!pendingScroll?.traversal) adoptTraversal(event.state);
    finishRestoration();
  });
}, { ...listenerOptions, capture: true });
window.addEventListener('hashchange', prepareFragment, listenerOptions);
window.addEventListener('pagehide', persistScroll, listenerOptions);
window.addEventListener('pageshow', queueGeometry, listenerOptions);
window.addEventListener('resize', queueGeometry, listenerOptions);
window.visualViewport?.addEventListener('resize', queueGeometry, listenerOptions);

document.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) return;
  if (event.target.closest('[data-restore-windows]')) {
    document.dispatchEvent(new CustomEvent('gwenlium:window-command', { detail: { action: 'restore-all' } }));
    return;
  }
  const link = event.target.closest<HTMLAnchorElement>('a[href]');
  if (!link || event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || link.download || (link.target && link.target !== '_self')) return;
  persistScroll();
  const destination = new URL(link.href, location.href);
  if (destination.origin !== location.origin || destination.pathname !== location.pathname || destination.search !== location.search || !link.href.includes('#')) return;
  // Astro's same-page anchor fast path updates history synchronously, without lifecycle events.
  queueMicrotask(() => { if (location.href === destination.href) prepareFragment(); });
}, { ...listenerOptions, capture: true });

document.addEventListener('keydown', (event) => {
  if (!(event.target instanceof HTMLElement) || !event.target.closest('.taskbar') || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
  const controls = Array.from(taskbar?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
  const current = controls.indexOf(event.target as HTMLButtonElement);
  if (current < 0) return;
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + controls.length) % controls.length;
  event.preventDefault();
  controls[next]?.focus();
}, listenerOptions);

document.addEventListener('gwenlium:player-state', () => { syncControls(); queueGeometry(); }, listenerOptions);
document.addEventListener('gwenlium:windows-changed', syncControls, listenerOptions);
document.addEventListener('close', syncControls, { ...listenerOptions, capture: true });

bindPage();
finishRestoration();

if (import.meta.hot) import.meta.hot.dispose(() => {
  persistScroll();
  lifetime.abort();
  detachPage();
  cancelAnimationFrame(restoreFrame);
  clearTimeout(persistenceTimer);
  if (history.pushState === pushState) history.pushState = nativePushState;
  if (history.replaceState === replaceState) history.replaceState = nativeReplaceState;
});

export {};
