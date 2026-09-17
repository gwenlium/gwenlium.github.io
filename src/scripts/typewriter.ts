import { playInterfaceSound } from './interface-audio';

type Writer = {
  root: HTMLElement;
  output: Text;
  text: string;
  characters: string[];
  position: number;
  inView: boolean;
  visible: boolean;
};

const cadence = 80;
const lifetime = new AbortController();
const listenerOptions = { signal: lifetime.signal };
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const segmenter = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;
const writers = new Map<HTMLElement, Writer>();
let timer = 0;
let suspended = false;

function motionReduced(): boolean {
  const motion = document.documentElement.dataset.motion;
  return motion === 'reduced' || (motion !== 'full' && reducedMotion.matches);
}

function stopTimer(): void {
  window.clearTimeout(timer);
  timer = 0;
}

function finishAll(): void {
  stopTimer();
  for (const writer of writers.values()) writer.output.data = writer.text;
  writers.clear();
  intersectionObserver.disconnect();
}

function updateVisibility(): void {
  // Read every instance before writing any text, avoiding repeated layout flushes.
  for (const writer of writers.values()) {
    if (!writer.root.isConnected) {
      intersectionObserver.unobserve(writer.root);
      writers.delete(writer.root);
      continue;
    }
    writer.visible = writer.inView
      && !writer.root.closest('[hidden], [inert], [aria-hidden="true"]')
      && writer.root.getClientRects().length > 0
      && getComputedStyle(writer.root).visibility === 'visible';
  }
}

function scheduleTick(): void {
  for (const writer of writers.values()) {
    if (writer.visible) {
      timer = window.setTimeout(tick, cadence);
      return;
    }
  }
}

function refresh(): void {
  stopTimer();
  if (motionReduced()) {
    finishAll();
    return;
  }
  if (suspended || document.visibilityState !== 'visible' || !document.hasFocus()) return;
  updateVisibility();
  scheduleTick();
}

function tick(): void {
  timer = 0;
  if (suspended || document.visibilityState !== 'visible' || !document.hasFocus() || motionReduced()) {
    refresh();
    return;
  }
  updateVisibility();
  let audible = false;
  for (const writer of writers.values()) {
    if (!writer.visible) continue;
    const character = writer.characters[writer.position++];
    writer.output.appendData(character);
    if (/\S/u.test(character)) audible = true;
    if (writer.position === writer.characters.length) {
      intersectionObserver.unobserve(writer.root);
      writers.delete(writer.root);
    }
  }
  // Simultaneous headings share one sound, even when both reveal a character.
  if (audible) playInterfaceSound('type');
  scheduleTick();
}

const intersectionObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    const writer = writers.get(entry.target as HTMLElement);
    if (writer) writer.inView = entry.isIntersecting;
  }
  refresh();
});

function bindPage(): void {
  suspended = false;
  for (const root of document.querySelectorAll<HTMLElement>('[data-typewriter]')) {
    // This survives duplicate page-load events and HMR on the same component.
    if (root.hasAttribute('data-typewriter-started')) continue;
    const source = root.querySelector<HTMLElement>('[data-typewriter-source]');
    const target = root.querySelector<HTMLElement>('[data-typewriter-text]');
    if (!source || !target) continue;
    root.setAttribute('data-typewriter-started', '');
    const text = source.textContent ?? '';
    if (!text || motionReduced()) continue;
    const output = target.firstChild instanceof Text
      ? target.firstChild
      : target.appendChild(document.createTextNode(''));
    const characters = segmenter
      ? Array.from(segmenter.segment(text), ({ segment }) => segment)
      : Array.from(text);
    output.data = '';
    writers.set(root, { root, output, text, characters, position: 0, inView: false, visible: false });
    intersectionObserver.observe(root);
  }
  refresh();
}

const motionObserver = new MutationObserver(refresh);
motionObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
reducedMotion.addEventListener('change', refresh, listenerOptions);
document.addEventListener('visibilitychange', refresh, listenerOptions);
document.addEventListener('gwenlium:windows-changed', refresh, listenerOptions);
window.addEventListener('blur', refresh, listenerOptions);
window.addEventListener('focus', refresh, listenerOptions);
window.addEventListener('pagehide', () => { suspended = true; stopTimer(); }, listenerOptions);
window.addEventListener('pageshow', bindPage, listenerOptions);
document.addEventListener('astro:before-swap', () => {
  suspended = true;
  finishAll();
}, listenerOptions);
document.addEventListener('astro:page-load', bindPage, listenerOptions);

bindPage();
if (import.meta.hot) import.meta.hot.dispose(() => {
  lifetime.abort();
  finishAll();
  motionObserver.disconnect();
});
