type PageViewTransition = {
  ready: Promise<void>;
  finished: Promise<void>;
  skipTransition(): void;
};
type BeforeSwapEvent = Event & {
  newDocument: Document;
  signal: AbortSignal;
  viewTransition: PageViewTransition;
};
type PreparationEvent = Event & { signal: AbortSignal; loader: () => Promise<void> };
type ActiveTransition = {
  overlay: HTMLElement;
  signal: AbortSignal;
  transition: PageViewTransition;
  abort: () => void;
  animations: Animation[];
};

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const forcedColors = window.matchMedia('(forced-colors: active)');
let activeTransition: ActiveTransition | undefined;
let preparationAnimation: Animation | undefined;

function motionAllowed() {
  const preference = document.documentElement.dataset.motion;
  return preference !== 'reduced' && (preference === 'full' || !reducedMotion.matches) && !forcedColors.matches;
}

function clearTransition(skip = true) {
  preparationAnimation?.cancel();
  preparationAnimation = undefined;
  const active = activeTransition;
  if (!active) return;
  activeTransition = undefined;
  active.signal.removeEventListener('abort', active.abort);
  for (const animation of active.animations) animation.cancel();
  active.overlay.hidden = true;
  active.overlay.removeAttribute('style');
  if (skip) active.transition.skipTransition();
}

function positionOverlay(overlay: HTMLElement, workspace: HTMLElement) {
  const bounds = workspace.getBoundingClientRect();
  overlay.style.top = `${Math.max(0, bounds.top)}px`;
  overlay.style.left = `${Math.max(0, bounds.left)}px`;
  overlay.style.right = `${Math.max(0, innerWidth - bounds.right)}px`;
  overlay.style.bottom = `${Math.max(0, innerHeight - bounds.bottom)}px`;
}

function beforeSwap(event: Event) {
  clearTransition();
  const swap = event as BeforeSwapEvent;
  if (swap.signal.aborted || !motionAllowed()) {
    // Skipping intentionally rejects ready, before the animation handlers below are attached.
    void swap.viewTransition.ready.catch(() => {});
    swap.viewTransition.skipTransition();
    return;
  }
  const overlay = swap.newDocument.querySelector<HTMLElement>('#page-pixels');
  const workspace = document.querySelector<HTMLElement>('#page-scroll');
  if (!overlay || !workspace || typeof overlay.animate !== 'function') return;

  // Preparation has finished: never obscure the existing page while a request is loading.
  positionOverlay(overlay, workspace);
  overlay.hidden = false;
  const active: ActiveTransition = {
    overlay,
    signal: swap.signal,
    transition: swap.viewTransition,
    abort: () => { if (activeTransition === active) clearTransition(); },
    animations: [],
  };
  activeTransition = active;
  active.signal.addEventListener('abort', active.abort, { once: true });

  void active.transition.ready.then(() => {
    if (activeTransition !== active) return;
    const nextWorkspace = document.querySelector<HTMLElement>('#page-scroll');
    if (!overlay.isConnected || !nextWorkspace || !motionAllowed()) {
      clearTransition();
      return;
    }
    positionOverlay(overlay, nextWorkspace);
    const delay = typeof document.startViewTransition === 'function' ? 110 : 0;
    overlay.querySelectorAll<HTMLElement>('.page-pixels__layer').forEach((layer, index) => {
      active.animations.push(layer.animate([
        { opacity: 0, offset: 0 },
        { opacity: .18, offset: .18 },
        { opacity: 0, offset: 1 },
      ], { duration: 220 - index * 20, delay, easing: 'ease-out', fill: 'both' }));
    });
    // A fallback browser has already faded the old DOM before the swap.
    active.animations.push(nextWorkspace.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 220,
      delay,
      easing: 'ease-out',
      fill: 'both',
    }));
    void Promise.allSettled(active.animations.map((animation) => animation.finished)).then(() => {
      if (activeTransition === active) clearTransition(false);
    });
  }, () => {
    if (activeTransition === active) clearTransition(false);
  });
  void active.transition.finished.catch(() => {
    if (activeTransition === active) clearTransition(false);
  });
}

function updateMotionPolicy() {
  if (!motionAllowed()) clearTransition();
}

// One lifetime per document; no animation loops, timers, or route-specific listeners.
const motionObserver = new MutationObserver(updateMotionPolicy);
motionObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
reducedMotion.addEventListener('change', updateMotionPolicy);
forcedColors.addEventListener('change', updateMotionPolicy);
document.addEventListener('astro:before-preparation', (event) => {
  clearTransition();
  if (typeof document.startViewTransition === 'function' || !motionAllowed()) return;
  const preparation = event as PreparationEvent;
  const loader = preparation.loader;
  preparation.loader = async () => {
    await loader();
    if (preparation.signal.aborted || !motionAllowed()) return;
    const workspace = document.querySelector<HTMLElement>('#page-scroll');
    if (!workspace) return;
    const animation = workspace.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 110, easing: 'ease-in', fill: 'forwards' });
    preparationAnimation = animation;
    const abort = () => animation.cancel();
    preparation.signal.addEventListener('abort', abort, { once: true });
    try { await animation.finished; } catch { /* Superseded navigation keeps its original content. */ }
    finally { preparation.signal.removeEventListener('abort', abort); }
  };
});
document.addEventListener('astro:before-swap', beforeSwap);
document.addEventListener('astro:after-swap', () => {
  const workspace = document.querySelector<HTMLElement>('#page-scroll');
  if (activeTransition && workspace) positionOverlay(activeTransition.overlay, workspace);
});
document.addEventListener('gwenlium:chrome-change', () => {
  const workspace = document.querySelector<HTMLElement>('#page-scroll');
  if (activeTransition && workspace) positionOverlay(activeTransition.overlay, workspace);
});
window.addEventListener('resize', () => clearTransition());
window.addEventListener('pagehide', () => clearTransition());

export {};
