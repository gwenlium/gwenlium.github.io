import { playInterfaceSound } from './interface-audio';

type Direction = 'left' | 'right' | 'up' | 'down';

const lifetime = new AbortController();
const listenerOptions = { signal: lifetime.signal };
const controls = 'a[href], area[href], button, input:not([type="hidden"]), select, textarea, summary, [contenteditable="true"], [role="button"], [role="tab"], [role="menuitem"], [role="option"]';
const regions = '[data-desktop-window], .taskbar, .footer-navigation, #page-scroll';
const nativeArrows = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="slider"], [role="spinbutton"], video, audio, [data-window-drag]';
const rememberedFocus = new WeakMap<HTMLElement, HTMLElement>();
const caret = document.createElement('span');
caret.className = 'control-caret';
caret.setAttribute('aria-hidden', 'true');
caret.hidden = true;
const hasPopover = typeof caret.showPopover === 'function';
if (hasPopover) caret.setAttribute('popover', 'manual');
let target: HTMLElement | null = null;
let inputMode: 'pointer' | 'focus' = 'focus';
let caretFrame = 0;
let padFrame = 0;
let suspended = false;
let padIndex = -1;
let padArmed = false;
let previousButtons = 0;
let heldDirection: Direction | null = null;
let repeatAt = 0;
let previousTime = 0;
let pointerPosition: { x: number; y: number } | null = null;

function activePage(): boolean {
  return !suspended && document.visibilityState === 'visible' && document.hasFocus();
}

function modalDialog(): HTMLDialogElement | null {
  const dialogs = document.querySelectorAll<HTMLDialogElement>('dialog:modal');
  for (const dialog of dialogs) if (dialog.contains(document.activeElement)) return dialog;
  return dialogs[dialogs.length - 1] ?? null;
}

function anchorFor(element: HTMLElement): HTMLElement {
  if (element instanceof HTMLInputElement && (element.type === 'radio' || element.type === 'checkbox')) {
    const label = element.labels?.[0];
    if (label && label.getClientRects().length && !label.classList.contains('sr-only')) return label;
  }
  return element;
}

function available(element: HTMLElement): boolean {
  if (!element.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"], [aria-disabled="true"]') || element.matches(':disabled')) return false;
  const anchor = anchorFor(element);
  return anchor.getClientRects().length > 0 && getComputedStyle(anchor).visibility === 'visible';
}

function allowed(element: HTMLElement): boolean {
  const modal = modalDialog();
  return available(element) && (!modal || modal.contains(element));
}

function controlFrom(node: EventTarget | null): HTMLElement | null {
  if (!(node instanceof Element)) return null;
  const match = node.closest<HTMLElement>(`${controls}, label`);
  const element = match instanceof HTMLLabelElement ? match.control : match;
  return element instanceof HTMLElement && element !== caret && allowed(element) ? element : null;
}

function hideCaret(): void {
  if (hasPopover && caret.matches(':popover-open')) caret.hidePopover();
  caret.hidden = true;
}

function setTarget(element: HTMLElement | null, mode = inputMode): void {
  inputMode = mode;
  if (element !== target) {
    resizeObserver.disconnect();
    if (element) {
      resizeObserver.observe(anchorFor(element));
      const root = element.closest<HTMLElement>('[data-desktop-window]');
      if (root) resizeObserver.observe(root);
      if (activePage()) playInterfaceSound('move');
    }
  }
  target = element;
  if (!target || !activePage()) hideCaret();
  else queueCaret();
}

function queueCaret(): void {
  if (!caretFrame && !suspended && target) caretFrame = requestAnimationFrame(positionCaret);
}

function positionCaret(): void {
  caretFrame = 0;
  if (!target || !activePage() || !allowed(target)) {
    setTarget(null);
    return;
  }
  // The current page already has a persistent footer marker.
  if (target.matches('.footer-link[aria-current="page"]')) {
    hideCaret();
    return;
  }
  const anchor = anchorFor(target);
  const rect = anchor.getBoundingClientRect();
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft ?? 0;
  const top = viewport?.offsetTop ?? 0;
  const right = left + (viewport?.width ?? innerWidth);
  const bottom = top + (viewport?.height ?? innerHeight);
  let visibleTop = Math.max(rect.top, top);
  let visibleBottom = Math.min(rect.bottom, bottom);
  let visibleLeft = Math.max(rect.left, left);
  let visibleRight = Math.min(rect.right, right);
  // Hide a scrolled-away target instead of pinning its caret to the pane edge.
  for (let parent = anchor.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    const bounds = parent.getBoundingClientRect();
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
      visibleTop = Math.max(visibleTop, bounds.top);
      visibleBottom = Math.min(visibleBottom, bounds.bottom);
    }
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
      visibleLeft = Math.max(visibleLeft, bounds.left);
      visibleRight = Math.min(visibleRight, bounds.right);
    }
  }
  if (visibleBottom <= visibleTop || visibleRight <= visibleLeft) {
    hideCaret();
    return;
  }
  const modal = modalDialog();
  const parent = modal ?? (hasPopover ? target.closest<HTMLElement>('[popover]:popover-open') : null) ?? document.body;
  if (caret.parentElement !== parent) {
    hideCaret();
    parent.append(caret);
  }
  // A manual popover stays above floating windows, and inside the modal's inert boundary.
  caret.hidden = false;
  if (hasPopover && !caret.matches(':popover-open')) caret.showPopover();
  let x = rect.left - 17;
  let y = (visibleTop + visibleBottom) / 2 - 7;
  let side = 'left';
  if (x < left + 2) {
    x = rect.right + 5;
    side = 'right';
  }
  if (x + 12 > right - 2) {
    x = Math.max(left + 2, Math.min(right - 14, (visibleLeft + visibleRight) / 2 - 6));
    y = rect.top - 18;
    side = 'above';
    if (y < top + 2) { y = rect.bottom + 4; side = 'below'; }
  }
  if (y < top || y + 14 > bottom) { hideCaret(); return; }
  caret.dataset.side = side;
  caret.style.left = `${Math.round(x)}px`;
  caret.style.top = `${Math.round(y)}px`;
  const windowRoot = anchor.closest('[data-desktop-window]');
  if (windowRoot?.getAnimations().some((animation) => animation.playState === 'running')) queueCaret();
}

