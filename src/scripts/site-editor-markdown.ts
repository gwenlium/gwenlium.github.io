import { marked } from 'marked';
import DOMPurify from 'dompurify';
import '../styles/site-editor-markdown.css';

export type MarkdownEditorOptions = {
  value: string;
  onChange: (value: string) => void;
  chooseImage: (file?: File) => Promise<{ src: string; alt: string } | undefined>;
  resolveMedia: (url: string) => string;
};

export type MarkdownEditorHandle = {
  getValue(): string;
  setValue(value: string): void;
  focus(): void;
  destroy(): void;
};

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

export function mountMarkdownEditor(container: HTMLElement, options: MarkdownEditorOptions): MarkdownEditorHandle {
  const lifetime = new AbortController();
  const listener = { signal: lifetime.signal };
  const root = document.createElement('div');
  root.className = 'site-markdown-editor';
  root.innerHTML = `<div class="site-markdown-editor__toolbar" role="group" aria-label="Markdown formatting">
    <button type="button" data-command="bold" title="Bold (Ctrl or Command B)">Bold</button>
    <button type="button" data-command="italic" title="Italic (Ctrl or Command I)">Italic</button>
    <button type="button" data-command="heading">Heading</button>
    <button type="button" data-command="list">List</button>
    <button type="button" data-command="quote">Quote</button>
    <button type="button" data-command="code">Code</button>
    <button type="button" data-command="link">Link</button>
    <button type="button" data-command="image">Image</button>
    <button type="button" data-command="preview" aria-pressed="false">Preview</button>
  </div>
  <textarea class="site-markdown-editor__input" aria-label="Markdown text" spellcheck="true"></textarea>
  <div class="site-markdown-editor__preview" aria-label="Markdown preview" hidden></div>
  <p class="site-markdown-editor__help">Markdown is preserved as written. Add images with Image or drop a file here; only prepared copies are staged in your private draft.</p>
  <p class="site-markdown-editor__status" role="status" aria-live="polite"></p>`;
  container.append(root);
  const textarea = root.querySelector<HTMLTextAreaElement>('textarea')!;
  const preview = root.querySelector<HTMLElement>('.site-markdown-editor__preview')!;
  const status = root.querySelector<HTMLElement>('[role="status"]')!;
  const imageButton = root.querySelector<HTMLButtonElement>('[data-command="image"]')!;
  const previewButton = root.querySelector<HTMLButtonElement>('[data-command="preview"]')!;
  // Reading textarea.value normalizes newlines. Keep the original source until
  // an actual edit, so mounting/saving does not rewrite unfamiliar Markdown.
  let value = options.value;
  let choosingImage = false;
  let revision = 0;
  textarea.value = value;

  function refreshPreview() {
    if (!preview.hidden) preview.replaceChildren(renderMarkdownPreview(value, options.resolveMedia));
  }

  function changed() {
    value = textarea.value;
    revision++;
    options.onChange(value);
    refreshPreview();
  }

  function replaceSelection(text: string, start = textarea.selectionStart, end = textarea.selectionEnd) {
    textarea.setRangeText(text, start, end, 'end');
    changed();
    textarea.focus();
  }

  async function insertImage(file?: File) {
    if (choosingImage || lifetime.signal.aborted) return;
    choosingImage = imageButton.disabled = true;
    const selection = { start: textarea.selectionStart, end: textarea.selectionEnd, revision };
    status.textContent = 'Choose or prepare an image for your private local draft.';
    try {
      const image = await options.chooseImage(file);
      if (lifetime.signal.aborted) return;
      if (!image) { status.textContent = 'Image selection cancelled.'; return; }
      if (!safeURL(image.src, true)) throw new Error('Choose an image with a safe, permanent media URL.');
      const alt = image.alt.replace(/[\r\n]+/g, ' ').replace(/[\\`*_{}\[\]()#+.!<>]/g, '\\$&');
      const src = image.src.replace(/[<>\\\s"']/g, character => character === "'" ? '%27' : encodeURIComponent(character));
      const markdown = `![${alt}](<${src}>)`;
      if (selection.revision === revision) replaceSelection(markdown, selection.start, selection.end);
      else replaceSelection(markdown);
      status.textContent = 'Image added to the Markdown draft. Publish is a separate action.';
    } catch (error) {
      if (!lifetime.signal.aborted) status.textContent = error instanceof Error ? error.message : 'Could not add this image.';
    } finally {
      choosingImage = imageButton.disabled = false;
      if (!lifetime.signal.aborted) textarea.focus();
    }
  }

  function format(command: string) {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selection = textarea.value.slice(start, end);
    if (command === 'image') { void insertImage(); return; }
    if (command === 'preview') {
      preview.hidden = !preview.hidden;
      previewButton.setAttribute('aria-pressed', String(!preview.hidden));
      refreshPreview();
      return;
    }
    if (command === 'bold' || command === 'italic' || command === 'code') {
      let marker = command === 'bold' ? '**' : command === 'italic' ? '*' : '`';
      if (command === 'code') {
        for (const match of selection.matchAll(/`+/g)) {
          if (match[0].length >= marker.length) marker = '`'.repeat(match[0].length + 1);
        }
      }
      const content = selection || (command === 'code' ? 'code' : 'text');
      const padding = command === 'code' && (content.startsWith('`') || content.endsWith('`')) ? ' ' : '';
      replaceSelection(`${marker}${padding}${content}${padding}${marker}`, start, end);
      if (!selection) textarea.setSelectionRange(start + marker.length, start + marker.length + content.length);
      return;
    }
    if (command === 'heading' || command === 'list' || command === 'quote') {
      const lineStart = start === 0 ? 0 : textarea.value.lastIndexOf('\n', start - 1) + 1;
      const nextLine = textarea.value.indexOf('\n', end);
      const lineEnd = nextLine === -1 ? textarea.value.length : nextLine;
      const prefix = command === 'heading' ? '## ' : command === 'list' ? '- ' : '> ';
      replaceSelection(textarea.value.slice(lineStart, lineEnd).split('\n').map(line => prefix + line).join('\n'), lineStart, lineEnd);
      return;
    }
    if (command === 'link') {
      const url = window.prompt('Link URL', 'https://');
      if (!url) return;
      if (!safeURL(url, false)) { status.textContent = 'Use an http, https, mailto, tel, or relative URL.'; return; }
      const destination = url.replace(/[<>\\\s"']/g, character => character === "'" ? '%27' : encodeURIComponent(character));
      replaceSelection(`[${selection || 'link text'}](<${destination}>)`, start, end);
    }
  }

  textarea.addEventListener('input', changed, listener);
  textarea.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && ['b', 'i'].includes(event.key.toLowerCase())) {
      event.preventDefault();
      format(event.key.toLowerCase() === 'b' ? 'bold' : 'italic');
    }
  }, listener);
  root.querySelector<HTMLElement>('.site-markdown-editor__toolbar')!.addEventListener('click', event => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-command]') : null;
    if (button && !button.disabled && button.dataset.command) format(button.dataset.command);
  }, listener);
  root.addEventListener('dragover', event => {
    if (event.dataTransfer?.types.includes('Files')) {
      event.preventDefault();
      event.dataTransfer.dropEffect = choosingImage ? 'none' : 'copy';
    }
  }, listener);
  root.addEventListener('drop', event => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    const files = event.dataTransfer.files;
    if (files.length !== 1) { status.textContent = 'Add one image at a time so each prepared copy can be reviewed.'; return; }
    void insertImage(files[0]);
  }, listener);
  textarea.addEventListener('paste', event => {
    const file = event.clipboardData?.files[0];
    if (!file) return;
    event.preventDefault();
    void insertImage(file);
  }, listener);

  return {
    getValue: () => value,
    setValue(next: string) {
      if (lifetime.signal.aborted) return;
      value = next;
      revision++;
      textarea.value = next;
      refreshPreview();
    },
    focus() { if (!lifetime.signal.aborted) textarea.focus(); },
    destroy() {
      lifetime.abort();
      preview.replaceChildren();
      root.remove();
    },
  };
}
