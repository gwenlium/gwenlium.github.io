import { cancelWindowAnimation } from './window-motion';

const phone = matchMedia('(max-width: 760px)');
const stateKey = 'gwenlium:mobile-window';
const lifetime = new AbortController();
const options = { signal: lifetime.signal };
type Position = { top: number; left: number };
type ViewPosition = { page: Position; body: Position };
type MobileHistory = { path: string; id: string; depth: number };
type Original = { hidden: boolean; inert: boolean; role: string | null; labelledBy: string | null };
const originals = new Map<HTMLElement, Original>();
const visits = new Map<string, Map<string, ViewPosition>>();
let pageBody: HTMLElement | undefined;
let renderedPath = '';
let activeId = '';
let routeIndex: unknown;
let synchronizing = false;
let queued = false;
let restoreFrame = 0;
let printing = false;
let swapping = false;
let navigationSignal: AbortSignal | undefined;
const mediaObserver = new MutationObserver(queueSynchronization);

function path(): string { return location.pathname + location.search; }
function mobile(): boolean { return phone.matches && !printing; }
function rootFor(id: string): HTMLElement | null {
  const root = document.getElementById(id);
  return root?.matches('[data-desktop-window]') ? root : null;
}

/** Hidden media slots and disabled templates are not mobile destinations. */
export function availableMobileWindow(root: HTMLElement): boolean {
  if (!root.isConnected || !root.id || root.parentElement?.closest('[data-desktop-window]')) return false;
  for (let parent = root.parentElement; parent; parent = parent.parentElement) {
    if (parent.hidden || parent.hasAttribute('data-entry-media-none') || parent.tagName === 'TEMPLATE') return false;
  }
  return !root.hasAttribute('data-entry-media-none');
}

function primaryWindow(): HTMLElement | undefined {
  const choices = [...document.querySelectorAll<HTMLElement>('#main-content [data-desktop-window]')].filter(availableMobileWindow);
  return choices.find(root => root.id === 'post-entry')
    ?? choices.find(root => root.id === 'devlog-entries' || root.id === 'life-entries')
    ?? choices.find(root => root.dataset.windowInitialState !== 'closed')
    ?? choices[0];
}

function readHistory(): MobileHistory | undefined {
  const value = history.state?.[stateKey];
  return value && value.path === path() && typeof value.id === 'string'
    && Number.isSafeInteger(value.depth) && value.depth >= 0 ? value : undefined;
}

function writeHistory(id: string, push: boolean): void {
  const previous = readHistory();
  const value: MobileHistory = { path: path(), id, depth: push ? (previous?.depth ?? 0) + 1 : previous?.depth ?? 0 };
  const state = { ...(history.state ?? {}), [stateKey]: value };
  // Preserve Astro's history fields and the shell's independent scroll record.
  if (push) history.pushState(state, '', location.href);
  else history.replaceState(state, '', location.href);
  routeIndex = history.state?.index;
}

function positions(): Map<string, ViewPosition> {
  let result = visits.get(renderedPath);
  if (!result) visits.set(renderedPath, result = new Map());
  return result;
}

function bodyFor(root: HTMLElement): HTMLElement {
  return root.querySelector<HTMLElement>(':scope > .window-body, :scope > .player-body') ?? root;
}

function rememberPosition(): void {
  const root = rootFor(activeId);
  const page = document.getElementById('page-scroll');
  if (!root || !page || !renderedPath) return;
  const body = bodyFor(root);
  positions().set(activeId, { page: { top: page.scrollTop, left: page.scrollLeft }, body: { top: body.scrollTop, left: body.scrollLeft } });
}

function restorePosition(root: HTMLElement, focus: boolean): void {
  const saved = positions().get(root.id);
  const apply = () => {
    if (!mobile() || !root.isConnected || activeId !== root.id) return;
    if (root.closest('#main-content')) document.getElementById('page-scroll')?.scrollTo({ ...(saved?.page ?? { top: 0, left: 0 }), behavior: 'instant' });
    bodyFor(root).scrollTo({ ...(saved?.body ?? { top: 0, left: 0 }), behavior: 'instant' });
  };
  cancelAnimationFrame(restoreFrame);
  apply();
  if (focus) root.focus({ preventScroll: true });
  // Astro's same-URL traversal also restores #page-scroll; the selected pane owns
  // its final position after that restoration and the responsive layout settle.
  restoreFrame = requestAnimationFrame(() => { restoreFrame = 0; apply(); });
}

function canGoBack(): boolean {
  return Boolean(readHistory()?.depth || (typeof history.state?.index === 'number' && history.state.index > 0)
    || document.querySelector('.back-link[href]') || (activeId && primaryWindow()?.id !== activeId));
}

