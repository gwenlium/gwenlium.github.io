/** Small DOM helpers shared by the owner controls and the writing page. */
export function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

export function button(label: string, callback: () => void, className = 'owner-button'): HTMLButtonElement {
  const element = node('button', label, className);
  element.type = 'button';
  element.addEventListener('click', callback);
  return element;
}

export function errorText(error: unknown, fallback = 'Something went wrong. Nothing was published.'): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export type OwnerDialog = { dialog: HTMLDialogElement; body: HTMLElement; footer: HTMLElement; status: HTMLElement; close(): void };

export function openDialog(title: string, options: { wide?: boolean } = {}): OwnerDialog {
  const dialog = node('dialog', undefined, `owner-dialog${options.wide ? ' owner-dialog--wide' : ''}`);
  const heading = node('h2', title, 'owner-dialog__title');
  heading.id = `owner-dialog-${crypto.randomUUID()}`;
  dialog.setAttribute('aria-labelledby', heading.id);
  const body = node('div', undefined, 'owner-dialog__body');
  const status = node('p', '', 'owner-dialog__status');
  status.setAttribute('role', 'status');
  const footer = node('div', undefined, 'owner-dialog__actions');
  dialog.append(heading, body, status, footer);
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  // Page navigation should never leave an owner dialog behind.
  document.addEventListener('astro:before-swap', () => dialog.close(), { once: true });
  dialog.showModal();
  return { dialog, body, footer, status, close: () => dialog.close() };
}

export function confirmAction(title: string, description: string, accept: string, danger = false): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const { dialog, body, footer } = openDialog(title);
  body.append(node('p', description));
  let accepted = false;
  const confirm = button(accept, () => { accepted = true; dialog.close(); }, `owner-button owner-button--primary${danger ? ' owner-button--danger' : ''}`);
  footer.append(button('Cancel', () => dialog.close()), confirm);
  dialog.addEventListener('close', () => resolve(accepted), { once: true });
  confirm.focus();
  return promise;
}

let toastTimer: number | undefined;
export function toast(message: string, options: { action?: { label: string; href?: string; run?: () => void }; sticky?: boolean } = {}): void {
  let element = document.querySelector<HTMLElement>('.owner-toast');
  if (!element) {
    element = node('div', undefined, 'owner-toast');
    element.setAttribute('role', 'status');
    element.setAttribute('aria-live', 'polite');
    element.popover = 'manual';
    document.body.append(element);
  }
  element.replaceChildren(node('span', message));
  if (options.action) {
    const { label, href, run } = options.action;
    if (href) { const link = node('a', label, 'owner-toast__action'); link.href = href; element.append(link); }
    else if (run) element.append(button(label, run, 'owner-toast__action'));
  }
  element.append(button('×', () => element!.hidePopover(), 'owner-toast__close'));
  element.lastElementChild!.setAttribute('aria-label', 'Dismiss');
  try { if (!element.matches(':popover-open')) element.showPopover(); } catch { /* Not connected yet. */ }
  clearTimeout(toastTimer);
  if (!options.sticky) toastTimer = window.setTimeout(() => { try { element!.hidePopover(); } catch { /* Gone. */ } }, 6000);
}

/** A light-dismiss panel anchored under (or above) an element, in the top layer. */
export function anchoredPanel(anchor: Element, className = 'owner-popover'): { panel: HTMLElement; close(): void; closed: Promise<void> } {
  const panel = node('div', undefined, className);
  panel.popover = 'auto';
  document.body.append(panel);
  const { promise, resolve } = Promise.withResolvers<void>();
  const place = () => {
    const box = anchor.getBoundingClientRect();
    const width = Math.min(panel.offsetWidth || 320, innerWidth - 16);
    const left = Math.max(8, Math.min(box.left, innerWidth - width - 8));
    const below = box.bottom + 8;
    const top = below + panel.offsetHeight > innerHeight - 8 ? Math.max(8, box.top - panel.offsetHeight - 8) : below;
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  };
  panel.addEventListener('toggle', event => {
    if ((event as ToggleEvent).newState === 'closed') { panel.remove(); removeEventListener('resize', place); resolve(); }
  });
  addEventListener('resize', place);
  queueMicrotask(() => { panel.showPopover(); place(); });
  const close = () => {
    // Letting the browser hand focus back into a floating window makes it re-raise itself
    // while this popover is still closing; release focus first and return it afterwards.
    const returnTo = anchor instanceof HTMLElement && panel.contains(document.activeElement) ? anchor : undefined;
    if (document.activeElement instanceof HTMLElement && panel.contains(document.activeElement)) document.activeElement.blur();
    try { panel.hidePopover(); } catch { panel.remove(); resolve(); }
    if (returnTo?.isConnected && returnTo.tabIndex >= 0) setTimeout(() => returnTo.focus({ preventScroll: true }));
  };
  return { panel, close, closed: promise };
}
