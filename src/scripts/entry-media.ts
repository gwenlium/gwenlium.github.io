type SceneDetail = { viewerId: string; itemId?: string; active: boolean };
type Relocation = { node: HTMLElement; marker: HTMLSpanElement; container: HTMLElement };
type Viewer = {
  source: HTMLElement;
  select: (itemId: string) => void;
  reveal: (target: HTMLElement) => HTMLElement | undefined;
  setPrinting: (printing: boolean) => void;
  dispose: () => void;
};

const viewers = new Map<HTMLElement, Viewer>();
const lifetime = new AbortController();
const listenerOptions = { signal: lifetime.signal };

function pauseMedia(root: HTMLElement) {
  root.querySelectorAll<HTMLMediaElement>('video, audio').forEach(media => media.pause());
}

function hasProse(root: HTMLElement): boolean {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node.textContent?.trim() && !node.parentElement?.closest('figcaption, video, audio, script, style, noscript, [data-zoom-video]')) return true;
  }
  return false;
}

function mediaUnit(node: HTMLElement, source: HTMLElement): HTMLElement {
  let unit = node;
  for (let parent = node.parentElement; parent && parent !== source; parent = parent.parentElement) {
    if (parent.matches('figure, picture, [data-media-zoom], .media-video, .media-embed')
      || (parent.matches('a') && !hasProse(parent))) unit = parent;
  }
  return unit;
}

function mediaLabel(node: HTMLElement, index: number): string {
  const image = node.matches('img') ? node : node.querySelector('img');
  const playable = node.matches('video, audio, iframe') ? node : node.querySelector('video, audio, iframe');
  const label = image?.getAttribute('alt') || node.querySelector('figcaption')?.textContent
    || playable?.getAttribute('aria-label') || playable?.getAttribute('title');
  return label?.replace(/\s+/g, ' ').trim().slice(0, 120)
    || `${playable?.tagName === 'VIDEO' ? 'Video' : playable?.tagName === 'AUDIO' ? 'Audio' : playable?.tagName === 'IFRAME' ? 'Embedded media' : 'Image'} ${index + 1}`;
}

function isMediaOnly(block: HTMLElement): boolean {
  if (!block.matches('[data-entry-media-ref]') && !block.querySelector('[data-entry-media-ref]')) return false;
  return !block.textContent?.trim()
    && !block.querySelector('img, picture, video, audio, iframe, svg, canvas, input, select, textarea, button, a[href], [tabindex], [aria-label], hr, table');
}

