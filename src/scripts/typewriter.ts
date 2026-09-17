import { playInterfaceSound } from './interface-audio';

type TextRun = { node: Text; text: string; ends: number[]; hidden: Range };
type Writer = {
  root: HTMLElement;
  owner: HTMLElement;
  runs: TextRun[];
  run: number;
  character: number;
  perTick: number;
  point: Range;
  cursor: HTMLElement;
  inView: boolean;
  visible: boolean;
};

const cadence = 80;
const maxTicks = 36; // Keep long windows within roughly three seconds.
const lifetime = new AbortController();
const listenerOptions = { signal: lifetime.signal };
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const forcedColors = matchMedia('(forced-colors: active)');
const segmenter = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
const hiddenText = typeof Highlight !== 'undefined' && 'highlights' in CSS ? new Highlight() : null;
const writers = new Map<HTMLElement, Writer>();
const roots = '[data-typewriter], #main-content [data-desktop-window]:not([data-persistent-window]) > .window-body';
const ignored = 'script, style, noscript, svg, math, input, textarea, select, [contenteditable], [hidden], [aria-hidden="true"], .sr-only, .text-caret';
let timer = 0;
let cursorFrame = 0;
let suspended = false;

if (hiddenText) CSS.highlights.set('gwenlium-untyped', hiddenText);

function motionReduced(): boolean {
  const motion = document.documentElement.dataset.motion;
  return !hiddenText || forcedColors.matches || motion === 'reduced' || (motion !== 'full' && reducedMotion.matches);
}

function finish(writer: Writer): void {
  for (const run of writer.runs) hiddenText?.delete(run.hidden);
  writer.cursor.remove();
  delete writer.root.dataset.typing;
  intersectionObserver.unobserve(writer.root);
  writers.delete(writer.root);
}

function stopTimer(): void {
  clearTimeout(timer);
  timer = 0;
}

function finishAll(): void {
  stopTimer();
  cancelAnimationFrame(cursorFrame);
  cursorFrame = 0;
  for (const writer of writers.values()) finish(writer);
}

function updateVisibility(): void {
  const modal = document.querySelector('dialog:modal');
  for (const writer of writers.values()) {
    if (!writer.root.isConnected) { finish(writer); continue; }
    writer.visible = writer.inView && (!modal || modal.contains(writer.root))
      && !writer.root.closest('[hidden], [inert], [aria-hidden="true"]')
      && getComputedStyle(writer.root).visibility === 'visible';
    if (!writer.visible) writer.cursor.hidden = true;
  }
}

function positionCursors(): void {
  cursorFrame = 0;
  if (suspended || document.visibilityState !== 'visible' || !document.hasFocus()) return;
  let animating = false;
  for (const writer of writers.values()) {
    if (!writer.visible) continue;
    const rect = writer.point.getBoundingClientRect();
    const hit = rect.height > 0 && rect.left >= 0 && rect.left < innerWidth && rect.top >= 0 && rect.bottom <= innerHeight
      ? document.elementFromPoint(rect.left, rect.top + rect.height / 2) : null;
    // Never draw a typing cursor over another window or outside a scrolled pane.
    writer.cursor.hidden = !hit || !writer.root.contains(hit);
    if (!writer.cursor.hidden) {
      const parent = writer.point.startContainer.parentElement;
      writer.cursor.style.cssText = `left:${rect.left}px;top:${rect.top}px;height:${rect.height}px;color:${parent ? getComputedStyle(parent).color : 'inherit'}`;
      if (typeof writer.cursor.showPopover === 'function' && !writer.cursor.matches(':popover-open')) writer.cursor.showPopover();
    }
    animating ||= writer.owner.getAnimations().some(animation => animation.playState === 'running');
  }
  if (animating) queueCursors();
}

function queueCursors(): void {
  if (!cursorFrame && !suspended && writers.size) cursorFrame = requestAnimationFrame(positionCursors);
}

function scheduleTick(): void {
  for (const writer of writers.values()) {
    if (writer.visible) { timer = window.setTimeout(tick, cadence); return; }
  }
}

function refresh(): void {
  stopTimer();
  if (motionReduced()) { finishAll(); return; }
  if (suspended || document.visibilityState !== 'visible' || !document.hasFocus()) {
    for (const writer of writers.values()) writer.cursor.hidden = true;
    return;
  }
  updateVisibility();
  queueCursors();
  scheduleTick();
}

function tick(): void {
  timer = 0;
  if (suspended || document.visibilityState !== 'visible' || !document.hasFocus() || motionReduced()) { refresh(); return; }
  updateVisibility();
  let audible = false;
  for (const writer of writers.values()) {
    if (!writer.visible) continue;
    let remaining = writer.perTick;
    while (remaining > 0 && writers.has(writer.root)) {
      const run = writer.runs[writer.run];
      if (!run.node.isConnected || run.node.data !== run.text) { finish(writer); break; }
      const start = writer.character ? run.ends[writer.character - 1] : 0;
      const count = Math.min(remaining, run.ends.length - writer.character);
      writer.character += count;
      remaining -= count;
      const end = run.ends[writer.character - 1];
      audible ||= /\S/u.test(run.text.slice(start, end));
      run.hidden.setStart(run.node, end);
      writer.point.setStart(run.node, end);
      writer.point.collapse(true);
      if (writer.character === run.ends.length) {
        hiddenText!.delete(run.hidden);
        writer.character = 0;
        if (++writer.run === writer.runs.length) finish(writer);
      }
    }
  }
  // Windows reveal in parallel, with one sound per shared tick, not per window.
  if (audible) playInterfaceSound('type');
  queueCursors();
  scheduleTick();
}

