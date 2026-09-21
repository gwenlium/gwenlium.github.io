import type { TypewriterRevealDetail } from './typewriter';

type Reader = { setEnabled: (enabled: boolean) => void; content: HTMLElement; leave: () => void; dispose: () => void };

const readers = new Map<HTMLElement, Reader>();
const lifetime = new AbortController();
const listenerOptions = { signal: lifetime.signal };

function fragmentTarget(hash = location.hash): HTMLElement | null {
  if (!hash) return null;
  try { return document.getElementById(decodeURIComponent(hash.slice(1))); }
  catch { return null; }
}

function collectChunks(sources: HTMLElement[]): HTMLElement[][] {
  const blocks = sources.flatMap(source => {
    // Raw, unwrapped HTML text (or SVG) stays together rather than being lost or copied.
    if (Array.from(source.childNodes).some(node => node instanceof Text && node.data.trim())
      || Array.from(source.children).some(node => !(node instanceof HTMLElement))) return [source];
    return Array.from(source.children).filter((node): node is HTMLElement => node instanceof HTMLElement
      && !node.matches('script, style, noscript, template, [hidden]'));
  });
  const chunks: HTMLElement[][] = [];
  let headings: HTMLElement[] = [];
  for (const block of blocks) {
    if (block.matches('h1, h2, h3, h4, h5, h6')) headings.push(block);
    else if (block.matches('figcaption') && !headings.length && chunks.length) chunks[chunks.length - 1].push(block);
    else {
      chunks.push([...headings, block]);
      headings = [];
    }
  }
  if (headings.length) {
    if (chunks.length) chunks[chunks.length - 1].push(...headings);
    else chunks.push(headings);
  }
  return chunks;
}

function createReader(root: HTMLElement): Reader | undefined {
  const window = root.closest('[data-desktop-window]');
  const option = root.querySelector<HTMLElement>('[data-dialogue-option]') ?? window?.querySelector<HTMLElement>('[data-dialogue-option]');
  const enter = option?.querySelector<HTMLButtonElement>('[data-dialogue-enter]');
  const heading = root.querySelector<HTMLElement>('[data-dialogue-heading]');
  const exit = root.querySelector<HTMLButtonElement>('[data-dialogue-exit]');
  const content = root.querySelector<HTMLElement>('[data-dialogue-content]');
  const controls = root.querySelector<HTMLElement>('[data-dialogue-controls]');
  const back = root.querySelector<HTMLButtonElement>('[data-dialogue-back]');
  const next = root.querySelector<HTMLButtonElement>('[data-dialogue-next]');
  const nextLabel = next?.querySelector<HTMLElement>('[data-dialogue-next-label]');
  const progress = root.querySelector<HTMLElement>('[data-dialogue-progress]');
  if (!option || !enter || !heading || !exit || !content || !controls || !back || !next || !nextLabel || !progress) return;
  const sources = Array.from(content.querySelectorAll<HTMLElement>('[data-dialogue-blocks]'));
  const chunks = collectChunks(sources);
  if (!chunks.length) return;
  const events = new AbortController();
  const { signal } = events;
  const hiddenBlocks = new Set<HTMLElement>();
  let active = false;
  let index = 0;

  function restoreBlocks() {
    for (const block of hiddenBlocks) {
      block.hidden = false;
      delete block.dataset.dialogueHidden;
    }
    hiddenBlocks.clear();
  }

  function hideBlock(block: HTMLElement) {
    if (block.hidden) return;
    block.dataset.dialogueHidden = '';
    block.hidden = true;
    hiddenBlocks.add(block);
  }

  function showChunk(position: number, focusNext = false, scroll = true) {
    index = position;
    active = true;
    restoreBlocks();
    root.dataset.dialogueActive = '';
    option!.hidden = true;
    heading!.hidden = false;
    controls!.hidden = false;
    for (let other = 0; other < chunks.length; other++) {
      if (other !== index) chunks[other].forEach(hideBlock);
    }
    for (const source of sources) {
      if (!chunks[index].some(block => source.contains(block))) hideBlock(source);
    }
    // Advancing never leaves an invisible video/audio playing, and revisiting never autoplays it.
    content!.querySelectorAll<HTMLMediaElement>('video, audio').forEach(media => {
      if (media.closest('[data-dialogue-hidden]')) media.pause();
    });
    const last = index === chunks.length - 1;
    back!.disabled = index === 0;
    nextLabel!.textContent = last ? 'Finish' : 'Continue';
    progress!.textContent = `${index + 1} of ${chunks.length}`;
    if (focusNext || (document.activeElement === back && back!.disabled)) next!.focus({ preventScroll: true });
    if (scroll) heading!.scrollIntoView({ block: 'start', behavior: 'instant' });
    content!.dispatchEvent(new CustomEvent<TypewriterRevealDetail>('gwenlium:typewriter-reveal', {
      bubbles: true, detail: { blocks: chunks[index] },
    }));
  }

  function leave(focus = false) {
    if (!active) return;
    active = false;
    restoreBlocks();
    delete root.dataset.dialogueActive;
    heading!.hidden = true;
    controls!.hidden = true;
    option!.hidden = document.documentElement.dataset.dialogue !== 'on';
    if (focus) {
      option!.hidden = false;
      enter!.focus({ preventScroll: true });
      option!.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    }
  }

  enter.addEventListener('click', () => {
    const target = fragmentTarget();
    const linkedChunk = target ? chunks.findIndex(chunk => chunk.some(block => block.contains(target))) : -1;
    showChunk(Math.max(0, linkedChunk), true);
  }, { signal });
  back.addEventListener('click', () => { if (active && index > 0) showChunk(index - 1); }, { signal });
  next.addEventListener('click', () => {
    if (!active) return;
    if (index === chunks.length - 1) leave(true);
    else showChunk(index + 1);
  }, { signal });
  exit.addEventListener('click', () => leave(true), { signal });
  option.hidden = document.documentElement.dataset.dialogue !== 'on';
  return {
    content, leave,
    setEnabled(enabled) {
      if (enabled) {
        if (!active) showChunk(0, false, false);
      } else {
        leave();
        option.hidden = true;
      }
    },
    dispose() {
      events.abort();
      leave();
      option.hidden = true;
    },
  };
}

