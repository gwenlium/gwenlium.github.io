import { cancelWindowAnimation } from './window-motion';

type Box = { x: number; y: number; width: number; height: number };
type Snap = 'left' | 'right' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
type MovingElement = HTMLElement & { moveBefore?: (node: Node, reference: Node | null) => void };
type LayoutState = { rect?: Box; snap?: Snap; freeRect?: Box };
type VisitorLayout = LayoutState & {
  defaultFloating: boolean;
  initialized: boolean;
  maximized: boolean;
  x?: string;
  y?: string;
  width: string;
  height: string;
  sized: boolean;
};
type EditorLayout = { id: string; x?: number; y?: number; width: number; height: number; floating: boolean };
type Layout = {
  root: HTMLElement;
  host: HTMLElement;
  titlebar: HTMLElement;
  initialized: boolean;
  mobile?: boolean;
  defaultFloating: boolean;
  rect?: Box;
  snap?: Snap;
  freeRect?: Box;
  maximized: boolean;
  beforeMaximum?: { rect?: Box; snap?: Snap; freeRect?: Box };
  placement?: { parent: MovingElement; marker: HTMLElement; portaled: boolean };
  visitor?: VisitorLayout;
  pendingEditorLayout?: EditorLayout;
  pendingMaximized?: boolean;
};
type Gesture = {
  entry: Layout;
  pointer: number;
  capture: HTMLElement;
  edge: string;
  startX: number;
  startY: number;
  x: number;
  y: number;
  alt: boolean;
  started: boolean;
  box: Box;
  bounds: Box;
  original: { rect?: Box; snap?: Snap; freeRect?: Box; maximized: boolean };
  peers: Box[];
  snap?: Snap | 'maximize';
};

const layouts = new Map<HTMLElement, Layout>();
const interactive = 'button, a, input, select, textarea, [contenteditable="true"]';
const storagePrefix = 'gwenlium:window-layout:';
const phone = matchMedia('(max-width: 760px)');
let gesture: Gesture | undefined;
let moveFrame = 0;
let resizeFrame = 0;
let preview: HTMLElement | undefined;
let nextTransitionId = 0;
let suspended = false;
let raising = false;

function editing(): boolean { return document.documentElement.dataset.siteEditing === 'true'; }

function captureVisitorLayout(entry: Layout): void {
  if (entry.visitor) return;
  const normal = entry.maximized ? entry.beforeMaximum : entry;
  entry.visitor = {
    rect: normal?.rect, snap: normal?.snap, freeRect: normal?.freeRect,
    initialized: entry.initialized, defaultFloating: entry.defaultFloating, width: entry.root.style.width,
    maximized: entry.maximized, x: entry.root.dataset.windowDefaultX, y: entry.root.dataset.windowDefaultY,
    height: entry.root.style.height, sized: entry.root.hasAttribute('data-window-sized'),
  };
}

function synchronizeEditing(): void {
  if (suspended) return;
  finishGesture(true);
  for (const entry of layouts.values()) {
    if (editing()) captureVisitorLayout(entry);
    else if (phone.matches) entry.pendingEditorLayout = undefined;
    else if (entry.visitor) {
      if (entry.maximized) command(entry, 'restore');
      const visitor = entry.visitor;
      entry.rect = visitor.rect;
      entry.snap = visitor.snap;
      entry.freeRect = visitor.freeRect;
      entry.initialized = visitor.initialized;
      entry.defaultFloating = visitor.defaultFloating;
      entry.root.style.width = visitor.width;
      entry.root.style.height = visitor.height;
      entry.root.toggleAttribute('data-window-sized', visitor.sized);
      entry.root.toggleAttribute('data-window-default-floating', visitor.defaultFloating);
      if (visitor.x === undefined) delete entry.root.dataset.windowDefaultX;
      else entry.root.dataset.windowDefaultX = visitor.x;
      if (visitor.y === undefined) delete entry.root.dataset.windowDefaultY;
      else entry.root.dataset.windowDefaultY = visitor.y;
      entry.visitor = undefined;
      entry.pendingEditorLayout = undefined;
      entry.pendingMaximized = undefined;
      if (visitor.maximized) command(entry, 'maximize');
      else apply(entry);
    }
  }
}

