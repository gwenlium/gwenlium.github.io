type DesktopWindowState = 'normal' | 'minimized' | 'maximized' | 'closed';
type WindowCommand = { id?: string; action?: 'restore' | 'maximize' | 'minimize' | 'close' | 'restore-all' };
type MovingElement = HTMLElement & { moveBefore?: (node: Node, reference: Node | null) => void };
type DesktopWindow = {
  id: string;
  title: string;
  root: HTMLElement;
  body: HTMLElement;
  controls: HTMLElement;
  maximizeButton: HTMLButtonElement;
  lastFocus: HTMLElement | null;
  placement?: { marker: HTMLElement; parent: MovingElement; portaled: boolean };
};

const desktopWindows = new Map<string, DesktopWindow>();
let pageBody: HTMLElement | undefined;
let pageEvents: AbortController | undefined;
let maximizedWindow: DesktopWindow | undefined;
let notice: { root: HTMLElement; message: HTMLElement; reopen: HTMLButtonElement } | undefined;
let noticeFrame = 0;

const contentControls = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, audio[controls], video[controls], iframe, [tabindex], [contenteditable="true"]';

function windowsChanged() {
  document.dispatchEvent(new CustomEvent('gwenlium:windows-changed'));
}

function focusStart() {
  document.querySelector<HTMLButtonElement>('[data-open-start]')?.focus({ preventScroll: true });
}

function usableControl(element: HTMLElement, root: HTMLElement) {
  return root.contains(element) && element.tabIndex >= 0 && !element.matches(':disabled')
    && !element.closest('[hidden], [inert]') && element.getClientRects().length > 0
    && getComputedStyle(element).visibility === 'visible';
}

function focusWindow(entry: DesktopWindow) {
  if (entry.lastFocus && usableControl(entry.lastFocus, entry.root)) {
    entry.lastFocus.focus();
    return;
  }
  for (const control of entry.body.querySelectorAll<HTMLElement>(contentControls)) {
    if (usableControl(control, entry.root)) {
      control.focus();
      return;
    }
  }
  entry.maximizeButton.focus();
}

function setState(entry: DesktopWindow, state: DesktopWindowState) {
  entry.root.dataset.windowState = state;
  entry.root.hidden = state === 'minimized' || state === 'closed';
  const action = state === 'maximized' ? 'restore' : 'maximize';
  const label = `${action === 'restore' ? 'Restore' : 'Maximize'} ${entry.title}`;
  entry.maximizeButton.dataset.windowAction = action;
  entry.maximizeButton.setAttribute('aria-label', label);
  entry.maximizeButton.title = label;
}

function restorePlacement(entry: DesktopWindow) {
  const placement = entry.placement;
  if (!placement) return;
  if (placement.portaled) {
    // The same state-preserving primitive is used in both directions: no iframe reloads.
    placement.parent.moveBefore!(entry.root, placement.marker);
  } else {
    entry.root.hidePopover();
    entry.root.removeAttribute('popover');
  }
  placement.marker.remove();
  entry.placement = undefined;
  entry.body.removeAttribute('tabindex');
  maximizedWindow = undefined;
  setState(entry, 'normal');
}

function maximizeWindow(entry: DesktopWindow) {
  if (maximizedWindow === entry) return;
  if (maximizedWindow) restorePlacement(maximizedWindow);
  setState(entry, 'normal');
  const parent = entry.root.parentElement as MovingElement;
  const marker = document.createElement('div');
  marker.dataset.windowPlaceholder = entry.id;
  marker.setAttribute('aria-hidden', 'true');
  marker.style.height = `${entry.root.getBoundingClientRect().height}px`;
  marker.style.margin = getComputedStyle(entry.root).margin;
  parent.insertBefore(marker, entry.root);

  const destination = document.body as MovingElement;
  const portaled = typeof destination.moveBefore === 'function';
  entry.placement = { marker, parent, portaled };
  setState(entry, 'maximized');
  if (portaled) {
    destination.moveBefore!(entry.root, null);
  } else {
    // A manual popover escapes ancestor stacking contexts without disconnecting media
    // in browsers that do not yet implement state-preserving DOM moves.
    entry.root.setAttribute('popover', 'manual');
    entry.root.showPopover();
  }
  maximizedWindow = entry;
  entry.body.tabIndex = 0;
  entry.maximizeButton.focus({ preventScroll: true });
}

function hideNotice() {
  cancelAnimationFrame(noticeFrame);
  noticeFrame = 0;
  if (!notice) return;
  notice.root.hidden = true;
  notice.message.textContent = '';
  delete notice.reopen.dataset.windowReopen;
}

function showNotice(entry: DesktopWindow) {
  if (!notice) return;
  cancelAnimationFrame(noticeFrame);
  notice.message.textContent = '';
  notice.root.hidden = false;
  notice.reopen.dataset.windowReopen = entry.id;
  notice.reopen.setAttribute('aria-label', `Reopen ${entry.title}`);
  notice.reopen.title = `Reopen ${entry.title}`;
  // Populate the live region after it becomes visible, including repeated closes.
  noticeFrame = requestAnimationFrame(() => {
    noticeFrame = 0;
    if (notice) notice.message.textContent = `Closed ${entry.title}. Reopen here or from Start.`;
  });
}

