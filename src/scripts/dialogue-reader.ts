import type { TypewriterRevealDetail } from './typewriter';
import { animateWindow, cancelWindowAnimation } from './window-motion';
import { playInterfaceSound } from './interface-audio';
import { initializeEntryMedia } from './entry-media';

type Reader = { setEnabled: (enabled: boolean) => void; content: HTMLElement; leave: () => void; dispose: () => void };
type Chunk = { blocks: HTMLElement[]; scene?: HTMLElement[]; mediaId?: string };

const readers = new Map<HTMLElement, Reader>();
const lifetime = new AbortController();
const listenerOptions = { signal: lifetime.signal };
const pairedDesktop = window.matchMedia('(min-width: 1000px)');

function fragmentTarget(hash = location.hash): HTMLElement | null {
  if (!hash) return null;
  try { return document.getElementById(decodeURIComponent(hash.slice(1))); }
  catch { return null; }
}

function scrollReaderTarget(root: HTMLElement, target: HTMLElement, block: 'start' | 'nearest' = 'start') {
  if (!root.dataset.dialogueMedia || !pairedDesktop.matches) {
    target.scrollIntoView({ block, behavior: 'instant' });
    return;
  }
  // Scroll only the target's window, including after either companion is portaled.
  // Titlebar controls already stay visible; scrolling their ancestors moves the desktop.
  const body = target.closest<HTMLElement>('.window-body');
  if (!body) return;
  const bounds = body.getBoundingClientRect();
  const targetBounds = target.getBoundingClientRect();
  const padding = getComputedStyle(body);
  const margin = getComputedStyle(target);
  const top = targetBounds.top - bounds.top - body.clientTop
    - (parseFloat(padding.scrollPaddingTop) || 0) - (parseFloat(margin.scrollMarginTop) || 0);
  const bottom = targetBounds.bottom - bounds.top - body.clientTop - body.clientHeight
    + (parseFloat(padding.scrollPaddingBottom) || 0) + (parseFloat(margin.scrollMarginBottom) || 0);
  const offset = block === 'start' || top < 0 ? top : Math.max(0, bottom);
  if (offset) body.scrollBy({ top: offset, behavior: 'instant' });
}

function isIllustration(block: HTMLElement): boolean {
  if (!(block.matches('img') || block.querySelector('img')) || block.querySelector('video, audio, iframe')) return false;
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node.textContent?.trim() && !node.parentElement?.closest('figcaption, script, style, noscript, [aria-hidden="true"]')) return false;
  }
  return true;
}