const intersectionObserver = new IntersectionObserver(entries => {
  for (const entry of entries) {
    const writer = writers.get(entry.target as HTMLElement);
    if (writer) writer.inView = entry.isIntersecting;
  }
  refresh();
});

function collectText(root: HTMLElement): TextRun[] {
  const runs: TextRun[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node instanceof Element) return node.matches(ignored) || getComputedStyle(node).display === 'none'
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
      return node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = (node as Text).data;
    const hidden = document.createRange();
    hidden.selectNodeContents(node);
    if (!hidden.getClientRects().length || getComputedStyle(node.parentElement!).visibility === 'hidden') continue;
    let offset = 0;
    const ends = segmenter ? Array.from(segmenter.segment(text), part => part.index + part.segment.length)
      : Array.from(text, character => offset += character.length);
    runs.push({ node: node as Text, text, ends, hidden });
  }
  return runs;
}

function bindPage(): void {
  suspended = false;
  contentObserver.disconnect();
  for (const root of document.querySelectorAll<HTMLElement>(roots)) {
    // The persisted header is already marked; destination window bodies are fresh.
    if (root.hasAttribute('data-typewriter-started')) continue;
    root.setAttribute('data-typewriter-started', '');
    if (motionReduced()) continue;
    const runs = collectText(root);
    if (!runs.length) continue;
    const total = runs.reduce((count, run) => count + run.ends.length, 0);
    const cursor = document.createElement('span');
    cursor.className = 'typing-cursor';
    cursor.setAttribute('aria-hidden', 'true');
    cursor.hidden = true;
    if (typeof cursor.showPopover === 'function') cursor.setAttribute('popover', 'manual');
    document.body.append(cursor);
    const point = document.createRange();
    point.setStart(runs[0].node, 0);
    point.collapse(true);
    for (const run of runs) hiddenText!.add(run.hidden);
    root.dataset.typing = '';
    writers.set(root, { root, owner: root.closest<HTMLElement>('[data-desktop-window]') ?? root,
      runs, run: 0, character: 0, perTick: Math.max(1, Math.ceil(total / maxTicks)), point, cursor, inView: false, visible: false });
    intersectionObserver.observe(root);
  }
  // Live widget updates must remain authoritative, never replaced with stale text.
  const content = document.querySelector('#main-content');
  if (content) contentObserver.observe(content, { subtree: true, childList: true, characterData: true });
  refresh();
}

const contentObserver = new MutationObserver(records => {
  for (const writer of writers.values()) {
    if (records.some(record => writer.root.contains(record.target))) finish(writer);
  }
});
const motionObserver = new MutationObserver(refresh);
motionObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
reducedMotion.addEventListener('change', refresh, listenerOptions);
forcedColors.addEventListener('change', refresh, listenerOptions);
document.addEventListener('visibilitychange', refresh, listenerOptions);
document.addEventListener('gwenlium:windows-changed', refresh, listenerOptions);
document.addEventListener('scroll', queueCursors, { ...listenerOptions, capture: true, passive: true });
document.addEventListener('toggle', event => {
  if (!(event.target instanceof Element) || !event.target.matches('.typing-cursor, .control-caret')) refresh();
}, { ...listenerOptions, capture: true });
// Reveal a window immediately when used; typing never delays clicking or reading a control.
for (const event of ['pointerdown', 'focusin']) {
  document.addEventListener(event, event => {
    if (!(event.target instanceof Node)) return;
    for (const writer of writers.values()) if (writer.root.contains(event.target)) finish(writer);
  }, { ...listenerOptions, capture: true });
}
window.addEventListener('resize', queueCursors, listenerOptions);
window.visualViewport?.addEventListener('resize', queueCursors, listenerOptions);
window.visualViewport?.addEventListener('scroll', queueCursors, listenerOptions);
window.addEventListener('blur', refresh, listenerOptions);
window.addEventListener('focus', refresh, listenerOptions);
window.addEventListener('beforeprint', finishAll, listenerOptions);
window.addEventListener('pagehide', () => { suspended = true; stopTimer(); }, listenerOptions);
window.addEventListener('pageshow', bindPage, listenerOptions);
document.addEventListener('astro:before-swap', () => {
  suspended = true;
  finishAll();
  contentObserver.disconnect();
}, listenerOptions);
document.addEventListener('astro:page-load', bindPage, listenerOptions);

bindPage();
if (import.meta.hot) import.meta.hot.dispose(() => {
  lifetime.abort();
  finishAll();
  contentObserver.disconnect();
  motionObserver.disconnect();
  CSS.highlights?.delete('gwenlium-untyped');
});