function candidates(scope: ParentNode): HTMLElement[] {
  return Array.from(scope.querySelectorAll<HTMLElement>(controls)).filter((element) =>
    (element.tabIndex >= 0 || element.matches('[role="tab"], [role="menuitem"], [role="option"]')) && allowed(element));
}

function currentControl(): HTMLElement | null {
  return target && allowed(target) ? target : controlFrom(document.activeElement);
}

function navigationScope(current: HTMLElement | null): HTMLElement | Document {
  const modal = modalDialog();
  if (modal) return modal;
  const region = current?.closest<HTMLElement>(regions);
  if (region) return region;
  const windows = Array.from(document.querySelectorAll<HTMLElement>('[data-desktop-window]')).filter(available);
  let highest: HTMLElement | undefined;
  for (const root of windows) {
    if (!highest || Number(root.style.getPropertyValue('--window-layer')) > Number(highest.style.getPropertyValue('--window-layer'))) highest = root;
  }
  return highest ?? document;
}

function focusControl(element: HTMLElement): boolean {
  if (!allowed(element)) return false;
  element.focus({ preventScroll: true });
  if (document.activeElement !== element) return false;
  element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  setTarget(element, 'focus');
  return true;
}

function moveFocus(direction: Direction): boolean {
  const current = currentControl();
  const items = candidates(navigationScope(current));
  if (!items.length) return false;
  if (!current || !items.includes(current)) return focusControl(items[0]);
  const origin = anchorFor(current).getBoundingClientRect();
  const horizontal = direction === 'left' || direction === 'right';
  const sign = direction === 'left' || direction === 'up' ? -1 : 1;
  const ox = (origin.left + origin.right) / 2;
  const oy = (origin.top + origin.bottom) / 2;
  let best: HTMLElement | undefined;
  let bestScore = Infinity;
  for (const item of items) {
    if (item === current) continue;
    const rect = anchorFor(item).getBoundingClientRect();
    const dx = (rect.left + rect.right) / 2 - ox;
    const dy = (rect.top + rect.bottom) / 2 - oy;
    const forward = (horizontal ? dx : dy) * sign;
    if (forward <= 2) continue;
    const cross = Math.abs(horizontal ? dy : dx);
    const overlap = horizontal ? rect.bottom > origin.top && rect.top < origin.bottom : rect.right > origin.left && rect.left < origin.right;
    const score = forward + cross * 2 + (overlap ? 0 : 100);
    if (score < bestScore) { best = item; bestScore = score; }
  }
  // At an edge, wrap in document order so isolated controls remain reachable.
  const next = (items.indexOf(current) + sign + items.length) % items.length;
  return focusControl(best ?? items[next]);
}