document.addEventListener('gwenlium:editor-mode-changed', synchronizeEditing);
function workspace(): Box {
  const view = document.getElementById('page-scroll');
  const rect = view?.getBoundingClientRect();
  if (!view || !rect || rect.height < 1) return { x: 10, y: 64, width: Math.max(1, innerWidth - 20), height: Math.max(1, innerHeight - 200) };
  return { x: rect.left + 8, y: rect.top + 8, width: Math.max(1, view.clientWidth - 16), height: Math.max(1, rect.height - 16) };
}

function bounded(rect: Box, bounds: Box): Box {
  const width = Math.min(bounds.width, Math.max(Math.min(240, bounds.width), rect.width));
  const height = Math.min(bounds.height, Math.max(Math.min(140, bounds.height), rect.height));
  return {
    x: Math.max(bounds.x, Math.min(bounds.x + bounds.width - width, rect.x)),
    y: Math.max(bounds.y, Math.min(bounds.y + bounds.height - height, rect.y)), width, height,
  };
}

function readBox(value: unknown): Box | undefined {
  if (!value || typeof value !== 'object') return;
  const box = value as Partial<Box>;
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    if (typeof box[key] !== 'number' || !Number.isFinite(box[key])) return;
  }
  if (box.width! <= 0 || box.height! <= 0) return;
  return { x: box.x!, y: box.y!, width: box.width!, height: box.height! };
}

function restoreLayout(entry: Layout): boolean {
  const id = entry.root.dataset.windowId;
  if (!id) return false;
  try {
    const saved = JSON.parse(localStorage.getItem(storagePrefix + id) || 'null');
    const rect = readBox(saved?.rect);
    if (!rect) return false;
    entry.rect = rect;
    entry.freeRect = readBox(saved.freeRect);
    if (typeof saved.snap === 'string' && /^(?:left|right|(?:top|bottom)-(?:left|right))$/.test(saved.snap)) {
      entry.snap = saved.snap as Snap;
    }
    return true;
  } catch { return false; }
}

function rememberLayout(entry: Layout): void {
  if (phone.matches || suspended) return;
  const id = entry.root.dataset.windowId;
  if (!id) return;
  if (editing()) {
    const normal = entry.maximized ? entry.beforeMaximum : entry;
    const bounds = workspace();
    const rect = normal?.rect ?? entry.root.getBoundingClientRect();
    document.dispatchEvent(new CustomEvent('gwenlium:editor-window-layout', {
      detail: { id, x: rect.x - bounds.x, y: rect.y - bounds.y, width: Math.round(rect.width), height: Math.round(rect.height), floating: Boolean(normal?.rect) },
    }));
    return;
  }
  // Maximizing is temporary; retain the normal position rather than the full screen.
  const layout = entry.maximized ? entry.beforeMaximum : entry;
  try {
    if (layout?.rect) localStorage.setItem(storagePrefix + id, JSON.stringify({ rect: layout.rect, snap: layout.snap, freeRect: layout.freeRect }));
    else localStorage.removeItem(storagePrefix + id);
  } catch { /* Moving and arranging still work when browser storage is unavailable. */ }
}

function arrangeWindows(): void {
  if (phone.matches || suspended) return;
  finishGesture(true);
  const open = [...layouts.values()].filter(entry => entry.root.isConnected && !entry.root.hidden && !entry.root.inert
    && entry.root.getClientRects().length && getComputedStyle(entry.root).visibility !== 'hidden');
  // Let the authored responsive layout size and place the open windows. Dividing
  // the workspace into equal tiles inflated small windows and ignored their content.
  for (const entry of open) {
    if (entry.maximized) command(entry, 'restore');
    resetWindowLayout(entry.root);
  }
  document.getElementById('page-scroll')?.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  document.dispatchEvent(new CustomEvent('gwenlium:windows-changed'));
}

document.addEventListener('click', event => {
  if (event.target instanceof Element && event.target.closest('[data-auto-arrange-windows]')) arrangeWindows();
});

function snapBox(snap: Snap | 'maximize', bounds: Box): Box {
  if (snap === 'maximize') return { ...bounds };
  const width = (bounds.width - 6) / 2;
  const quarter = snap.includes('-');
  const height = quarter ? (bounds.height - 6) / 2 : bounds.height;
  return {
    x: snap.endsWith('right') ? bounds.x + bounds.width - width : bounds.x,
    y: snap.startsWith('bottom') ? bounds.y + bounds.height - height : bounds.y,
    width, height,
  };
}