function updateControls(): void {
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('[data-mobile-entry-tabs] [data-mobile-window-target]')];
  let available = 0;
  for (const tab of tabs) {
    const root = rootFor(tab.dataset.mobileWindowTarget || '');
    const usable = Boolean(root && availableMobileWindow(root));
    tab.hidden = !usable;
    tab.disabled = !usable;
    tab.setAttribute('aria-selected', String(usable && root?.id === activeId));
    tab.tabIndex = usable && root?.id === activeId ? 0 : -1;
    if (usable) available++;
  }
  document.querySelectorAll<HTMLElement>('[data-mobile-entry-tabs]').forEach(tabs => { tabs.hidden = available < 2; });
  if (available > 1) for (const tab of tabs) {
    const root = rootFor(tab.dataset.mobileWindowTarget || '');
    if (root && !tab.hidden) {
      root.setAttribute('role', 'tabpanel');
      root.setAttribute('aria-labelledby', tab.id);
    }
  }
  document.querySelectorAll<HTMLButtonElement>('[data-mobile-back]').forEach(button => { button.disabled = !canGoBack(); });
  const settings = document.querySelector('[data-open-settings]');
  settings?.setAttribute('aria-expanded', String(activeId === 'site-settings'));
  document.querySelector('[data-open-player]')?.setAttribute('aria-expanded', String(activeId === 'music-player'));
}

function applySelection(): void {
  if (synchronizing || !mobile()) return;
  synchronizing = true;
  try {
    document.documentElement.setAttribute('data-mobile-window-mode', '');
    document.documentElement.dataset.mobileActiveWindow = activeId;
    const active = rootFor(activeId);
    document.documentElement.toggleAttribute('data-mobile-window-overlay', Boolean(active && !active.closest('#main-content')));
    for (const root of document.querySelectorAll<HTMLElement>('[data-desktop-window]')) {
      if (!originals.has(root)) originals.set(root, {
        hidden: root.hidden, inert: root.inert, role: root.getAttribute('role'), labelledBy: root.getAttribute('aria-labelledby'),
      });
      const selected = root.id === activeId && availableMobileWindow(root);
      if (root.hidden === selected) root.hidden = !selected;
      if (root.inert === selected) root.inert = !selected;
      root.toggleAttribute('data-mobile-window-active', selected);
    }
    updateControls();
    document.dispatchEvent(new CustomEvent('gwenlium:mobile-window-change', { detail: { id: activeId } }));
    document.dispatchEvent(new CustomEvent('gwenlium:windows-changed'));
  } finally { synchronizing = false; }
}

function selectWindow(id: string, push = true, focus = true): void {
  const root = rootFor(id);
  if (!mobile() || swapping || !root || !availableMobileWindow(root)) return;
  if (id === activeId) { if (focus) root.focus({ preventScroll: true }); return; }
  rememberPosition();
  for (const entry of originals.keys()) cancelWindowAnimation(entry);
  activeId = id;
  writeHistory(id, push);
  applySelection();
  restorePosition(root, focus);
}

function goBack(): void {
  if (readHistory()?.depth || (typeof history.state?.index === 'number' && history.state.index > 0)) {
    history.back();
    return;
  }
  const primary = primaryWindow();
  if (primary && primary.id !== activeId) { selectWindow(primary.id, false); return; }
  document.querySelector<HTMLAnchorElement>('.back-link[href]')?.click();
}

function release(): void {
  cancelAnimationFrame(restoreFrame);
  restoreFrame = 0;
  mediaObserver.disconnect();
  for (const [root, original] of originals) {
    if (!root.isConnected) continue;
    root.hidden = root.dataset.windowState ? ['closed', 'minimized'].includes(root.dataset.windowState) : original.hidden;
    root.inert = original.inert;
    root.removeAttribute('data-mobile-window-active');
    if (original.role === null) root.removeAttribute('role'); else root.setAttribute('role', original.role);
    if (original.labelledBy === null) root.removeAttribute('aria-labelledby'); else root.setAttribute('aria-labelledby', original.labelledBy);
  }
  originals.clear();
  for (const attribute of ['data-mobile-window-mode', 'data-mobile-active-window', 'data-mobile-window-overlay']) document.documentElement.removeAttribute(attribute);
}

function synchronize(): void {
  if (synchronizing || swapping) return;
  if (!mobile()) { if (originals.size) { rememberPosition(); release(); } return; }
  if (pageBody !== document.body || renderedPath !== path()) {
    release();
    pageBody = document.body;
    renderedPath = path();
    routeIndex = history.state?.index;
    activeId = '';
  }
  const previous = activeId;
  const historyView = readHistory();
  const requested = rootFor(historyView?.id || activeId);
  const selected = requested && availableMobileWindow(requested) ? requested : primaryWindow();
  activeId = selected?.id ?? '';
  if (activeId && (!historyView || historyView.id !== activeId)) writeHistory(activeId, false);
  for (const root of document.querySelectorAll<HTMLElement>('[data-desktop-window]')) if (!originals.has(root)) cancelWindowAnimation(root);
  applySelection();
  mediaObserver.disconnect();
  for (const slot of document.querySelectorAll('[data-preview-media], [data-entry-media]')) {
    mediaObserver.observe(slot, { attributes: true, attributeFilter: ['hidden', 'data-entry-media-none'] });
  }
  if (selected && previous !== activeId) restorePosition(selected, false);
}