function cycleRegion(reverse: boolean): boolean {
  const modal = modalDialog();
  const selector = modal ? 'header, [role="search"], nav, section, details, footer' : regions;
  const roots = Array.from((modal ?? document).querySelectorAll<HTMLElement>(selector)).filter((root) =>
    available(root) && candidates(root).some((item) => item.closest(selector) === root));
  if (!roots.length) return modal ? moveFocus(reverse ? 'up' : 'down') : false;
  const current = currentControl();
  const region = (current ?? document.activeElement)?.closest(selector);
  const index = roots.findIndex((root) => region === root);
  const next = index < 0 ? (reverse ? roots.length - 1 : 0) : (index + (reverse ? -1 : 1) + roots.length) % roots.length;
  const root = roots[next];
  const remembered = rememberedFocus.get(root);
  const destination = remembered && allowed(remembered) && root.contains(remembered)
    ? remembered : candidates(root).find((item) => item.closest(selector) === root);
  return destination ? focusControl(destination) : false;
}

// Called by Start's existing shortcut handler, after native/component handlers have had their say.
export function handleControlKeydown(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing || !activePage()) return false;
  const focused = controlFrom(document.activeElement);
  if (focused) setTarget(focused, 'focus');
  if (event.altKey || event.ctrlKey || event.metaKey) return false;
  if (event.key === 'F6') {
    if (event.repeat || cycleRegion(event.shiftKey)) { event.preventDefault(); return true; }
    return false;
  }
  if (event.shiftKey || !event.key.startsWith('Arrow')) return false;
  if (event.target instanceof Element && (event.target.closest(nativeArrows)
    || ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && event.target.closest('.taskbar')))) return false;
  const direction = event.key.slice(5).toLowerCase() as Direction;
  if (moveFocus(direction)) { event.preventDefault(); return true; }
  return false;
}

function changeValue(element: HTMLElement, direction: Direction): boolean {
  if (direction !== 'left' && direction !== 'right') return false;
  const sign = direction === 'right' ? 1 : -1;
  if (element instanceof HTMLInputElement && element.type === 'range') {
    const before = element.value;
    if (element.step === 'any') {
      const minimum = element.min === '' ? 0 : Number(element.min);
      const maximum = element.max === '' ? 100 : Number(element.max);
      element.valueAsNumber = Math.max(minimum, Math.min(maximum, element.valueAsNumber + sign * (maximum - minimum) / 100));
    } else if (sign > 0) element.stepUp();
    else element.stepDown();
    if (element.value !== before) {
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return true;
  }
  if (element instanceof HTMLSelectElement && !element.multiple) {
    for (let index = element.selectedIndex + sign; index >= 0 && index < element.options.length; index += sign) {
      const option = element.options[index];
      if (option.disabled || option.hidden || option.closest('optgroup:disabled')) continue;
      element.selectedIndex = index;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      break;
    }
    return true;
  }
  return false;
}

function padDirection(direction: Direction): void {
  const current = currentControl();
  if (current && focusControl(current) && changeValue(current, direction)) return;
  moveFocus(direction);
}

function activate(): void {
  const current = currentControl() ?? candidates(navigationScope(null))[0];
  if (!current || !focusControl(current)) return;
  if (!(current instanceof HTMLSelectElement) && !(current instanceof HTMLInputElement && current.type === 'range')) {
    current.click();
  }
}

function goBack(): void {
  const modal = modalDialog();
  if (modal) {
    // Honor the viewer's cancel cleanup, not just dialog.close().
    if (modal.dispatchEvent(new Event('cancel', { cancelable: true }))) modal.close();
    return;
  }
  const current = currentControl();
  const event = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true });
  (current ?? document.body).dispatchEvent(event);
  if (event.defaultPrevented) return;
  const details = current?.closest('details[open]');
  if (details instanceof HTMLDetailsElement) {
    details.open = false;
    const summary = details.querySelector('summary');
    if (summary) focusControl(summary);
    return;
  }
  const root = current?.closest<HTMLElement>('[data-desktop-window]');
  if (root?.dataset.windowId) document.dispatchEvent(new CustomEvent('gwenlium:window-command', { detail: { id: root.dataset.windowId, action: 'close' } }));
}