function detach(entry: Layout): void {
  const placement = entry.placement;
  // Clear first: custom element move callbacks may synchronously register again.
  entry.placement = undefined;
  if (placement?.portaled && placement.marker.isConnected && entry.host.isConnected) {
    if (typeof placement.parent.moveBefore === 'function') placement.parent.moveBefore(entry.host, placement.marker);
    else placement.parent.insertBefore(entry.host, placement.marker);
  }
  if (entry.root.hasAttribute('popover')) {
    if (entry.root.matches(':popover-open')) entry.root.hidePopover();
    entry.root.removeAttribute('popover');
  }
  placement?.marker.remove();
}

function place(entry: Layout): void {
  if (phone.matches || suspended || !entry.root.isConnected) return;
  if (!entry.placement && entry.host.parentElement !== document.body) {
    const parent = entry.host.parentElement as MovingElement;
    const marker = document.createElement('div');
    const style = getComputedStyle(entry.host);
    marker.dataset.windowPlaceholder = entry.root.dataset.windowId || '';
    marker.setAttribute('aria-hidden', 'true');
    marker.style.height = `${entry.host.getBoundingClientRect().height}px`;
    marker.style.margin = style.margin;
    marker.style.gridArea = style.gridArea;
    marker.style.minWidth = '0';
    parent.insertBefore(marker, entry.host);
    const destination = document.body as MovingElement;
    // The top layer pins coordinates without changing DOM ownership: catalogue
    // filters, responsive selectors and playing media keep their original parent.
    const topLayer = typeof entry.root.showPopover === 'function';
    entry.placement = { parent, marker, portaled: !topLayer };
    if (topLayer) entry.root.setAttribute('popover', 'manual');
    else if (typeof destination.moveBefore === 'function') destination.moveBefore(entry.host, null);
    else destination.append(entry.host);
  }
  if (entry.placement) entry.placement.marker.hidden = entry.root.hidden;
  // Direct children of body (including Preferences) need the same top layer.
  if (typeof entry.root.showPopover === 'function' && !entry.root.hasAttribute('popover')) entry.root.setAttribute('popover', 'manual');
  if (entry.root.hasAttribute('popover')) {
    if (entry.root.hidden && entry.root.matches(':popover-open')) entry.root.hidePopover();
    else if (!entry.root.hidden && !entry.root.matches(':popover-open')) entry.root.showPopover();
  }
}

function clearFloating(entry: Layout): void {
  detach(entry);
  delete entry.root.dataset.windowFloating;
  delete entry.root.dataset.windowSnap;
  for (const key of ['x', 'y', 'width', 'height']) entry.root.style.removeProperty(`--window-${key}`);
}

function setInteractions(entry: Layout): void {
  const mobile = phone.matches;
  if (entry.mobile === mobile) return;
  entry.mobile = mobile;
  const titlebar = entry.titlebar;
  if (mobile) {
    delete titlebar.dataset.windowDrag;
    for (const attribute of ['tabindex', 'role', 'aria-label', 'title']) titlebar.removeAttribute(attribute);
  } else {
    titlebar.tabIndex = 0;
    titlebar.setAttribute('role', 'group');
    titlebar.setAttribute('aria-label', `${entry.root.dataset.windowTitle || 'Window'} position and size`);
    titlebar.title = 'Drag to move; double-click to maximize. Arrow keys move; Shift + arrows resize; Alt + arrows snap. Escape cancels dragging. Positions and sizes are saved on this device.';
    titlebar.dataset.windowDrag = '';
  }
  for (const handle of entry.root.querySelectorAll<HTMLElement>(':scope > [data-window-resize]')) {
    handle.hidden = mobile;
    if (mobile) handle.style.display = 'none';
    else handle.style.removeProperty('display');
  }
}