function collectChunks(sources: HTMLElement[]): Chunk[] {
  const blocks = sources.flatMap(source => {
    // Raw, unwrapped HTML text (or SVG) stays together rather than being lost or copied.
    if (Array.from(source.childNodes).some(node => node instanceof Text && node.data.trim())
      || Array.from(source.children).some(node => !(node instanceof HTMLElement))) return [source];
    return Array.from(source.children).filter((node): node is HTMLElement => node instanceof HTMLElement
      && !node.matches('script, style, noscript, template, [hidden]'));
  });
  const chunks: Chunk[] = [];
  let headings: HTMLElement[] = [];
  let scene: HTMLElement[] | undefined;
  let mediaId: string | undefined;
  for (const block of blocks) {
    const isHeading = block.matches('h1, h2, h3, h4, h5, h6');
    if (isHeading) {
      scene = undefined;
      mediaId = undefined;
    }
    if (block.hasAttribute('data-entry-media-ref')) mediaId = block.dataset.entryMediaRef || undefined;
    for (const marker of block.querySelectorAll<HTMLElement>('[data-entry-media-ref]')) {
      mediaId = marker.dataset.entryMediaRef || undefined;
    }
    if (block.hasAttribute('data-entry-media-only')) continue;
    if (isHeading) {
      headings.push(block);
    } else if (block.matches('figcaption') && !headings.length && chunks.length) {
      const previous = chunks[chunks.length - 1];
      previous.blocks.push(block);
      previous.mediaId = mediaId;
      if (previous.scene && previous.blocks.includes(previous.scene[0])) previous.scene.push(block);
    } else {
      // A standalone picture establishes the scene; mixed text/media stays one authored passage.
      if (isIllustration(block)) scene = [block];
      else if (block.querySelector('img, video, audio, iframe')) scene = undefined;
      chunks.push({ blocks: [...headings, block], scene, mediaId });
      headings = [];
    }
  }
  if (headings.length) {
    if (chunks.length) chunks[chunks.length - 1].blocks.push(...headings);
    else chunks.push({ blocks: headings });
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
  const viewerId = root.dataset.dialogueMedia;
  const sources = Array.from(content.querySelectorAll<HTMLElement>('[data-dialogue-blocks]'));
  const chunks = collectChunks(sources);
  if (chunks.length <= 1) {
    option.hidden = true;
    heading.hidden = true;
    controls.hidden = true;
    return;
  }
  const blocks = chunks.flatMap(chunk => chunk.blocks);
  const events = new AbortController();
  const { signal } = events;
  const hiddenBlocks = new Set<HTMLElement>();
  let active = false;
  let index = 0;
  let finishMotion: Promise<boolean> | undefined;
  let scene: HTMLElement[] | undefined;
  let mediaId: string | undefined;

  function publishMediaScene(active: boolean, itemId?: string) {
    if (!viewerId) return;
    document.dispatchEvent(new CustomEvent('gwenlium:entry-media-scene', {
      detail: { viewerId, itemId, active },
    }));
  }

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
    const chunk = chunks[position];
    const visibleBlocks = chunk.scene ? Array.from(new Set([...chunk.scene, ...chunk.blocks])) : chunk.blocks;
    const sceneChanged = scene !== chunk.scene;
    const mediaChanged = !active || mediaId !== chunk.mediaId;
    mediaId = chunk.mediaId;
    if (sceneChanged) {
      if (scene) delete scene[0].dataset.dialogueScene;
      scene = chunk.scene;
      if (scene) scene[0].dataset.dialogueScene = '';
    }
    index = position;
    active = true;
    restoreBlocks();
    root.dataset.dialogueActive = '';
    option!.hidden = true;
    heading!.hidden = false;
    controls!.hidden = false;
    for (const block of blocks) {
      if (!visibleBlocks.includes(block)) hideBlock(block);
    }
    for (const source of sources) {
      if (!visibleBlocks.some(block => source.contains(block))) hideBlock(source);
    }
    // Advancing never leaves an invisible video/audio playing, and revisiting never autoplays it.
    content!.querySelectorAll<HTMLMediaElement>('video, audio').forEach(media => {
      if (media.closest('[data-dialogue-hidden]')) media.pause();
    });
    if (mediaChanged) publishMediaScene(true, mediaId);
    const last = index === chunks.length - 1;
    back!.disabled = index === 0;
    nextLabel!.textContent = last ? 'Finish' : 'Continue';
    next!.toggleAttribute('data-dialogue-finish', last);
    progress!.textContent = `${index + 1} of ${chunks.length}`;
    if (focusNext || (document.activeElement === back && back!.disabled)) next!.focus({ preventScroll: true });
    if (scroll) scrollReaderTarget(root, root);
    content!.dispatchEvent(new CustomEvent<TypewriterRevealDetail>('gwenlium:typewriter-reveal', {
      bubbles: true, detail: { blocks: sceneChanged ? visibleBlocks : chunk.blocks },
    }));
  }

  function leave(focus = false) {
    cancelWindowAnimation(root);
    finishMotion = undefined;
    root.inert = false;
    if (scene) delete scene[0].dataset.dialogueScene;
    scene = undefined;
    mediaId = undefined;
    publishMediaScene(false);
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
      scrollReaderTarget(root, option!, 'nearest');
    }
  }

  async function finishDialogue() {
    if (!active || finishMotion) return;
    playInterfaceSound('finish');
    root.inert = true;
    const motion = animateWindow(root, 'close');
    finishMotion = motion;
    const completed = await motion;
    if (finishMotion !== motion) return;
    finishMotion = undefined;
    root.inert = false;
    if (completed) leave(true);
  }

  enter.addEventListener('click', () => {
    const target = fragmentTarget();
    const linkedChunk = target ? chunks.findIndex(chunk => chunk.blocks.some(block => block.contains(target))
      || (chunk.mediaId && document.getElementById(chunk.mediaId)?.contains(target))) : -1;
    showChunk(Math.max(0, linkedChunk), true);
  }, { signal });
  back.addEventListener('click', () => { if (active && index > 0) showChunk(index - 1); }, { signal });
  next.addEventListener('click', () => {
    if (!active) return;
    if (index === chunks.length - 1) void finishDialogue();
    else showChunk(index + 1);
  }, { signal });
  exit.addEventListener('click', () => {
    playInterfaceSound('close');
    leave(true);
  }, { signal });
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
  for (const [root, reader] of readers) {
    const viewerId = root.dataset.dialogueMedia;
    const viewer = viewerId ? document.getElementById(viewerId) : null;
    if (!reader.content.contains(target) && !viewer?.contains(target)) continue;
    reader.leave();
    if (scroll) scrollReaderTarget(root, target);
  }
}

function initializeReaders() {
  initializeEntryMedia();
  const enabled = document.documentElement.dataset.dialogue === 'on' || new URLSearchParams(location.search).get('dialogue') === '1';
  for (const [root, reader] of readers) {
    if (!root.isConnected) { reader.dispose(); readers.delete(root); }
  }
  // Restored floating windows can live outside main; bind to their original nodes.
  document.querySelectorAll<HTMLElement>('[data-dialogue-reader]').forEach(root => {
    const existing = readers.get(root);
    const reader = existing ?? createReader(root);
    if (!reader) return;
    if (!existing) readers.set(root, reader);
    // Finish and Read all apply to one visit, including retained/back-forward page nodes.
    reader.setEnabled(enabled);
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

function navigateHistory(event: HashChangeEvent) {
  const from = new URL(event.oldURL);
  const to = new URL(event.newURL);
  // Page navigation restores its own reader; only fragment history reveals the full current page.
  if (from.pathname !== to.pathname || from.search !== to.search) return;
  for (const reader of readers.values()) reader.leave();
  revealFragment(fragmentTarget(), true);
}
window.addEventListener('hashchange', navigateHistory, listenerOptions);
window.addEventListener('pagehide', disposeReaders, listenerOptions);
window.addEventListener('pageshow', initializeReaders, listenerOptions);
document.addEventListener('astro:before-swap', disposeReaders, listenerOptions);
document.addEventListener('astro:page-load', initializeReaders, listenerOptions);
initializeReaders();

if (import.meta.hot) import.meta.hot.dispose(() => {
  lifetime.abort();
  disposeReaders();
});