function createViewer(root: HTMLElement, source: HTMLElement): Viewer | undefined {
  const list = root.querySelector<HTMLElement>('[data-entry-media-items]');
  const controls = root.querySelector<HTMLElement>('[data-entry-media-controls]');
  const previous = root.querySelector<HTMLButtonElement>('[data-entry-media-previous]');
  const next = root.querySelector<HTMLButtonElement>('[data-entry-media-next]');
  const status = root.querySelector<HTMLElement>('[data-entry-media-status]');
  const selection = root.querySelector<HTMLElement>('[data-entry-media-selection]');
  const empty = root.querySelector<HTMLElement>('[data-entry-media-empty]');
  if (!list || !controls || !previous || !next || !status || !selection || !empty) return;

  const events = new AbortController();
  const relocations: Relocation[] = [];
  const inlineItems: HTMLElement[] = [];
  const mediaOnly = new Set<HTMLElement>();
  const reader = source.closest('[data-dialogue-reader]');
  const sources = source.matches('[data-dialogue-blocks]') ? [source] : Array.from(source.querySelectorAll<HTMLElement>('[data-dialogue-blocks]'));
  let inlineIndex = 0;

  function move(node: HTMLElement, container: HTMLElement, item: HTMLElement, blocks: HTMLElement) {
    let block = node;
    while (block.parentElement && block.parentElement !== blocks) block = block.parentElement;
    const marker = document.createElement('span');
    marker.dataset.entryMediaRef = item.id;
    marker.setAttribute('aria-hidden', 'true');
    marker.style.display = 'none';
    node.replaceWith(marker);
    container.append(node);
    relocations.push({ node, marker, container });
    mediaOnly.add(block === node ? marker : block);
  }

  for (const blocks of sources) {
    for (const candidate of blocks.querySelectorAll<HTMLElement>('figure, picture, img, video, audio, iframe')) {
      const excluded = candidate.closest('script, style, noscript, template, [hidden]:not([data-dialogue-hidden])');
      if (!blocks.contains(candidate) || candidate.closest('[data-dialogue-blocks]') !== blocks
        || candidate.closest('[data-dialogue-reader]') !== reader
        || (excluded && blocks.contains(excluded))) continue;
      if (candidate.matches('figure, picture') && !candidate.querySelector('img, video, audio, iframe')) continue;
      const node = mediaUnit(candidate, blocks);
      const caption = !node.matches('figure') && node.nextElementSibling?.matches('figcaption') ? node.nextElementSibling as HTMLElement : undefined;
      const item = document.createElement('div');
      do { item.id = `${root.id}-inline-${++inlineIndex}`; } while (document.getElementById(item.id));
      item.dataset.entryMediaItem = '';
      item.dataset.entryMediaLabel = mediaLabel(node, list.children.length);
      item.setAttribute('role', 'group');
      item.setAttribute('aria-label', `${list.children.length + 1}: ${item.dataset.entryMediaLabel}`);
      list.append(item);
      inlineItems.push(item);

      // Keep a text-bearing link in its paragraph; only its link shell accompanies the media.
      const link = node.parentElement?.closest<HTMLAnchorElement>('a');
      let container: HTMLElement = item;
      if (link && blocks.contains(link)) {
        const shell = link.cloneNode(false) as HTMLAnchorElement;
        shell.removeAttribute('id');
        item.append(shell);
        container = shell;
      }
      move(node, container, item, blocks);
      if (caption) move(caption, item, item, blocks);
    }
  }
  for (const block of mediaOnly) {
    if (isMediaOnly(block)) block.dataset.entryMediaOnly = '';
    else mediaOnly.delete(block);
  }

  const items = Array.from(list.children).filter((item): item is HTMLElement => item instanceof HTMLElement && item.hasAttribute('data-entry-media-item'));
  const autoplay = Array.from(list.querySelectorAll<HTMLMediaElement>('video[autoplay], audio[autoplay]'));
  autoplay.forEach(media => { media.autoplay = false; });
  pauseMedia(list);
  const buttons = items.map((item, index) => {
    const button = document.createElement('button');
    const label = item.dataset.entryMediaLabel || mediaLabel(item, index);
    button.type = 'button';
    button.className = 'button button-secondary';
    button.textContent = String(index + 1);
    button.title = label;
    button.dataset.entryMediaSelect = item.id;
    button.setAttribute('aria-controls', item.id);
    button.setAttribute('aria-label', `Show ${index + 1}: ${label}`);
    button.setAttribute('aria-pressed', 'false');
    selection.append(button);
    item.hidden = true;
    return button;
  });
  let selected = -1;
  let printing = false;

  function show(index: number) {
    if (index < 0 || index >= items.length || index === selected) return;
    if (selected >= 0) {
      pauseMedia(items[selected]);
      items[selected].hidden = true;
      buttons[selected].setAttribute('aria-pressed', 'false');
    }
    selected = index;
    items[index].hidden = false;
    buttons[index].setAttribute('aria-pressed', 'true');
    previous!.disabled = index === 0;
    next!.disabled = index === items.length - 1;
    status!.textContent = `${index + 1} of ${items.length}`;
  }

  function select(itemId: string) {
    const target = document.getElementById(itemId);
    const item = target?.closest<HTMLElement>('[data-entry-media-item]');
    if (item) show(items.indexOf(item));
  }

  function setPrinting(value: boolean) {
    if (printing === value) return;
    printing = value;
    if (printing) {
      pauseMedia(list!);
      for (const relocation of relocations) {
        // The shared media initializer may have wrapped the original picture in a zoom button.
        while (relocation.node.parentElement && relocation.node.parentElement !== relocation.container
          && relocation.container.contains(relocation.node)) relocation.node = relocation.node.parentElement;
        relocation.marker.replaceWith(relocation.node);
      }
      for (const block of mediaOnly) delete block.dataset.entryMediaOnly;
    } else {
      for (const relocation of relocations) {
        relocation.node.replaceWith(relocation.marker);
        relocation.container.append(relocation.node);
      }
      for (const block of mediaOnly) block.dataset.entryMediaOnly = '';
    }
  }

  previous.addEventListener('click', () => show(selected - 1), { signal: events.signal });
  next.addEventListener('click', () => show(selected + 1), { signal: events.signal });
  selection.addEventListener('click', event => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLButtonElement>('[data-entry-media-select]');
    if (button?.dataset.entryMediaSelect) select(button.dataset.entryMediaSelect);
  }, { signal: events.signal });
  controls.hidden = selection.hidden = items.length === 0;
  empty.hidden = items.length > 0;
  root.dataset.entryMediaReady = '';
  show(0);

  return {
    source,
    select,
    setPrinting,
    reveal(target) {
      if (root.contains(target)) {
        const item = target.closest<HTMLElement>('[data-entry-media-item]');
        if (item) select(item.id);
      } else if (source.contains(target) && target !== source && !target.matches('[data-dialogue-blocks]')) {
        const markers = target.matches('[data-entry-media-ref]') ? [target] : Array.from(target.querySelectorAll<HTMLElement>('[data-entry-media-ref]'));
        const itemId = markers[markers.length - 1]?.dataset.entryMediaRef;
        if (itemId) {
          select(itemId);
          if (target.hasAttribute('data-entry-media-only')) return items[selected];
        }
      }
    },
    dispose() {
      events.abort();
      setPrinting(true);
      for (const item of inlineItems) item.remove();
      for (const item of items) item.hidden = false;
      for (const media of autoplay) media.autoplay = true;
      selection.replaceChildren();
      controls.hidden = selection.hidden = empty.hidden = true;
      status.textContent = '';
      delete root.dataset.entryMediaReady;
    },
  };
}