function initializeLayout(entry: Layout, bounds: Box): void {
  clearFloating(entry);
  const root = entry.root;
  const hidden = root.hidden;
  root.hidden = false;
  const rect = root.getBoundingClientRect();
  root.hidden = hidden;
  let x = rect.left;
  let y = rect.top;
  if (entry.defaultFloating) {
    const authoredX = root.dataset.windowDefaultX;
    const authoredY = root.dataset.windowDefaultY;
    if (authoredX !== undefined && Number.isFinite(Number(authoredX))) x = bounds.x + Number(authoredX);
    if (authoredY !== undefined && Number.isFinite(Number(authoredY))) y = bounds.y + Number(authoredY);
  }
  if (y < bounds.y || y > bounds.y + bounds.height - 140) {
    let slot = 0;
    for (const candidate of layouts.values()) { if (candidate === entry) break; slot++; }
    const offset = (slot % 7) * 24;
    x = bounds.x + offset;
    y = bounds.y + Math.min(80, bounds.height * .12) + offset;
  }
  entry.rect = bounded({ x, y, width: rect.width, height: Math.min(rect.height, Math.max(140, bounds.y + bounds.height - y)) }, bounds);
  // A player can restore its maximized state before its first desktop render.
  // Its normal rectangle must come from the desktop, never the phone viewport.
  if (entry.maximized) entry.beforeMaximum = { rect: entry.rect };
  entry.initialized = true;
}

function apply(entry: Layout, bounds?: Box): void {
  setInteractions(entry);
  if (phone.matches) {
    cancelWindowAnimation(entry.root);
    clearFloating(entry);
    return;
  }
  if (suspended || !entry.root.isConnected) return;
  bounds ??= workspace();
  if (!entry.initialized) initializeLayout(entry, bounds);
  if (!entry.rect && !entry.maximized) {
    clearFloating(entry);
    return;
  }
  const rect = entry.maximized ? bounds : bounded(entry.snap ? snapBox(entry.snap, bounds) : entry.rect!, bounds);
  if (!entry.maximized) entry.rect = rect;
  place(entry);
  const style = entry.root.style;
  entry.root.dataset.windowFloating = '';
  if (entry.snap && !entry.maximized) entry.root.dataset.windowSnap = entry.snap;
  else delete entry.root.dataset.windowSnap;
  style.setProperty('--window-x', `${rect.x}px`);
  style.setProperty('--window-y', `${rect.y}px`);
  style.setProperty('--window-width', `${rect.width}px`);
  style.setProperty('--window-height', `${rect.height}px`);
}


function raise(entry: Layout): void {
  if (phone.matches || suspended || raising) return;
  raising = true;
  try {
    // Small bounded z-indices also support browsers without popovers.
    layouts.delete(entry.root);
    layouts.set(entry.root, entry);
    let layer = 10;
    for (const window of layouts.values()) window.root.style.setProperty('--window-layer', String(layer++));
    if (entry.root.hasAttribute('popover') && entry.root.matches(':popover-open') && !document.querySelector('dialog[open]')) {
      const focused = document.activeElement instanceof HTMLElement && entry.root.contains(document.activeElement) ? document.activeElement : undefined;
      // Popover reordering can restore old focus. Do not raise that other window
      // recursively, and keep the user's current field or button focused.
      entry.root.hidePopover();
      entry.root.showPopover();
      focused?.focus({ preventScroll: true });
    }
  } finally { raising = false; }
}

export function registerWindow(root: HTMLElement, options: { floating?: boolean } = {}): void {
  const existing = layouts.get(root);
  if (existing) { apply(existing); return; }
  const titlebar = root.querySelector<HTMLElement>(':scope > .window-titlebar, :scope > .player-titlebar');
  if (!titlebar) return;
  // Top-layer windows need their own snapshots. Page windows never share one
  // across navigations, even when both routes contain the same window id.
  const persistent = root.hasAttribute('data-persistent-window');
  root.style.setProperty('view-transition-name', persistent
    ? CSS.escape(`persistent-window-${root.dataset.windowId || root.id}`)
    : `page-window-${++nextTransitionId}`);
  root.style.setProperty('view-transition-class', persistent ? 'persistent-window' : 'page-window');
  // Keep page content opted into typing after its window moves outside main.
  if (root.closest('#main-content')) root.querySelector(':scope > .window-body')?.setAttribute('data-typewriter', '');
  const entry: Layout = {
    root, host: root.closest<HTMLElement>('gwenlium-player') || root, titlebar,
    initialized: false, defaultFloating: Boolean(options.floating), maximized: false,
  };
  layouts.set(root, entry);
  for (const edge of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']) {
    const handle = document.createElement('span');
    handle.dataset.windowResize = edge;
    handle.setAttribute('aria-hidden', 'true');
    root.append(handle);
  }
  entry.initialized = restoreLayout(entry);
  apply(entry);
  if (editing()) captureVisitorLayout(entry);
  raise(entry);
}

