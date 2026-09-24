import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import { Placeholder } from '@tiptap/extensions';
import { Markdown } from '@tiptap/markdown';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

export type RichTextOptions = {
  markdown: string;
  placeholder: string;
  resolveMedia(url: string): string;
  /** Prepare local files and stage them; resolves with the staged picture URLs. */
  addPictures(files: File[]): Promise<string[]>;
  chooseFromLibrary(): Promise<string | undefined>;
  onChange(markdown: string): void;
  onStatus(text: string): void;
  /** Smaller toolbar for editing a block of page text in place. */
  compact?: boolean;
  label: string;
};

export type RichTextHandle = {
  readonly element: HTMLElement;
  getMarkdown(): string;
  focus(): void;
  destroy(): void;
  /** Pictures in the text that still need a description. */
  missingDescriptions(): number;
  focusMissingDescription(): boolean;
  /** The cursor position, to come back to the same place later. */
  cursor(): number;
  restoreCursor(position: number): void;
};

const safeLink = (value: string) => {
  try {
    const url = new URL(value, location.href);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
};

function button(label: string, title: string, command: string): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = 'rt-tool';
  element.dataset.command = command;
  element.innerHTML = label;
  element.title = title;
  element.setAttribute('aria-label', title);
  return element;
}

/** Tidy the serialized Markdown: no placeholder entities for blank lines, one final newline. */
function tidy(markdown: string): string {
  const text = markdown.replace(/^(?:&nbsp;|\u00a0)\s*$/gm, '').replace(/\n{3,}/g, '\n\n').replace(/[ \t]+$/gm, match => (match === '  ' ? match : '')).trim();
  return text ? `${text}\n` : '';
}

