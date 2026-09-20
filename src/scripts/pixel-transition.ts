type PageViewTransition = {
  ready: Promise<void>;
  finished: Promise<void>;
  skipTransition(): void;
};
type BeforeSwapEvent = Event & {
  signal: AbortSignal;
  viewTransition: PageViewTransition;
};

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const forcedColors = window.matchMedia('(forced-colors: active)');
let activeTransition: PageViewTransition | undefined;

function motionAllowed() {
  const preference = document.documentElement.dataset.motion;
  return preference !== 'reduced' && (preference === 'full' || !reducedMotion.matches) && !forcedColors.matches;
}

function clearTransition() {
  activeTransition?.skipTransition();
  activeTransition = undefined;
}

function updateMotionPolicy() {
  if (!motionAllowed()) clearTransition();
}

const motionObserver = new MutationObserver(updateMotionPolicy);
motionObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
reducedMotion.addEventListener('change', updateMotionPolicy);
forcedColors.addEventListener('change', updateMotionPolicy);
document.addEventListener('astro:before-preparation', clearTransition);
document.addEventListener('astro:before-swap', (event) => {
  clearTransition();
  const swap = event as BeforeSwapEvent;
  const transition = swap.viewTransition;
  // Skipped or superseded native transitions reject ready.
  void transition.ready.catch(() => {});
  if (swap.signal.aborted || !motionAllowed()) {
    transition.skipTransition();
    return;
  }
  activeTransition = transition;
  const abort = () => {
    if (activeTransition === transition) clearTransition();
  };
  swap.signal.addEventListener('abort', abort, { once: true });
  const finish = () => {
    swap.signal.removeEventListener('abort', abort);
    if (activeTransition === transition) activeTransition = undefined;
  };
  void transition.finished.then(finish, finish);
});
window.addEventListener('resize', clearTransition);
window.addEventListener('pagehide', clearTransition);

export {};