export function setWindowMaximized(root: HTMLElement, maximized: boolean): void {
  const entry = layouts.get(root);
  if (!entry) return;
  if (entry.maximized !== maximized) {
    if (maximized) entry.beforeMaximum = { rect: entry.rect, snap: entry.snap, freeRect: entry.freeRect };
    else if (entry.beforeMaximum) {
      entry.rect = entry.beforeMaximum.rect;
      entry.snap = entry.beforeMaximum.snap;
      entry.freeRect = entry.beforeMaximum.freeRect;
      entry.beforeMaximum = undefined;
    }
    entry.maximized = maximized;
  }
  apply(entry);
}

export function resetWindowLayout(root: HTMLElement, remember = true): void {
  const entry = layouts.get(root);
  if (!entry || phone.matches || suspended) return;
  cancelWindowAnimation(root);
  entry.rect = entry.snap = entry.freeRect = entry.beforeMaximum = undefined;
  entry.maximized = false;
  entry.initialized = false;
  // Reset personal placement, then measure the authored desktop box.
  if (remember && !editing()) rememberLayout(entry);
  apply(entry);
  if (remember && editing()) rememberLayout(entry);
}

document.addEventListener('gwenlium:editor-apply-layout', (event) => {
  if (!editing()) return;
  const detail = (event as CustomEvent<EditorLayout | undefined>).detail;
  if (!detail || typeof detail.id !== 'string' || typeof detail.floating !== 'boolean'
    || !Number.isFinite(detail.width) || detail.width < 0 || !Number.isFinite(detail.height) || detail.height < 0
    || (detail.x !== undefined && !Number.isFinite(detail.x)) || (detail.y !== undefined && !Number.isFinite(detail.y))) return;
  const entry = [...layouts.values()].find(candidate => candidate.root.dataset.windowId === detail.id);
  if (!entry) return;
  if (phone.matches || suspended) {
    captureVisitorLayout(entry);
    entry.pendingEditorLayout = detail;
    return;
  }
  applyEditorLayout(entry, detail);
});

function applyEditorLayout(entry: Layout, detail: EditorLayout): void {
  finishGesture(true);
  captureVisitorLayout(entry);
  if (entry.maximized) command(entry, 'restore');
  cancelWindowAnimation(entry.root);
  entry.rect = entry.snap = entry.freeRect = entry.beforeMaximum = undefined;
  entry.defaultFloating = detail.floating;
  entry.root.toggleAttribute('data-window-default-floating', entry.defaultFloating);
  if (detail.x === undefined) delete entry.root.dataset.windowDefaultX;
  else entry.root.dataset.windowDefaultX = String(detail.x);
  if (detail.y === undefined) delete entry.root.dataset.windowDefaultY;
  else entry.root.dataset.windowDefaultY = String(detail.y);
  clearFloating(entry);
  entry.root.style.width = detail.width > 0 ? `min(${detail.width}px, 100%)` : '';
  entry.root.style.height = detail.height > 0 ? `${detail.height}px` : '';
  entry.root.toggleAttribute('data-window-sized', detail.height > 0);
  resetWindowLayout(entry.root, false);
}

export function unregisterWindow(root: HTMLElement): void {
  const entry = layouts.get(root);
  if (!entry) return;
  if (gesture?.entry === entry) finishGesture(true);
  detach(entry);
  layouts.delete(root);
  delete root.dataset.windowFloating;
  delete root.dataset.windowSnap;
  delete entry.titlebar.dataset.windowDrag;
  entry.titlebar.removeAttribute('tabindex');
  for (const handle of root.querySelectorAll(':scope > [data-window-resize]')) handle.remove();
  for (const key of ['x', 'y', 'width', 'height', 'layer']) root.style.removeProperty(`--window-${key}`);
  root.style.removeProperty('view-transition-name');
  root.style.removeProperty('view-transition-class');
}

function command(entry: Layout, action: 'maximize' | 'restore'): void {
  if (phone.matches || suspended) return;
  document.dispatchEvent(new CustomEvent('gwenlium:window-command', { detail: { id: entry.root.dataset.windowId, action } }));
  cancelWindowAnimation(entry.root);
}

