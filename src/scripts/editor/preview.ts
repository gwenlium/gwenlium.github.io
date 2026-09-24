import { renderMarkdownPreview } from './markdown';
import { ownerStore } from './session';

type PreviewMedia = { type: 'image' | 'video' | 'audio'; src: string; alt: string; caption: string; poster: string };
export type PreviewPayload = {
  path?: string; section: 'devlog' | 'life'; title: string; date: string; tags: string[];
  excerpt: string; body: string; cover: string; coverAlt: string; media: PreviewMedia[];
  /** Where the writer was, so "Back to writing" can step back instead of adding a new page. */
  returnUrl?: string; returnIndex?: number;
};

const key = 'gwenlium:preview';
const dateFormat = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** Hand the draft to the preview page. sessionStorage keeps it for a reload of that tab. */
export function storePreview(payload: PreviewPayload): void {
  sessionStorage.setItem(key, JSON.stringify(payload));
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  return element;
}

/** Elements made here join the layout's scoped styles by carrying its Astro scope attribute. */
function scope(element: Element, reference: Element): void {
  const attribute = [...reference.attributes].find(item => item.name.startsWith('data-astro-cid-'));
  if (attribute) element.setAttribute(attribute.name, '');
}

/** The same ids Astro's Markdown gives headings, so the contents links work. */
function slugger() {
  const seen = new Map<string, number>();
  return (text: string) => {
    const base = text.toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count ? `${base}-${count}` : base;
  };
}

function resolve(url: string): string {
  return ownerStore().resolveMedia(url);
}

/** Mirrors Media.astro, so the media window and zoom treat it like a published item. */
function mediaFigure(item: PreviewMedia, eager: boolean): HTMLElement {
  const figure = node('figure');
  figure.className = `media media--${item.type}`;
  if (item.type === 'image') {
    const picture = node('picture');
    const image = node('img');
    image.alt = item.alt;
    image.loading = eager ? 'eager' : 'lazy';
    image.decoding = 'async';
    image.draggable = false;
    image.dataset.zoom = '';
    image.dataset.zoomCaption = item.caption;
    image.dataset.previewSrc = item.src;
    picture.append(image);
    figure.append(picture);
  } else if (item.type === 'video') {
    const wrap = node('div');
    wrap.className = 'media-video';
    const video = node('video');
    video.controls = true;
    video.playsInline = true;
    video.preload = 'none';
    video.setAttribute('controlslist', 'nodownload');
    video.setAttribute('aria-label', item.alt || item.caption || 'Video');
    video.dataset.mediaVideo = '';
    video.dataset.previewSrc = item.src;
    if (item.poster) video.dataset.previewPoster = item.poster;
    const expand = node('button', 'Expand video');
    expand.type = 'button';
    expand.className = 'media-expand button-secondary';
    expand.dataset.zoomCaption = item.caption;
    expand.dataset.zoomAlt = item.alt;
    expand.dataset.previewZoomVideo = item.src;
    expand.setAttribute('aria-haspopup', 'dialog');
    expand.setAttribute('aria-label', `Expand video${item.alt ? `: ${item.alt}` : ''}`);
    wrap.append(video, expand);
    figure.append(wrap);
  } else {
    const audio = node('audio');
    audio.controls = true;
    audio.preload = 'none';
    audio.setAttribute('aria-label', item.alt || item.caption || 'Audio');
    audio.dataset.previewSrc = item.src;
    figure.append(audio);
  }
  if (item.caption) figure.append(node('figcaption', item.caption));
  return figure;
}

/** Point every draft picture at its file; pictures prepared in this draft live in the browser. */
function resolveSources(root: ParentNode): void {
  for (const element of root.querySelectorAll<HTMLElement>('[data-preview-src]')) {
    const url = resolve(element.dataset.previewSrc!);
    if (element instanceof HTMLImageElement) { element.src = url; element.dataset.fullSrc = url; element.dataset.zoomSrc = url; }
    else if (element instanceof HTMLMediaElement) {
      element.src = url;
      if (element instanceof HTMLVideoElement && element.dataset.previewPoster) element.poster = resolve(element.dataset.previewPoster);
    }
  }
  for (const button of root.querySelectorAll<HTMLElement>('[data-preview-zoom-video]')) button.dataset.zoomVideo = resolve(button.dataset.previewZoomVideo!);
}

