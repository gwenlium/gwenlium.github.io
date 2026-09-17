import { registerWindow, resetWindowLayout, setWindowMaximized, unregisterWindow } from './window-layout';
import { animateWindow, cancelWindowAnimation } from './window-motion';

type DesktopWindowState = 'normal' | 'minimized' | 'maximized' | 'closed';
type WindowCommand = { id?: string; action?: 'restore' | 'maximize' | 'minimize' | 'close' | 'restore-all' };
type DesktopWindow = {
  id: string;
  title: string;
  root: HTMLElement;
  body: HTMLElement;
  controls: HTMLElement;
  maximizeButton: HTMLButtonElement;
  taskbarButton: HTMLButtonElement;
  pinned: boolean;
  lastFocus: HTMLElement | null;
  request: number;
  pending?: 'minimize' | 'close';
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

function createTaskbarButton(id: string, title: string) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'button-secondary taskbar-window';
  button.dataset.taskbarWindow = id;
  button.setAttribute('aria-label', title);
  button.title = title;
  button.setAttribute('aria-controls', id);
  button.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M2 3h12v10H2zM2 5.5h12" /></svg>';
  const label = document.createElement('span');
  label.className = 'taskbar-window-label';
  label.textContent = title;
  button.append(label);
  return button;
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
  entry.root.inert = false;
  entry.taskbarButton.hidden = !entry.pinned && state === 'closed';
  entry.taskbarButton.dataset.windowState = state;
  entry.taskbarButton.setAttribute('aria-expanded', String(state === 'normal' || state === 'maximized'));
  const action = state === 'maximized' ? 'restore' : 'maximize';
  const label = `${action === 'restore' ? 'Restore' : 'Maximize'} ${entry.title}`;
  entry.maximizeButton.dataset.windowAction = action;
  entry.maximizeButton.setAttribute('aria-label', label);
  entry.maximizeButton.title = label;
  setWindowMaximized(entry.root, state === 'maximized');
  if (state === 'maximized') entry.body.tabIndex = 0;
  else {
    entry.body.removeAttribute('tabindex');
    if (maximizedWindow === entry) maximizedWindow = undefined;
  }
}

function maximizeWindow(entry: DesktopWindow) {
  if (maximizedWindow === entry) return;
  if (maximizedWindow) restoreWindow(maximizedWindow, false);
  setState(entry, 'maximized');
  maximizedWindow = entry;
  entry.maximizeButton.focus({ preventScroll: true });
}

function restoreWindow(entry: DesktopWindow, focus = true) {
  const wasMaximized = maximizedWindow === entry;
  const wasHidden = entry.root.hidden;
  const wasMinimized = entry.pending === 'minimize' || entry.root.dataset.windowState === 'minimized';
  const wasClosing = entry.pending !== undefined;
  entry.request++;
  entry.pending = undefined;
  if (maximizedWindow && !wasMaximized) restoreWindow(maximizedWindow, false);
  cancelWindowAnimation(entry.root);
  setState(entry, 'normal');
  if (notice?.reopen.dataset.windowReopen === entry.id) hideNotice();
  if (wasMaximized || wasMinimized || wasHidden || wasClosing) {
    const anchor = wasMinimized ? entry.taskbarButton : undefined;
    void animateWindow(entry.root, wasHidden && !wasMinimized ? 'open' : 'restore', anchor);
  }
  windowsChanged();
  if (focus) {
    if (wasMaximized) entry.maximizeButton.focus({ preventScroll: true });
    else focusWindow(entry);
  }
}

async function hideWindow(entry: DesktopWindow, action: 'minimize' | 'close') {
  if (entry.root.hidden || entry.pending === action) return;
  const request = ++entry.request;
  entry.pending = action;
  if (action === 'minimize') entry.taskbarButton.focus({ preventScroll: true });
  else focusStart();
  entry.root.inert = true;
  const anchor = action === 'minimize' ? entry.taskbarButton : document.querySelector<HTMLElement>('[data-open-start]') ?? undefined;
  const completed = await animateWindow(entry.root, action, anchor);
  // A restore, another command, or a page swap invalidates this completion.
  if (!completed || entry.request !== request || desktopWindows.get(entry.id) !== entry) return;
  entry.pending = undefined;
  setState(entry, action === 'close' ? 'closed' : 'minimized');
  if (action === 'minimize') entry.taskbarButton.focus({ preventScroll: true });
  if (action === 'close') showNotice(entry);
  else if (notice?.reopen.dataset.windowReopen === entry.id) hideNotice();
  windowsChanged();
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
    for (const entry of desktopWindows.values()) {
      if (entry.root.hidden || entry.pending) focusTarget ??= entry;
      restoreWindow(entry, false);
      resetWindowLayout(entry.root);
    }
    hideNotice();
    windowsChanged();
    if (focusTarget) focusWindow(focusTarget);
    else if (previousMaximized) previousMaximized.maximizeButton.focus({ preventScroll: true });
    else focusStart();
    return;
  }

  const entry = id ? desktopWindows.get(id) : undefined;
  // Persistent windows own their commands, but must not recover behind this page's maximum.
  if ((action === 'maximize' || action === 'restore') && id && maximizedWindow?.id !== id && maximizedWindow) {
    restoreWindow(maximizedWindow, false);
  }
  if (!entry) return;
  switch (action) {
    case 'restore':
      restoreWindow(entry);
      return;
    case 'maximize':
      entry.request++;
      entry.pending = undefined;
      entry.root.inert = false;
      cancelWindowAnimation(entry.root);
      maximizeWindow(entry);
      void animateWindow(entry.root, 'restore');
      if (notice?.reopen.dataset.windowReopen === id) hideNotice();
      windowsChanged();
      return;
    case 'minimize':
    case 'close':
      void hideWindow(entry, action);
      return;
  }
}