function showPreview(snap: Snap | 'maximize' | undefined, bounds: Box): void {
  if (!snap) { if (preview) preview.hidden = true; return; }
  if (!preview?.isConnected) {
    preview = document.createElement('div');
    preview.className = 'window-snap-preview';
    preview.setAttribute('aria-hidden', 'true');
    document.body.append(preview);
  }
  const rect = snapBox(snap, bounds);
  preview.hidden = false;
  preview.style.left = `${rect.x}px`;
  preview.style.top = `${rect.y}px`;
  preview.style.width = `${rect.width}px`;
  preview.style.height = `${rect.height}px`;
}

function applySnap(entry: Layout, snap: Snap | 'maximize', bounds: Box): void {
  if (phone.matches || suspended) return;
  if (snap === 'maximize') { command(entry, 'maximize'); return; }
  if (entry.maximized) command(entry, 'restore');
  if (!entry.snap) entry.freeRect = entry.rect;
  entry.snap = snap;
  entry.rect = snapBox(snap, bounds);
  apply(entry, bounds);
}

function updateGesture(): void {
  moveFrame = 0;
  if (phone.matches || suspended) { finishGesture(true); return; }
  const current = gesture;
  if (!current) return;
  const { entry, bounds } = current;
  if (!current.started) {
    if (Math.hypot(current.x - current.startX, current.y - current.startY) < 4) return;
    current.started = true;
    const ratio = Math.max(0, Math.min(1, (current.startX - current.box.x) / current.box.width));
    if (entry.maximized) command(entry, 'restore');
    if (entry.snap && !current.edge && entry.freeRect) entry.rect = entry.freeRect;
    if (!current.edge && (current.original.maximized || current.original.snap)) {
      const restored = entry.rect || entry.root.getBoundingClientRect();
      current.box = bounded({ x: current.startX - restored.width * ratio, y: current.startY - 18, width: restored.width, height: restored.height }, bounds);
    }
    entry.snap = undefined;
    entry.freeRect = undefined;
    entry.rect = bounded(current.box, bounds);
    apply(entry, bounds);
    current.capture.setPointerCapture(current.pointer);
    entry.root.dataset.windowInteracting = '';
    document.documentElement.dataset.windowInteraction = current.edge ? 'resize' : 'move';
  }
  const dx = current.x - current.startX;
  const dy = current.y - current.startY;
  const box = { ...current.box };
  if (current.edge) {
    const minimumWidth = Math.min(240, bounds.width);
    const minimumHeight = Math.min(140, bounds.height);
    if (current.edge.includes('e')) box.width = Math.max(minimumWidth, Math.min(bounds.x + bounds.width - box.x, box.width + dx));
    if (current.edge.includes('s')) box.height = Math.max(minimumHeight, Math.min(bounds.y + bounds.height - box.y, box.height + dy));
    if (current.edge.includes('w')) {
      box.x = Math.max(bounds.x, Math.min(current.box.x + current.box.width - minimumWidth, current.box.x + dx));
      box.width = current.box.x + current.box.width - box.x;
    }
    if (current.edge.includes('n')) {
      box.y = Math.max(bounds.y, Math.min(current.box.y + current.box.height - minimumHeight, current.box.y + dy));
      box.height = current.box.y + current.box.height - box.y;
    }
  } else {
    box.x += dx;
    box.y += dy;
    if (!current.alt) {
      let distanceX = 10, distanceY = 10;
      for (const peer of current.peers) {
        if (box.y < peer.y + peer.height && box.y + box.height > peer.y) {
          for (const x of [peer.x, peer.x + peer.width - box.width, peer.x - box.width - 6, peer.x + peer.width + 6]) {
            const distance = Math.abs(box.x - x);
            if (distance < distanceX) { distanceX = distance; box.x = x; }
          }
        }
        if (box.x < peer.x + peer.width && box.x + box.width > peer.x) {
          for (const y of [peer.y, peer.y + peer.height - box.height, peer.y - box.height - 6, peer.y + peer.height + 6]) {
            const distance = Math.abs(box.y - y);
            if (distance < distanceY) { distanceY = distance; box.y = y; }
          }
        }
      }
    }
    const left = current.x <= bounds.x + 22;
    const right = current.x >= bounds.x + bounds.width - 22;
    const top = current.y <= bounds.y + 22;
    const bottom = current.y >= bounds.y + bounds.height - 22;
    current.snap = undefined;
    if (!current.alt) {
      if (bounds.width >= 486 && (left || right)) {
        const side = left ? 'left' : 'right';
        current.snap = top && bounds.height >= 286 ? `top-${side}` : bottom && bounds.height >= 286 ? `bottom-${side}` : side;
      } else if (top) current.snap = 'maximize';
    }
    showPreview(current.snap, bounds);
  }
  entry.rect = bounded(box, bounds);
  apply(entry, bounds);
}

