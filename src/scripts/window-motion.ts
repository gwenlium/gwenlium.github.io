type WindowMotionPhase = 'open' | 'close' | 'minimize' | 'restore';

const activeAnimations = new Map<HTMLElement, Animation>();
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const forcedColors = window.matchMedia('(forced-colors: active)');

function motionAllowed() {
  const preference = document.documentElement.dataset.motion;
  return preference !== 'reduced' && (preference === 'full' || !reducedMotion.matches) && !forcedColors.matches;
}

export function cancelWindowAnimation(element: HTMLElement): void {
  const animation = activeAnimations.get(element);
  activeAnimations.delete(element);
  animation?.cancel();
}

/** Callers own visibility and state; a superseded or cancelled motion never commits them. */
export async function animateWindow(element: HTMLElement, phase: WindowMotionPhase, anchor?: HTMLElement): Promise<boolean> {
  const previous = activeAnimations.get(element);
  const interrupted = previous ? getComputedStyle(element) : null;
  const currentTransform = interrupted?.transform;
  const currentOpacity = interrupted?.opacity;
  cancelWindowAnimation(element);

  if (!element.isConnected) return false;
  if (!motionAllowed() || typeof element.animate !== 'function') return true;

  const rect = element.getBoundingClientRect();
  const target = anchor?.isConnected ? anchor.getBoundingClientRect() : null;
  const anchored = target && target.width > 0 && target.height > 0;
  const resting = getComputedStyle(element);
  const baseTransform = resting.transform === 'none' ? '' : `${resting.transform} `;
  const atRest = `${baseTransform}translate(0, 0) scale(1)`;
  const towardAnchor = anchored
    ? `${baseTransform}translate(${target.left + target.width / 2 - rect.left - rect.width / 2}px, ${target.top + target.height / 2 - rect.top - rect.height / 2}px) scale(.18)`
    : `${baseTransform}translate(0, 24px) scale(.92)`;
  const opening = phase === 'open' || phase === 'restore';
  const compact = phase === 'minimize' || (phase === 'restore' && anchored)
    ? towardAnchor
    : `${baseTransform}translate(0, ${opening ? 12 : 10}px) scale(${opening ? '.96' : '.94'})`;
  const from: Keyframe = {
    transform: currentTransform && currentTransform !== 'none' ? currentTransform : opening ? compact : atRest,
    opacity: currentOpacity ?? (opening ? 0 : resting.opacity),
    transformOrigin: '50% 50%',
  };
  const to: Keyframe = {
    transform: opening ? atRest : compact,
    opacity: opening ? resting.opacity : 0,
    transformOrigin: '50% 50%',
  };
  const animation = element.animate([from, to], {
    duration: phase === 'minimize' ? 230 : opening ? 240 : 170,
    easing: opening ? 'cubic-bezier(.2, .8, .2, 1)' : 'cubic-bezier(.4, 0, .7, .2)',
    fill: 'both',
  });
  activeAnimations.set(element, animation);

  try {
    await animation.finished;
    return activeAnimations.get(element) === animation && element.isConnected;
  } catch {
    return false;
  } finally {
    if (activeAnimations.get(element) === animation) activeAnimations.delete(element);
    // WAAPI owns the temporary presentation, so no inline transforms survive a motion.
    animation.cancel();
  }
}

function cancelAll() {
  for (const element of activeAnimations.keys()) cancelWindowAnimation(element);
}

function updateMotionPolicy() {
  if (motionAllowed()) return;
  // Finishing, rather than cancelling, lets the caller commit its requested state.
  for (const animation of activeAnimations.values()) animation.finish();
}

const motionObserver = new MutationObserver(updateMotionPolicy);
motionObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
reducedMotion.addEventListener('change', updateMotionPolicy);
forcedColors.addEventListener('change', updateMotionPolicy);
document.addEventListener('astro:before-swap', cancelAll);
window.addEventListener('pagehide', cancelAll);