export function createRichText(host: HTMLElement, options: RichTextOptions): RichTextHandle {
  const root = document.createElement('div');
  root.className = `rt${options.compact ? ' rt--compact' : ''}`;
  // The site types out new window text; editor controls must appear at once.
  root.dataset.typewriterSkip = '';
  const toolbar = document.createElement('div');
  toolbar.className = 'rt-toolbar';
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', `${options.label} formatting`);
  const block = document.createElement('select');
  block.className = 'rt-block';
  block.setAttribute('aria-label', 'Text style');
  for (const [value, label] of [['paragraph', 'Text'], ['h2', 'Heading'], ['h3', 'Subheading'], ['quote', 'Quote']]) {
    const option = document.createElement('option');
    option.value = value; option.textContent = label;
    block.append(option);
  }
  const tools = [
    button('<b>B</b>', 'Bold (Ctrl+B)', 'bold'),
    button('<i>I</i>', 'Italic (Ctrl+I)', 'italic'),
    button('&bull; List', 'Bulleted list', 'bullets'),
    button('1. List', 'Numbered list', 'numbers'),
    button('Link', 'Add or edit a link (Ctrl+K)', 'link'),
    button('+ Picture', 'Add pictures from this device (or drop or paste them into the text)', 'picture'),
    button('Library', 'Reuse a picture already on the website', 'library'),
  ];
  toolbar.append(block, ...tools);
  const linkForm = document.createElement('form');
  linkForm.className = 'rt-link';
  linkForm.hidden = true;
  linkForm.innerHTML = '<input type="url" inputmode="url" placeholder="https://" aria-label="Link address" required><button type="submit">Apply</button><button type="button" data-remove>Remove link</button><button type="button" data-cancel>Cancel</button>';
  const linkInput = linkForm.querySelector('input')!;
  const surface = document.createElement('div');
  surface.className = 'rt-surface prose';
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.jpg,.jpeg,.png,.webp,.gif';
  fileInput.multiple = true;
  fileInput.hidden = true;
  root.append(toolbar, linkForm, surface, fileInput);
  host.append(root);

  let original = options.markdown;
  let changed = false;
  let adding = 0;

  const DescribedImage = Image.extend({
    renderMarkdown: (node: { attrs?: Record<string, unknown> }) => {
      const alt = String(node.attrs?.alt ?? '').replace(/[\r\n]+/g, ' ').replace(/([\\[\]])/g, '\\$1');
      const src = String(node.attrs?.src ?? '');
      return `![${alt}](${/[\s()<>]/.test(src) ? `<${src.replace(/[<>]/g, encodeURIComponent)}>` : src})`;
    },
    addNodeView() {
      return ({ node: initial, getPos, editor }) => {
        let node: ProseMirrorNode = initial;
        const dom = document.createElement('figure');
        dom.className = 'rt-figure';
        dom.contentEditable = 'false';
        const image = document.createElement('img');
        image.draggable = true;
        const row = document.createElement('div');
        row.className = 'rt-figure__row';
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'rt-figure__alt';
        input.placeholder = 'Describe this picture';
        input.setAttribute('aria-label', 'Picture description');
        input.maxLength = 300;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = 'Remove';
        remove.className = 'rt-figure__remove';
        row.append(input, remove);
        dom.append(image, row);
        const render = () => {
          const src = String(node.attrs.src ?? '');
          if (image.dataset.src !== src) { image.dataset.src = src; image.src = options.resolveMedia(src); }
          image.alt = String(node.attrs.alt ?? '');
          if (document.activeElement !== input) input.value = String(node.attrs.alt ?? '');
          dom.classList.toggle('is-missing', !String(node.attrs.alt ?? '').trim());
        };
        render();
        input.addEventListener('input', () => {
          const position = getPos();
          if (typeof position !== 'number') return;
          editor.view.dispatch(editor.state.tr.setNodeAttribute(position, 'alt', input.value));
          dom.classList.toggle('is-missing', !input.value.trim());
        });
        input.addEventListener('keydown', event => {
          if (event.key === 'Enter') { event.preventDefault(); editor.commands.focus(); }
        });
        remove.addEventListener('click', () => {
          const position = getPos();
          if (typeof position === 'number') editor.chain().focus().deleteRange({ from: position, to: position + node.nodeSize }).run();
        });
        return {
          dom,
          update(updated: ProseMirrorNode) {
            if (updated.type !== node.type) return false;
            node = updated;
            render();
            return true;
          },
          stopEvent(event: Event) { return event.target === input || event.target === remove; },
          ignoreMutation() { return true; },
        };
      };
    },
  });

  const editor = new Editor({
    element: surface,
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
        underline: false,
        codeBlock: false,
        link: { openOnClick: false, autolink: true, linkOnPaste: true, defaultProtocol: 'https', isAllowedUri: url => safeLink(url) },
      }),
      DescribedImage.configure({ inline: false, allowBase64: false }),
      Placeholder.configure({ placeholder: options.placeholder }),
      Markdown,
    ],
    content: options.markdown,
    contentType: 'markdown',
    editorProps: {
      attributes: { 'aria-label': options.label, role: 'textbox', 'aria-multiline': 'true', spellcheck: 'true' },
      handleDrop(view, event, _slice, moved) {
        const files = [...(event.dataTransfer?.files ?? [])];
        if (moved || !files.length) return false;
        event.preventDefault();
        const position = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
        void insertFiles(files, position);
        return true;
      },
      handlePaste(_view, event) {
        const files = [...(event.clipboardData?.files ?? [])];
        if (!files.length) return false;
        event.preventDefault();
        void insertFiles(files);
        return true;
      },
      handleKeyDown(_view, event) {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openLink(); return true; }
        return false;
      },
    },
    onUpdate() {
      changed = true;
      options.onChange(tidy(editor.getMarkdown()));
    },
    onSelectionUpdate: () => sync(),
    onTransaction: () => sync(),
  });

  function sync() {
    const current = editor.isActive('heading', { level: 2 }) ? 'h2' : editor.isActive('heading', { level: 3 }) ? 'h3' : editor.isActive('blockquote') ? 'quote' : 'paragraph';
    if (block.value !== current) block.value = current;
    const states: Record<string, boolean> = {
      bold: editor.isActive('bold'), italic: editor.isActive('italic'), bullets: editor.isActive('bulletList'),
      numbers: editor.isActive('orderedList'), link: editor.isActive('link'),
    };
    for (const tool of tools) {
      const command = tool.dataset.command!;
      if (command in states) tool.setAttribute('aria-pressed', String(states[command]));
      if (command === 'picture' || command === 'library') tool.disabled = adding > 0;
    }
  }

  async function insertFiles(files: File[], position?: number) {
    const pictures = files.filter(file => /^image\//.test(file.type) || /\.(jpe?g|png|webp|gif)$/i.test(file.name));
    if (!pictures.length) { options.onStatus('Only pictures can go into the text. Add video or audio under Media.'); return; }
    adding++; sync();
    try {
      const urls = await options.addPictures(pictures);
      if (!urls.length || editor.isDestroyed) return;
      insertPictures(urls, position);
    } catch (error) {
      options.onStatus(error instanceof Error ? error.message : 'The picture could not be prepared.');
    } finally {
      adding--;
      if (!editor.isDestroyed) sync();
    }
  }

  function insertPictures(urls: string[], position?: number) {
    const nodes = urls.map(src => ({ type: 'image', attrs: { src, alt: '' } }));
    const at = position === undefined ? editor.state.selection.to : Math.min(position, editor.state.doc.content.size);
    editor.chain().focus().insertContentAt(at, nodes).run();
    // Ask for the description right where the picture now is.
    requestAnimationFrame(() => {
      const figures = [...surface.querySelectorAll<HTMLElement>('.rt-figure.is-missing')];
      const target = figures.find(figure => urls.includes(figure.querySelector('img')?.dataset.src ?? ''));
      target?.querySelector<HTMLInputElement>('.rt-figure__alt')?.focus();
      target?.scrollIntoView({ block: 'nearest' });
    });
    options.onStatus(urls.length === 1 ? 'Picture added. Give it a short description.' : `${urls.length} pictures added. Give each a short description.`);
  }

  function openLink() {
    linkForm.hidden = false;
    linkInput.value = String(editor.getAttributes('link').href ?? '');
    linkForm.querySelector<HTMLButtonElement>('[data-remove]')!.hidden = !editor.isActive('link');
    linkInput.focus();
    linkInput.select();
  }

  function closeLink() {
    linkForm.hidden = true;
    editor.commands.focus();
  }

  linkForm.addEventListener('submit', event => {
    event.preventDefault();
    const href = linkInput.value.trim();
    if (!safeLink(href)) { linkInput.setCustomValidity('Use a full web address, like https://example.com'); linkInput.reportValidity(); return; }
    const chain = editor.chain().focus().extendMarkRange('link');
    if (editor.state.selection.empty && !editor.isActive('link')) {
      editor.chain().focus().insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] }).run();
    } else chain.setLink({ href }).run();
    closeLink();
  });
  linkInput.addEventListener('input', () => linkInput.setCustomValidity(''));
  linkInput.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); closeLink(); } });
  linkForm.querySelector('[data-cancel]')!.addEventListener('click', closeLink);
  linkForm.querySelector('[data-remove]')!.addEventListener('click', () => { editor.chain().focus().extendMarkRange('link').unsetLink().run(); closeLink(); });

  block.addEventListener('change', () => {
    const chain = editor.chain().focus();
    if (block.value === 'h2') chain.setNode('heading', { level: 2 }).run();
    else if (block.value === 'h3') chain.setNode('heading', { level: 3 }).run();
    else if (block.value === 'quote') { if (!editor.isActive('blockquote')) chain.setParagraph().toggleBlockquote().run(); }
    else { if (editor.isActive('blockquote')) chain.toggleBlockquote().run(); else chain.setParagraph().run(); }
  });

  toolbar.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-command]') : null;
    if (!target || target.disabled) return;
    const chain = editor.chain().focus();
    switch (target.dataset.command) {
      case 'bold': chain.toggleBold().run(); break;
      case 'italic': chain.toggleItalic().run(); break;
      case 'bullets': chain.toggleBulletList().run(); break;
      case 'numbers': chain.toggleOrderedList().run(); break;
      case 'link': openLink(); break;
      case 'picture': fileInput.click(); break;
      case 'library':
        void options.chooseFromLibrary().then(url => { if (url && !editor.isDestroyed) insertPictures([url]); });
        break;
    }
  });
  fileInput.addEventListener('change', () => {
    const files = [...(fileInput.files ?? [])];
    fileInput.value = '';
    if (files.length) void insertFiles(files);
  });
  sync();

  const figures = () => {
    const found: ProseMirrorNode[] = [];
    editor.state.doc.descendants(node => { if (node.type.name === 'image') found.push(node); });
    return found;
  };

  return {
    element: root,
    getMarkdown: () => (changed ? tidy(editor.getMarkdown()) : original),
    focus: () => editor.commands.focus('end'),
    destroy() {
      editor.destroy();
      root.remove();
      original = '';
    },
    missingDescriptions: () => figures().filter(node => !String(node.attrs.alt ?? '').trim()).length,
    cursor: () => editor.state.selection.from,
    restoreCursor(position: number) {
      if (editor.isDestroyed) return;
      editor.commands.setTextSelection(Math.max(0, Math.min(position, editor.state.doc.content.size)));
      editor.commands.focus(undefined, { scrollIntoView: false });
    },
    focusMissingDescription() {
      const input = surface.querySelector<HTMLInputElement>('.rt-figure.is-missing .rt-figure__alt');
      if (!input) return false;
      input.scrollIntoView({ block: 'center' });
      input.focus();
      return true;
    },
  };
}