function fragmentTarget(hash = location.hash): HTMLElement | null {
  if (!hash) return null;
  try { return document.getElementById(decodeURIComponent(hash.slice(1))); }
  catch { return null; }
}

function revealFragment(target: HTMLElement | null) {
  if (!target) return;
  for (const viewer of viewers.values()) {
    const relocated = viewer.reveal(target);
    // Native scrolling cannot reach an empty former media block; use its surviving item.
    if (relocated) requestAnimationFrame(() => {
      if (relocated.isConnected) relocated.scrollIntoView({ block: 'nearest' });
    });
  }
}

export function initializeEntryMedia(): void {
  if (document.documentElement.dataset.siteEditing === 'true') {
    disposeViewers();
    return;
  }
  for (const [root, viewer] of viewers) {
    if (!root.isConnected || !viewer.source.isConnected || document.getElementById(root.dataset.entryMediaSource || '') !== viewer.source) {
      viewer.dispose();
      viewers.delete(root);
    }
  }
  let initialized = false;
  document.querySelectorAll<HTMLElement>('[data-entry-media]').forEach(root => {
    if (viewers.has(root)) return;
    const source = document.getElementById(root.dataset.entryMediaSource || '');
    if (!source || root.contains(source)) return;
    const viewer = createViewer(root, source);
    if (viewer) {
      viewers.set(root, viewer);
      initialized = true;
    }
  });
  if (initialized) revealFragment(fragmentTarget());
}

function disposeViewers() {
  for (const viewer of viewers.values()) viewer.dispose();
  viewers.clear();
}

document.addEventListener('gwenlium:entry-media-scene', event => {
  const detail = (event as CustomEvent<SceneDetail>).detail;
  if (!detail?.active || !detail.itemId) return;
  const root = document.getElementById(detail.viewerId);
  if (root) viewers.get(root)?.select(detail.itemId);
}, listenerOptions);
document.addEventListener('click', event => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !(event.target instanceof Element)) return;
  const link = event.target.closest<HTMLAnchorElement>('a[href]');
  if (!link || link.hasAttribute('download') || (link.target && link.target !== '_self')) return;
  const url = new URL(link.href, location.href);
  if (url.origin === location.origin && url.pathname === location.pathname && url.search === location.search) revealFragment(fragmentTarget(url.hash));
}, { ...listenerOptions, capture: true });
window.addEventListener('hashchange', () => revealFragment(fragmentTarget()), listenerOptions);
window.addEventListener('beforeprint', () => {
  for (const [root, viewer] of viewers) {
    root.querySelectorAll<HTMLImageElement>('img[loading="lazy"]').forEach(image => { image.loading = 'eager'; });
    viewer.setPrinting(true);
  }
}, listenerOptions);
window.addEventListener('afterprint', () => { for (const viewer of viewers.values()) viewer.setPrinting(false); }, listenerOptions);
window.addEventListener('pagehide', disposeViewers, listenerOptions);
window.addEventListener('pageshow', initializeEntryMedia, listenerOptions);
document.addEventListener('astro:before-swap', disposeViewers, listenerOptions);
document.addEventListener('astro:page-load', initializeEntryMedia, listenerOptions);
document.addEventListener('gwenlium:editor-mode-changed', initializeEntryMedia, listenerOptions);
initializeEntryMedia();

if (import.meta.hot) import.meta.hot.dispose(() => {
  lifetime.abort();
  disposeViewers();
});