function revealFragment(target: HTMLElement | null, scroll = false) {
  if (!target) return;
  for (const reader of readers.values()) {
    if (!reader.content.contains(target)) continue;
    reader.leave();
    if (scroll) target.scrollIntoView({ block: 'start', behavior: 'instant' });
  }
}

function initializeReaders() {
  for (const [root, reader] of readers) {
    if (!root.isConnected) { reader.dispose(); readers.delete(root); }
  }
  // Restored floating windows can live outside main; bind to their original nodes.
  document.querySelectorAll<HTMLElement>('[data-dialogue-reader]').forEach(root => {
    if (readers.has(root)) return;
    const reader = createReader(root);
    if (reader) {
      readers.set(root, reader);
      reader.setEnabled(document.documentElement.dataset.dialogue === 'on' || new URLSearchParams(location.search).get('dialogue') === '1');
    }
  });
  revealFragment(fragmentTarget());
}

document.addEventListener('gwenlium:dialogue-preference', () => {
  const enabled = document.documentElement.dataset.dialogue === 'on';
  for (const reader of readers.values()) reader.setEnabled(enabled);
}, listenerOptions);

function disposeReaders() {
  for (const reader of readers.values()) reader.dispose();
  readers.clear();
}

// Unhide before native fragment navigation, including another click on the current hash.
// Do not intercept links, keyboard shortcuts, or the site's gamepad controls.
document.addEventListener('click', event => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
    || !(event.target instanceof Element)) return;
  const link = event.target.closest<HTMLAnchorElement>('a[href]');
  if (!link || link.hasAttribute('download') || (link.target && link.target !== '_self')) return;
  const url = new URL(link.href, location.href);
  if (url.origin === location.origin && url.pathname === location.pathname && url.search === location.search) {
    revealFragment(fragmentTarget(url.hash));
  }
}, { ...listenerOptions, capture: true });

function navigateHistory() {
  for (const reader of readers.values()) reader.leave();
  revealFragment(fragmentTarget(), true);
}
window.addEventListener('hashchange', navigateHistory, listenerOptions);
window.addEventListener('popstate', navigateHistory, listenerOptions);
window.addEventListener('pagehide', disposeReaders, listenerOptions);
window.addEventListener('pageshow', initializeReaders, listenerOptions);
document.addEventListener('astro:before-swap', disposeReaders, listenerOptions);
document.addEventListener('astro:page-load', initializeReaders, listenerOptions);
initializeReaders();

if (import.meta.hot) import.meta.hot.dispose(() => {
  lifetime.abort();
  disposeReaders();
});
