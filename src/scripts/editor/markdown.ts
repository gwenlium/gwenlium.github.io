import { marked } from 'marked';
import DOMPurify from 'dompurify';

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

export function renderMarkdownPreview(markdown: string, resolveMedia?: (url: string) => string): DocumentFragment {
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
  for (const element of fragment.querySelectorAll<HTMLElement>('[href], [src], [poster], audio, video')) {
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
    if (element instanceof HTMLMediaElement) {
      element.controls = true;
      element.preload = 'none';
    }
  }
  return fragment;
}
