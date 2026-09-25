import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { mediaKindOf, videoEmbed } from '../../lib/embed.mjs';

// Raw Markdown may link to ordinary web URLs, but only the trusted draft resolver
// may introduce blob URLs. Neither path accepts data URLs or executable schemes.
function safeURL(value: string, media: boolean, localBlob = false): boolean {
  if (!value.trim() || /[\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const url = new URL(value, window.location.href);
    return url.protocol === 'https:' || url.protocol === 'http:'
      || (!media && (url.protocol === 'mailto:' || url.protocol === 'tel:'))
      || (media && localBlob && url.protocol === 'blob:' && url.origin === window.location.origin);
  } catch {
    return false;
  }
}

/** `mediaInfo` says which prepared videos are animations (looping, muted, no controls) and their stills. */
export function renderMarkdownPreview(markdown: string, resolveMedia?: (url: string) => string, mediaInfo?: (url: string) => { loop?: true; poster?: string } | undefined): DocumentFragment {
  const fragment = DOMPurify.sanitize(marked.parse(markdown, { async: false }), {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: [
      'p', 'br', 'hr', 'div', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'blockquote', 'pre', 'code', 'strong', 'b', 'em', 'i', 'del', 's', 'u',
      'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'a', 'img', 'figure', 'figcaption',
      'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
      'sup', 'sub', 'details', 'summary', 'audio', 'video', 'source', 'picture',
    ],
    ALLOWED_ATTR: [
      'href', 'src', 'alt', 'title', 'width', 'height', 'colspan', 'rowspan',
      'start', 'reversed', 'controls', 'preload', 'poster', 'type', 'loading',
    ],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
  // Same as the site build (rehype-media): prepared video and audio in the picture syntax become
  // players, and a YouTube or Vimeo link alone in a paragraph becomes the embedded player.
  for (const image of fragment.querySelectorAll('img')) {
    const kind = mediaKindOf(image.getAttribute('src') ?? '');
    if (kind === 'image') continue;
    const player = document.createElement(kind);
    player.setAttribute('src', image.getAttribute('src') ?? '');
    if (image.alt) player.setAttribute('aria-label', image.alt);
    const info = kind === 'video' ? mediaInfo?.(image.getAttribute('src') ?? '') : undefined;
    if (info?.loop) player.dataset.animation = '';
    if (info?.poster) player.setAttribute('poster', info.poster);
    image.replaceWith(player);
  }
  for (const paragraph of fragment.querySelectorAll('p')) {
    const parts = [...paragraph.childNodes].filter(child => !(child.nodeType === Node.TEXT_NODE && !child.textContent?.trim()));
    const link = parts.length === 1 && parts[0] instanceof HTMLAnchorElement ? parts[0] : undefined;
    const embed = link && videoEmbed(link.getAttribute('href') ?? '');
    if (!embed) continue;
    const frame = document.createElement('iframe');
    frame.src = embed;
    frame.title = link!.textContent?.trim() && link!.textContent.trim() !== link!.getAttribute('href') ? link!.textContent.trim() : 'Embedded video';
    frame.loading = 'lazy';
    frame.allow = 'fullscreen; picture-in-picture; encrypted-media';
    frame.referrerPolicy = 'strict-origin-when-cross-origin';
    const wrap = document.createElement('div');
    wrap.className = 'media-embed';
    wrap.append(frame);
    paragraph.replaceWith(wrap);
  }
  for (const element of fragment.querySelectorAll<HTMLElement>('[href], a[href], img[src], audio[src], video[src], [poster], audio, video')) {
    if (element instanceof HTMLIFrameElement) continue;
    for (const attribute of ['href', 'src', 'poster']) {
      const source = element.getAttribute(attribute);
      if (source === null) continue;
      const media = attribute !== 'href';
      if (!safeURL(source, media)) {
        element.removeAttribute(attribute);
        continue;
      }
      if (media && resolveMedia) {
        const resolved = resolveMedia(source);
        if (safeURL(resolved, true, true)) element.setAttribute(attribute, resolved);
        else element.removeAttribute(attribute);
      }
    }
    if (element instanceof HTMLAnchorElement) element.rel = 'noopener noreferrer';
    if (element instanceof HTMLImageElement) element.loading = 'lazy';
    if (element instanceof HTMLVideoElement && element.hasAttribute('data-animation')) {
      // Plays like a GIF: muted and looping, without controls.
      Object.assign(element, { muted: true, loop: true, autoplay: true, playsInline: true, controls: false, preload: 'auto' });
    } else if (element instanceof HTMLMediaElement) {
      element.controls = true;
      element.preload = 'none';
    }
  }
  return fragment;
}