function finishGesture(cancelled: boolean): void {
  const current = gesture;
  if (!current) return;
  cancelled ||= phone.matches || suspended;
  cancelAnimationFrame(moveFrame);
  moveFrame = 0;
  if (!cancelled) updateGesture();
  gesture = undefined;
  delete document.documentElement.dataset.windowInteraction;
  delete current.entry.root.dataset.windowInteracting;
  if (current.capture.hasPointerCapture(current.pointer)) current.capture.releasePointerCapture(current.pointer);
  showPreview(undefined, current.bounds);
  if (!current.started) return;
  if (cancelled) {
    const original = current.original;
    if (phone.matches || suspended) {
      if (current.entry.maximized !== original.maximized) current.entry.pendingMaximized = original.maximized;
      current.entry.maximized = original.maximized;
      current.entry.beforeMaximum = original.maximized ? { rect: original.rect, snap: original.snap, freeRect: original.freeRect } : undefined;
      current.entry.rect = original.rect;
      current.entry.snap = original.snap;
      current.entry.freeRect = original.freeRect;
      apply(current.entry);
    } else {
      if (current.entry.maximized) command(current.entry, 'restore');
      current.entry.rect = original.rect;
      current.entry.snap = original.snap;
      current.entry.freeRect = original.freeRect;
      if (original.maximized) command(current.entry, 'maximize');
      else apply(current.entry);
    }
  } else if (current.snap) applySnap(current.entry, current.snap, current.bounds);
  if (!cancelled) rememberLayout(current.entry);
}