function fill(): void {
  const root = document.querySelector<HTMLElement>('[data-entry-preview]');
  if (!root) return;
  let payload: PreviewPayload | undefined;
  try { payload = JSON.parse(sessionStorage.getItem(key) ?? 'null') ?? undefined; } catch { payload = undefined; }
  const note = document.querySelector('[data-preview-note]');
  if (!payload) {
    if (note) note.textContent = 'Nothing to preview here. Open the preview from an entry in the writer.';
    root.hidden = true;
    return;
  }
  document.documentElement.dataset.pageTheme = payload.section;
  document.title = `${payload.title.trim() || 'Untitled entry'} (preview)`;
  const back = document.querySelector<HTMLAnchorElement>('[data-preview-return]');
  if (back) {
    back.href = payload.returnUrl ?? (payload.path ? `/write/?entry=${encodeURIComponent(payload.path)}` : '/write/');
    const returnIndex = payload.returnIndex;
    back.onclick = event => {
      // Straight from the writer: go back, so the browser history does not fill up with previews.
      const index = (history.state as { index?: number } | null)?.index;
      if (typeof returnIndex === 'number' && typeof index === 'number' && index === returnIndex + 1) {
        event.preventDefault();
        history.back();
      }
    };
  }
  const archive = document.querySelector<HTMLAnchorElement>('[data-preview-back-link]');
  if (archive) archive.href = `/${payload.section}/`;

  const date = root.querySelector<HTMLTimeElement>('[data-preview-date]')!;
  const day = new Date(`${payload.date}T00:00:00Z`);
  date.dateTime = payload.date;
  date.textContent = Number.isFinite(day.getTime()) ? dateFormat.format(day) : '';
  root.querySelector('[data-preview-title]')!.textContent = payload.title;

  const tags = root.querySelector<HTMLElement>('[data-preview-tags]')!;
  tags.replaceChildren(...payload.tags.map(tag => {
    const item = node('li');
    const link = node('a', tag);
    link.className = 'tag';
    link.href = `/${payload!.section}/?tag=${encodeURIComponent(tag)}`;
    item.append(link);
    return item;
  }));
  tags.hidden = !payload.tags.length;

  const excerpt = root.querySelector<HTMLElement>('[data-preview-excerpt]')!;
  excerpt.replaceChildren(...payload.excerpt.split(/\n\s*\n/).filter(text => text.trim()).map(text => {
    const paragraph = node('p', text);
    paragraph.className = 'entry-excerpt';
    scope(paragraph, excerpt);
    return paragraph;
  }));
  excerpt.hidden = !payload.excerpt.trim();

  const body = root.querySelector<HTMLElement>('[data-preview-body]')!;
  body.replaceChildren(renderMarkdownPreview(payload.body));
  for (const image of body.querySelectorAll('img')) {
    image.dataset.previewSrc = image.getAttribute('src') ?? '';
    image.decoding = 'async';
    image.dataset.zoom = '';
  }
  const slug = slugger();
  const headings = [...body.querySelectorAll<HTMLHeadingElement>('h2, h3')];
  for (const heading of headings) heading.id = slug(heading.textContent ?? '');
  const contents = root.querySelector<HTMLElement>('[data-preview-contents]')!;
  const list = contents.querySelector('ol')!;
  list.replaceChildren(...headings.map(heading => {
    const item = node('li');
    const link = node('a', heading.textContent ?? '');
    link.href = `#${heading.id}`;
    if (heading.tagName === 'H3') item.className = 'nested';
    scope(item, list);
    scope(link, list);
    item.append(link);
    return item;
  }));
  contents.hidden = headings.length < 2;

  const media = [
    ...(payload.cover ? [{ type: 'image' as const, src: payload.cover, alt: payload.coverAlt, caption: '', poster: '' }] : []),
    ...payload.media,
  ];
  const slot = root.querySelector<HTMLElement>('[data-preview-media]');
  const inline = body.querySelector('img, video, audio, iframe');
  if (slot && !media.length && !inline) {
    // Like a published entry without media: one column, no media window.
    slot.remove();
    root.querySelector('[data-dialogue-reader]')?.removeAttribute('data-dialogue-media');
  } else if (slot) {
    slot.hidden = false;
    const items = slot.querySelector<HTMLElement>('[data-entry-media-items]')!;
    items.replaceChildren(...media.map((item, index) => {
      const label = (item.alt || item.caption || `${item.type === 'video' ? 'Video' : item.type === 'audio' ? 'Audio' : 'Image'} ${index + 1}`).replace(/\s+/g, ' ').trim();
      const wrap = node('div');
      wrap.id = `entry-media-viewer-item-${index + 1}`;
      wrap.dataset.entryMediaItem = '';
      wrap.dataset.entryMediaLabel = label;
      wrap.setAttribute('role', 'group');
      wrap.setAttribute('aria-label', `${index + 1}: ${label}`);
      wrap.append(mediaFigure(item, index === 0 && Boolean(payload!.cover)));
      return wrap;
    }));
  }
  resolveSources(root);
  // On a full page load the media window has already looked at the empty layout: give it a fresh
  // root and let it start again (it restarts on this event, like when page editing turns off).
  const viewer = root.querySelector('[data-entry-media]');
  if (viewer) viewer.replaceWith(viewer.cloneNode(true));
  document.dispatchEvent(new CustomEvent('gwenlium:editor-mode-changed'));
}

// The first visit runs this module after the page swap; later visits come through after-swap.
// Both happen before astro:page-load, when dialogue mode, the media window and typing start.
fill();
document.addEventListener('astro:after-swap', fill);

// After a reload the draft's own pictures need the editor connection before they can show.
void ownerStore().restore().then(connected => {
  const root = document.querySelector<HTMLElement>('[data-entry-preview]');
  if (connected && root) resolveSources(document);
}).catch(() => undefined);