function cleanupWindows() {
  pageEvents?.abort();
  pageEvents = undefined;
  const hadMaximized = maximizedWindow !== undefined;
  for (const entry of desktopWindows.values()) {
    entry.request++;
    entry.pending = undefined;
    cancelWindowAnimation(entry.root);
    entry.root.inert = false;
    if (maximizedWindow === entry) setState(entry, 'normal');
    unregisterWindow(entry.root);
    entry.controls.hidden = true;
    if (!entry.pinned) entry.taskbarButton.remove();
  }
  if (hadMaximized) windowsChanged();
  hideNotice();
  notice?.root.remove();
  notice = undefined;
  desktopWindows.clear();
  pageBody = undefined;
}

function initializeWindows() {
  if (pageBody === document.body) return;
  cleanupWindows();
  pageBody = document.body;
  pageEvents = new AbortController();
  const { signal } = pageEvents;
  const taskbar = document.querySelector<HTMLElement>('[data-taskbar-windows]')!;

  document.querySelectorAll<HTMLElement>('[data-desktop-window]:not([data-persistent-window])').forEach((root, index) => {
    const id = root.dataset.windowId ||= root.id || `desktop-window-${index + 1}`;
    const title = root.dataset.windowTitle || root.getAttribute('aria-label') || 'Window';
    const pinnedButton = id === 'site-settings' ? document.querySelector<HTMLButtonElement>('[data-open-settings]') : null;
    const entry: DesktopWindow = {
      id,
      title,
      root,
      body: root.querySelector<HTMLElement>(':scope > .window-body')!,
      controls: root.querySelector<HTMLElement>(':scope > .window-titlebar > [data-window-controls]')!,
      maximizeButton: root.querySelector<HTMLButtonElement>(':scope > .window-titlebar [data-window-maximize]')!,
      taskbarButton: pinnedButton || createTaskbarButton(id, title),
      pinned: Boolean(pinnedButton),
      lastFocus: null,
      request: 0,
    };
    desktopWindows.set(id, entry);
    if (!entry.pinned) taskbar.append(entry.taskbarButton);
    registerWindow(root, { floating: root.hasAttribute('data-window-default-floating') });
    setState(entry, root.dataset.windowInitialState === 'closed' ? 'closed' : 'normal');
    entry.controls.hidden = false;
    if (!root.hidden) void animateWindow(root, 'open');
  });
  createNotice();

  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const taskbarButton = event.target.closest<HTMLButtonElement>('[data-taskbar-window]');
    const taskbarId = taskbarButton?.dataset.taskbarWindow;
    if (taskbarId && desktopWindows.has(taskbarId)) {
      document.dispatchEvent(new CustomEvent<WindowCommand>('gwenlium:window-command', {
        detail: { id: taskbarId, action: 'restore' },
      }));
      return;
    }
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
    if (root && !root.hasAttribute('data-persistent-window')) {
      document.dispatchEvent(new CustomEvent<WindowCommand>('gwenlium:window-command', {
        detail: { id: root.dataset.windowId, action: button?.dataset.windowAction as WindowCommand['action'] },
      }));
    }
  }, { signal });

  document.addEventListener('focusin', (event) => {
    if (!(event.target instanceof HTMLElement) || event.target.closest('[data-window-action]')) return;
    const root = event.target.closest<HTMLElement>('[data-desktop-window]');
    const entry = root?.dataset.windowId && !root.hasAttribute('data-persistent-window') ? desktopWindows.get(root.dataset.windowId) : undefined;
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
    if (document.fullscreenElement || document.querySelector('dialog[open]')) return;
    if (typeof HTMLElement.prototype.showPopover === 'function' && document.querySelector('[popover]:popover-open:not([data-desktop-window]):not([aria-hidden="true"])')) return;
    event.preventDefault();
    commandWindow(maximizedWindow.id, 'restore');
  }, { signal });

  windowsChanged();
}

document.addEventListener('astro:before-swap', cleanupWindows);
window.addEventListener('pagehide', cleanupWindows);
window.addEventListener('pageshow', initializeWindows);
document.addEventListener('astro:page-load', initializeWindows);
initializeWindows();

export {};