document.addEventListener('pointerdown', (event) => {
  if (phone.matches || suspended) return;
  if (event.button !== 0 || !event.isPrimary || !(event.target instanceof Element) || gesture) return;
  const root = event.target.closest<HTMLElement>('[data-desktop-window]');
  const entry = root && layouts.get(root);
  if (!entry || root!.hidden || root!.inert) return;
  raise(entry);
  const handle = event.target.closest<HTMLElement>('[data-window-resize]');
  const titlebar = event.target.closest<HTMLElement>('[data-window-drag]');
  if ((!handle && !titlebar) || event.target.closest(interactive) || (handle && entry.maximized)) return;
  event.preventDefault();
  cancelWindowAnimation(entry.root);
  entry.titlebar.focus({ preventScroll: true });
  const rect = entry.root.getBoundingClientRect();
  gesture = {
    entry, pointer: event.pointerId, capture: handle || entry.titlebar, edge: handle?.dataset.windowResize || '',
    startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY,
    alt: event.altKey, started: false,
    box: { x: rect.left, y: rect.top, width: rect.width, height: rect.height }, bounds: workspace(),
    original: { rect: entry.rect, snap: entry.snap, freeRect: entry.freeRect, maximized: entry.maximized },
    peers: [...layouts.values()].filter(peer => peer !== entry && peer.rect && !peer.root.hidden).map(peer => {
      const bounds = peer.root.getBoundingClientRect();
      return { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height };
    }),
  };
  gesture.capture.setPointerCapture(event.pointerId);
});
window.addEventListener('pointermove', (event) => {
  if (!gesture || event.pointerId !== gesture.pointer) return;
  gesture.x = event.clientX;
  gesture.y = event.clientY;
  gesture.alt = event.altKey;
  if (!moveFrame) moveFrame = requestAnimationFrame(updateGesture);
});
window.addEventListener('pointerup', (event) => {
  if (gesture?.pointer !== event.pointerId) return;
  gesture.x = event.clientX;
  gesture.y = event.clientY;
  finishGesture(false);
});
window.addEventListener('pointercancel', (event) => { if (gesture?.pointer === event.pointerId) finishGesture(true); });
document.addEventListener('lostpointercapture', (event) => { if (gesture?.pointer === event.pointerId) finishGesture(true); });
window.addEventListener('blur', () => finishGesture(true));
document.addEventListener('dblclick', (event) => {
  if (phone.matches || suspended) return;
  if (!(event.target instanceof Element) || event.target.closest(interactive) || !event.target.closest('[data-window-drag]')) return;
  const root = event.target.closest<HTMLElement>('[data-desktop-window]');
  const entry = root && layouts.get(root);
  if (entry) command(entry, entry.maximized ? 'restore' : 'maximize');
});
document.addEventListener('focusin', (event) => {
  if (!(event.target instanceof Element)) return;
  const root = event.target.closest<HTMLElement>('[data-desktop-window]');
  const entry = root && layouts.get(root);
  if (entry) raise(entry);
});
document.addEventListener('keydown', (event) => {
  if (phone.matches || suspended) return;
  if (event.key === 'Escape' && gesture) { event.preventDefault(); finishGesture(true); return; }
  if (!(event.target instanceof HTMLElement) || !event.target.hasAttribute('data-window-drag') || !event.key.startsWith('Arrow')) return;
  const root = event.target.closest<HTMLElement>('[data-desktop-window]');
  const entry = root && layouts.get(root);
  if (!entry) return;
  event.preventDefault();
  const bounds = workspace();
  if (event.altKey && !event.shiftKey) {
    if (event.key === 'ArrowUp') applySnap(entry, 'maximize', bounds);
    else if (event.key === 'ArrowDown') {
      if (entry.snap && !entry.maximized) {
        entry.rect = entry.freeRect || entry.rect;
        entry.snap = undefined;
        entry.freeRect = undefined;
        apply(entry, bounds);
      } else command(entry, 'restore');
    }
    else if (bounds.width >= 486) applySnap(entry, event.key === 'ArrowLeft' ? 'left' : 'right', bounds);
    rememberLayout(entry);
    return;
  }
  if (entry.maximized) command(entry, 'restore');
  cancelWindowAnimation(entry.root);
  const rect = entry.root.getBoundingClientRect();
  const box = { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  const step = event.ctrlKey ? 1 : 16;
  const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
  const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
  if (event.shiftKey) { box.width += dx; box.height += dy; }
  else { box.x += dx; box.y += dy; }
  entry.snap = undefined;
  entry.freeRect = undefined;
  entry.rect = bounded(box, bounds);
  apply(entry, bounds);
  rememberLayout(entry);
});

function applyLayouts(): void {
  if (suspended) return;
  synchronizeEditing();
  const bounds = phone.matches ? undefined : workspace();
  for (const entry of layouts.values()) {
    if (!entry.root.isConnected) continue;
    if (!phone.matches) {
      if (entry.pendingMaximized !== undefined) {
        const maximized = entry.pendingMaximized;
        entry.pendingMaximized = undefined;
        command(entry, maximized ? 'maximize' : 'restore');
      }
      if (entry.pendingEditorLayout) {
        const detail = entry.pendingEditorLayout;
        entry.pendingEditorLayout = undefined;
        if (editing()) applyEditorLayout(entry, detail);
      }
    }
    apply(entry, bounds);
  }
}

function reflow(): void {
  if (suspended) return;
  finishGesture(true);
  if (phone.matches) {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = 0;
    applyLayouts();
    return;
  }
  if (resizeFrame) return;
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = 0;
    applyLayouts();
  });
}
window.addEventListener('resize', reflow);
window.visualViewport?.addEventListener('resize', reflow);
document.addEventListener('gwenlium:chrome-change', reflow);
document.addEventListener('gwenlium:mobile-window-change', reflow);
phone.addEventListener('change', reflow);
window.addEventListener('orientationchange', reflow);
document.addEventListener('astro:before-swap', () => {
  finishGesture(true);
  suspended = true;
  cancelAnimationFrame(resizeFrame);
  resizeFrame = 0;
  for (const entry of layouts.values()) detach(entry);
  preview?.remove();
  preview = undefined;
});
document.addEventListener('astro:after-swap', () => {
  suspended = false;
  // Restore persistent top-layer windows before the browser captures the new page.
  applyLayouts();
});
document.addEventListener('astro:page-load', () => { suspended = false; reflow(); });
window.addEventListener('beforeprint', () => { suspended = true; finishGesture(true); for (const entry of layouts.values()) detach(entry); });
window.addEventListener('afterprint', () => { suspended = false; reflow(); });