function scrollPane(x: number, y: number, elapsed: number): void {
  const current = currentControl();
  const scope = navigationScope(current);
  const scrollable = (element: HTMLElement) => {
    const style = getComputedStyle(element);
    return (y !== 0 && /(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight)
      || (x !== 0 && /(auto|scroll)/.test(style.overflowX) && element.scrollWidth > element.clientWidth);
  };
  let pane: HTMLElement | null = current;
  while (pane && !scrollable(pane)) {
    if (pane === scope && scope instanceof HTMLDialogElement) { pane = null; break; }
    pane = pane.parentElement;
  }
  if (!pane) pane = Array.from(scope.querySelectorAll<HTMLElement>('.window-body, .player-body, .player-queue, .start-content, #page-scroll, [role="region"]')).find((element) => available(element) && scrollable(element)) ?? null;
  if (!pane) return;
  pane.scrollBy({ left: x * elapsed * .65, top: y * elapsed * .65, behavior: 'instant' });
}

function readPads(): (Gamepad | null)[] {
  try { return navigator.getGamepads ? navigator.getGamepads() : []; }
  catch { return []; } // Permissions Policy may intentionally disable the API.
}

function stopGamepad(): void {
  cancelAnimationFrame(padFrame);
  padFrame = 0;
  padIndex = -1;
  padArmed = false;
  previousButtons = 0;
  heldDirection = null;
  previousTime = 0;
}

function scrollAxis(value: number): number {
  return Math.abs(value) > .25 ? Math.sign(value) * (Math.abs(value) - .25) / .75 : 0;
}

function pollGamepad(now: number): void {
  padFrame = 0;
  if (!activePage()) { stopGamepad(); return; }
  const pads = readPads();
  let pad: Gamepad | null = null;
  for (const item of pads) {
    if (!item?.connected || item.mapping !== 'standard') continue;
    if (!pad || item.index === padIndex) pad = item;
    if (item.index === padIndex) break;
  }
  if (!pad) { stopGamepad(); return; }
  if (pad.index !== padIndex) { stopGamepad(); padIndex = pad.index; }
  let buttons = 0;
  for (let i = 0; i < Math.min(17, pad.buttons.length); i += 1) if (pad.buttons[i].pressed || pad.buttons[i].value > .5) buttons |= 1 << i;
  const axisX = pad.axes[0] ?? 0;
  const axisY = pad.axes[1] ?? 0;
  let direction: Direction | null = buttons & (1 << 12) ? 'up' : buttons & (1 << 13) ? 'down' : buttons & (1 << 14) ? 'left' : buttons & (1 << 15) ? 'right' : null;
  if (!direction && Math.max(Math.abs(axisX), Math.abs(axisY)) > .45) direction = Math.abs(axisX) > Math.abs(axisY) ? (axisX > 0 ? 'right' : 'left') : (axisY > 0 ? 'down' : 'up');
  const scrollX = scrollAxis(pad.axes[2] ?? 0);
  const scrollY = scrollAxis(pad.axes[3] ?? 0);
  const elapsed = previousTime ? Math.min(32, now - previousTime) : 0;
  previousTime = now;
  // A held button on connect, tab return, or page navigation must first be released.
  if (!padArmed) padArmed = buttons === 0 && !direction && !scrollX && !scrollY;
  else {
    const pressed = buttons & ~previousButtons;
    if (pressed & (1 << 9)) {
      if (!modalDialog()) document.querySelector<HTMLButtonElement>('[data-open-start]')?.click();
    } else if (pressed & (1 << 1)) goBack();
    else if (pressed & (1 << 4)) cycleRegion(true);
    else if (pressed & (1 << 5)) cycleRegion(false);
    else if (pressed & 1) activate();
    else if (direction && (direction !== heldDirection || now >= repeatAt)) {
      padDirection(direction);
      repeatAt = now + (direction === heldDirection ? 110 : 340);
    }
    if (scrollX || scrollY) scrollPane(scrollX, scrollY, elapsed);
  }
  heldDirection = direction;
  previousButtons = buttons;
  padFrame = requestAnimationFrame(pollGamepad);
}

function startGamepad(): void {
  if (!padFrame && activePage() && readPads().some((pad) => pad?.connected && pad.mapping === 'standard')) padFrame = requestAnimationFrame(pollGamepad);
}

const observer = new MutationObserver((records) => {
  if (!target) return;
  if (!target.isConnected || records.some((record) => record.target instanceof Element && record.target !== caret
    && (record.target.contains(target) || record.target.matches('dialog')))) queueCaret();
});
const resizeObserver = new ResizeObserver(queueCaret);

function bindPage(): void {
  suspended = false;
  observer.disconnect();
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'inert', 'open', 'disabled', 'aria-disabled', 'aria-hidden', 'class', 'style'] });
  target = null;
  resizeObserver.disconnect();
  setTarget(controlFrom(document.activeElement), 'focus');
  startGamepad();
}