function queueSynchronization(): void {
  if (queued || synchronizing || swapping) return;
  queued = true;
  queueMicrotask(() => { queued = false; synchronize(); });
}

// Capture before the existing page/player controllers. Their saved desktop
// states and audio element are left alone; only the mobile presentation changes.
document.addEventListener('gwenlium:window-command', event => {
  if (!mobile()) return;
  const detail = (event as CustomEvent<{ id?: string; action?: string }>).detail;
  if (!detail || (detail.action !== 'restore-all' && (!detail.id || !rootFor(detail.id)))) return;
  event.stopImmediatePropagation();
  if (detail.action === 'restore-all') { const primary = primaryWindow(); if (primary) selectWindow(primary.id); }
  else if (detail.action === 'restore' || detail.action === 'maximize') selectWindow(detail.id!);
  else if (detail.id === activeId && (detail.action === 'close' || detail.action === 'minimize')) goBack();
}, { ...options, capture: true });

document.addEventListener('click', event => {
  if (!mobile() || !(event.target instanceof Element)) return;
  const target = event.target.closest<HTMLElement>('[data-mobile-window-target]');
  if (target) { event.preventDefault(); selectWindow(target.dataset.mobileWindowTarget || '', true, false); }
  else if (event.target.closest('[data-mobile-back]')) { event.preventDefault(); goBack(); }
}, options);

document.addEventListener('keydown', event => {
  if (!mobile() || !(event.target instanceof HTMLElement) || !event.target.closest('[data-mobile-entry-tabs]')) return;
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('[data-mobile-entry-tabs] [role="tab"]')].filter(tab => !tab.hidden && !tab.disabled);
  const index = tabs.indexOf(event.target as HTMLButtonElement);
  if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next].focus({ preventScroll: true });
  selectWindow(tabs[next].dataset.mobileWindowTarget || '', true, false);
}, options);

window.addEventListener('keydown', event => {
  if (!mobile() || event.key !== 'Escape' || event.defaultPrevented || event.isComposing || !canGoBack()) return;
  if (document.fullscreenElement || document.querySelector('dialog[open], [popover]:popover-open:not([data-desktop-window]):not([aria-hidden="true"])')) return;
  event.preventDefault();
  goBack();
}, options);
window.addEventListener('popstate', event => {
  if (!mobile()) return;
  if (renderedPath !== path()) { rememberPosition(); swapping = true; return; }
  if (swapping) return;
  const destination = readHistory();
  if (!destination || history.state?.index !== routeIndex) return;
  // A view switch is not an Astro page navigation: retain the article DOM,
  // dialogue state, media selection and playing audio when traversing views.
  event.stopImmediatePropagation();
  rememberPosition();
  document.dispatchEvent(new CustomEvent('gwenlium:mobile-history-traverse', { detail: event.state }));
  activeId = '';
  synchronize();
}, { ...options, capture: true });
phone.addEventListener('change', () => {
  if (!phone.matches) { rememberPosition(); release(); }
  else synchronize();
  document.dispatchEvent(new CustomEvent('gwenlium:windows-changed'));
}, options);
document.addEventListener('gwenlium:windows-changed', queueSynchronization, options);
document.addEventListener('gwenlium:entry-content-replaced', queueSynchronization, options);
document.addEventListener('astro:before-preparation', event => {
  const navigation = event as Event & { to: URL; signal: AbortSignal };
  if (!mobile() || navigation.to.pathname + navigation.to.search === renderedPath) return;
  rememberPosition();
  swapping = true;
  navigationSignal = navigation.signal;
  navigation.signal.addEventListener('abort', () => {
    if (navigationSignal !== navigation.signal) return;
    navigationSignal = undefined;
    swapping = false;
    queueSynchronization();
  }, { once: true });
}, options);
document.addEventListener('astro:before-swap', () => { rememberPosition(); swapping = true; release(); pageBody = undefined; activeId = ''; }, options);
document.addEventListener('astro:after-swap', () => { swapping = false; navigationSignal = undefined; synchronize(); }, options);
document.addEventListener('astro:page-load', synchronize, options);
window.addEventListener('pagehide', rememberPosition, options);
window.addEventListener('pageshow', () => { swapping = false; synchronize(); }, options);
window.addEventListener('beforeprint', () => { rememberPosition(); printing = true; release(); }, options);
window.addEventListener('afterprint', () => { printing = false; synchronize(); }, options);

if (import.meta.hot) import.meta.hot.dispose(() => { lifetime.abort(); release(); });