function createNotice() {
  const root = document.createElement('aside');
  root.className = 'window-recovery-toast';
  root.setAttribute('aria-label', 'Window recovery');
  root.hidden = true;
  const message = document.createElement('p');
  message.setAttribute('role', 'status');
  message.setAttribute('aria-live', 'polite');
  message.setAttribute('aria-atomic', 'true');
  const actions = document.createElement('div');
  actions.className = 'window-recovery-toast__actions';
  const reopen = document.createElement('button');
  reopen.type = 'button';
  reopen.textContent = 'Reopen';
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.textContent = 'Dismiss';
  dismiss.dataset.windowNoticeDismiss = '';
  dismiss.setAttribute('aria-label', 'Dismiss window notice');
  actions.append(reopen, dismiss);
  root.append(message, actions);
  document.body.append(root);
  notice = { root, message, reopen };
}

function commandWindow(id: string | undefined, action: string | undefined) {
  if (action === 'restore-all') {
    let focusTarget: DesktopWindow | undefined;
    const previousMaximized = maximizedWindow;
    if (maximizedWindow) restorePlacement(maximizedWindow);
    for (const entry of desktopWindows.values()) {
      if (!entry.root.hidden) continue;
      focusTarget ??= entry;
      setState(entry, 'normal');
    }
    hideNotice();
    windowsChanged();
    if (focusTarget) focusWindow(focusTarget);
    else if (previousMaximized) previousMaximized.maximizeButton.focus();
    else focusStart();
    return;
  }

  const entry = id ? desktopWindows.get(id) : undefined;
  if (!entry) return;
  switch (action) {
    case 'restore': {
      const wasMaximized = maximizedWindow === entry;
      // Recovery must not leave the restored panel underneath another maximized panel.
      if (maximizedWindow) restorePlacement(maximizedWindow);
      setState(entry, 'normal');
      if (notice?.reopen.dataset.windowReopen === id) hideNotice();
      windowsChanged();
      if (wasMaximized) entry.maximizeButton.focus();
      else focusWindow(entry);
      return;
    }
    case 'maximize':
      maximizeWindow(entry);
      if (notice?.reopen.dataset.windowReopen === id) hideNotice();
      break;
    case 'minimize':
    case 'close':
      restorePlacement(entry);
      setState(entry, action === 'close' ? 'closed' : 'minimized');
      if (action === 'close') showNotice(entry);
      else if (notice?.reopen.dataset.windowReopen === id) hideNotice();
      focusStart();
      break;
    default:
      return;
  }
  windowsChanged();
}

function cleanupWindows() {
  pageEvents?.abort();
  pageEvents = undefined;
  if (maximizedWindow) {
    restorePlacement(maximizedWindow);
    windowsChanged();
  }
  hideNotice();
  notice?.root.remove();
  notice = undefined;
  for (const entry of desktopWindows.values()) entry.controls.hidden = true;
  desktopWindows.clear();
  pageBody = undefined;
}

function initializeWindows() {
  if (pageBody === document.body) return;
  cleanupWindows();
  pageBody = document.body;
  pageEvents = new AbortController();
  const { signal } = pageEvents;

  document.querySelectorAll<HTMLElement>('[data-desktop-window]').forEach((root, index) => {
    const id = root.dataset.windowId ||= `desktop-window-${index + 1}`;
    const entry: DesktopWindow = {
      id,
      title: root.dataset.windowTitle || root.getAttribute('aria-label') || 'Window',
      root,
      body: root.querySelector<HTMLElement>(':scope > .window-body')!,
      controls: root.querySelector<HTMLElement>(':scope > .window-titlebar > [data-window-controls]')!,
      maximizeButton: root.querySelector<HTMLButtonElement>(':scope > .window-titlebar [data-window-maximize]')!,
      lastFocus: null,
    };
    desktopWindows.set(id, entry);
    setState(entry, 'normal');
    entry.controls.hidden = false;
  });
  createNotice();

  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const reopen = event.target.closest<HTMLButtonElement>('[data-window-reopen]');
    if (reopen) {
      commandWindow(reopen.dataset.windowReopen, 'restore');
      return;
    }
    if (event.target.closest('[data-window-notice-dismiss]')) {
      hideNotice();
      focusStart();
      return;
    }
    const button = event.target.closest<HTMLButtonElement>('[data-window-action]');
    const root = button?.closest<HTMLElement>('[data-desktop-window]');
    if (root) commandWindow(root.dataset.windowId, button?.dataset.windowAction);
  }, { signal });

  document.addEventListener('focusin', (event) => {
    if (!(event.target instanceof HTMLElement) || event.target.closest('[data-window-action]')) return;
    const root = event.target.closest<HTMLElement>('[data-desktop-window]');
    const entry = root?.dataset.windowId ? desktopWindows.get(root.dataset.windowId) : undefined;
    if (entry) entry.lastFocus = event.target;
  }, { signal });

  document.addEventListener('gwenlium:window-command', (event) => {
    const detail = (event as CustomEvent<WindowCommand | undefined>).detail;
    if (detail) commandWindow(detail.id, detail.action);
  }, { signal });

  // Bubble past document-level handlers so dialogs, queue controls, and other
  // surfaces can consume Escape before it affects a background window.
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || !maximizedWindow) return;
    if (document.fullscreenElement || document.querySelector('dialog[open], [popover]:popover-open:not([data-desktop-window])')) return;
    event.preventDefault();
    commandWindow(maximizedWindow.id, 'restore');
  }, { signal });

  windowsChanged();
}

document.addEventListener('astro:before-swap', cleanupWindows);
document.addEventListener('astro:page-load', initializeWindows);
initializeWindows();

export {};