document.addEventListener('pointermove', (event) => {
  if (event.pointerType === 'touch') return;
  pointerPosition = { x: event.clientX, y: event.clientY };
  setTarget(controlFrom(event.target), 'pointer');
}, listenerOptions);
document.addEventListener('pointerdown', (event) => {
  pointerPosition = event.pointerType === 'touch' ? null : { x: event.clientX, y: event.clientY };
  setTarget(controlFrom(event.target), 'pointer');
}, listenerOptions);
document.addEventListener('click', (event) => {
  if (event.button !== 0 || !activePage() || !(event.target instanceof Element)) return;
  const element = controlFrom(event.target);
  if (!element) return;
  const label = event.target.closest('label');
  // A label forwards activation to its input; sound only that forwarded click.
  if (label?.control === element && !element.contains(event.target)) return;
  playInterfaceSound('confirm');
}, { ...listenerOptions, capture: true });
document.addEventListener('pointerout', (event) => {
  if (!event.relatedTarget) pointerPosition = null;
  if (inputMode === 'pointer') setTarget(controlFrom(event.relatedTarget), 'pointer');
}, listenerOptions);
document.addEventListener('focusin', (event) => {
  const element = controlFrom(event.target);
  setTarget(element, 'focus');
  const region = element?.closest<HTMLElement>(regions);
  if (element && region) rememberedFocus.set(region, element);
}, listenerOptions);
document.addEventListener('focusout', () => queueMicrotask(() => {
  if (inputMode === 'focus') setTarget(controlFrom(document.activeElement), 'focus');
}), listenerOptions);
document.addEventListener('scroll', () => {
  if (inputMode === 'pointer' && pointerPosition) setTarget(controlFrom(document.elementFromPoint(pointerPosition.x, pointerPosition.y)), 'pointer');
  else queueCaret();
}, { ...listenerOptions, capture: true, passive: true });
document.addEventListener('toggle', (event) => { if (event.target !== caret) queueCaret(); }, { ...listenerOptions, capture: true });
document.addEventListener('close', () => queueMicrotask(() => setTarget(controlFrom(document.activeElement), 'focus')), { ...listenerOptions, capture: true });
document.addEventListener('gwenlium:windows-changed', queueCaret, listenerOptions);
document.addEventListener('gwenlium:chrome-change', queueCaret, listenerOptions);
window.addEventListener('resize', queueCaret, listenerOptions);
window.visualViewport?.addEventListener('resize', queueCaret, listenerOptions);
window.visualViewport?.addEventListener('scroll', queueCaret, listenerOptions);
window.addEventListener('gamepadconnected', startGamepad, listenerOptions);
window.addEventListener('gamepaddisconnected', () => { stopGamepad(); startGamepad(); }, listenerOptions);
window.addEventListener('blur', () => { setTarget(null); stopGamepad(); }, listenerOptions);
window.addEventListener('focus', () => { setTarget(controlFrom(document.activeElement), 'focus'); startGamepad(); }, listenerOptions);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') { setTarget(null); stopGamepad(); }
  else if (activePage()) { setTarget(controlFrom(document.activeElement), 'focus'); startGamepad(); }
}, listenerOptions);
document.addEventListener('astro:before-swap', () => {
  suspended = true;
  setTarget(null);
  cancelAnimationFrame(caretFrame);
  caretFrame = 0;
  caret.remove();
  observer.disconnect();
  resizeObserver.disconnect();
  stopGamepad();
}, listenerOptions);
document.addEventListener('astro:page-load', bindPage, listenerOptions);

bindPage();
if (import.meta.hot) import.meta.hot.dispose(() => {
  lifetime.abort();
  observer.disconnect();
  resizeObserver.disconnect();
  stopGamepad();
  cancelAnimationFrame(caretFrame);
  caret.remove();
});
