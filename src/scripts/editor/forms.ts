import type { SiteEditorStore } from './store';
import { chooseFromLibrary, stageFiles, type StagedFile } from './media';
import { button, errorText, node } from './ui';

/** Small form pieces shared by the owner's settings and collection dialogs. */

export type Field<T> = { element: HTMLElement; get(): T };

export function textField(label: string, value: string, options: { multiline?: boolean; hint?: string; placeholder?: string; type?: string } = {}): Field<string> {
  const wrap = node('label', undefined, 'writer-field');
  wrap.append(node('span', label, 'writer-field__label'));
  const input = options.multiline ? node('textarea', undefined, 'owner-field') : node('input', undefined, 'owner-field');
  if (input instanceof HTMLTextAreaElement) input.rows = 3;
  else if (options.type) input.type = options.type;
  input.value = value;
  if (options.placeholder) input.placeholder = options.placeholder;
  wrap.append(input);
  if (options.hint) wrap.append(node('p', options.hint, 'owner-hint'));
  return { element: wrap, get: () => input.value };
}

export function checkField(label: string, checked: boolean, hint?: string): Field<boolean> {
  const wrap = node('label', undefined, 'owner-check');
  const box = node('input');
  box.type = 'checkbox';
  box.checked = checked;
  const text = node('span');
  text.append(node('strong', label));
  if (hint) text.append(node('small', hint));
  wrap.append(box, text);
  return { element: wrap, get: () => box.checked };
}

export function selectField(label: string, value: string, options: [string, string][], hint?: string): Field<string> {
  const wrap = node('label', undefined, 'writer-field');
  wrap.append(node('span', label, 'writer-field__label'));
  const select = node('select', undefined, 'owner-field');
  for (const [optionValue, text] of options) { const option = node('option', text); option.value = optionValue; select.append(option); }
  select.value = options.some(([optionValue]) => optionValue === value) ? value : options[0]?.[0] ?? '';
  wrap.append(select);
  if (hint) wrap.append(node('p', hint, 'owner-hint'));
  return { element: wrap, get: () => select.value };
}

export function section(title: string, ...children: HTMLElement[]): HTMLElement {
  const element = node('fieldset', undefined, 'owner-section');
  element.append(node('legend', title), ...children);
  return element;
}

/** Chips with suggestions; Enter or comma adds, Backspace on an empty field removes the last. */
export function topicsField(label: string, initial: string[], suggestions: string[] = []): Field<string[]> {
  let topics = [...initial];
  const field = node('div', undefined, 'writer-field');
  field.append(node('span', label, 'writer-field__label'));
  const chips = node('div', undefined, 'writer-tags');
  const input = node('input', undefined, 'writer-tags__input');
  input.placeholder = 'Add, then Enter';
  input.setAttribute('aria-label', `Add to ${label.toLowerCase()}`);
  const list = node('datalist');
  list.id = `topics-${crypto.randomUUID()}`;
  input.setAttribute('list', list.id);
  for (const suggestion of new Set(suggestions)) list.append(Object.assign(node('option'), { value: suggestion }));
  const render = () => {
    chips.querySelectorAll('.writer-tag').forEach(chip => chip.remove());
    for (const topic of topics) {
      const chip = node('span', undefined, 'writer-tag');
      const remove = button('×', () => { topics = topics.filter(item => item !== topic); render(); }, 'writer-tag__remove');
      remove.setAttribute('aria-label', `Remove ${topic}`);
      chip.append(node('span', topic), remove);
      chips.insertBefore(chip, input);
    }
  };
  const add = () => {
    const topic = input.value.trim().replace(/\s+/g, ' ');
    input.value = '';
    if (topic && !topics.some(item => item.toLowerCase() === topic.toLowerCase())) { topics = [...topics, topic]; render(); }
  };
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ',') { event.preventDefault(); add(); }
    else if (event.key === 'Backspace' && !input.value && topics.length) { topics = topics.slice(0, -1); render(); }
  });
  input.addEventListener('blur', add);
  chips.append(input, list);
  field.append(chips);
  render();
  return { element: field, get: () => { add(); return [...topics]; } };
}

/**
 * A picture (or other media) chooser: preview, replace from this device or the library, remove,
 * and an optional description. Files are prepared and staged the usual way.
 */
export function mediaField(store: SiteEditorStore, label: string, value: { src: string; alt?: string }, options: { kind?: 'image' | 'video' | 'audio'; describe?: boolean; onStatus?: (text: string) => void } = {}): Field<{ src: string; alt: string }> {
  const kind = options.kind ?? 'image';
  let src = value.src;
  const wrap = node('div', undefined, 'writer-field owner-media-field');
  wrap.append(node('span', label, 'writer-field__label'));
  const preview = node('div', undefined, 'owner-media-field__preview');
  const render = () => {
    preview.replaceChildren();
    if (!src) { preview.append(node('span', 'None', 'owner-hint')); return; }
    if (kind === 'image') preview.append(Object.assign(node('img'), { src: store.resolveMedia(src), alt: '' }));
    else if (kind === 'video') preview.append(Object.assign(node('video'), { src: store.resolveMedia(src), muted: true, preload: 'metadata', controls: true }));
    else preview.append(Object.assign(node('audio'), { src: store.resolveMedia(src), preload: 'none', controls: true }));
  };
  const file = node('input');
  file.type = 'file';
  file.hidden = true;
  file.accept = kind === 'image' ? '.jpg,.jpeg,.png,.webp,.gif' : kind === 'video' ? '.mp4,.mov,.m4v,.webm,.mkv' : '.mp3,.wav,.flac,.ogg,.m4a,.aac';
  const status = options.onStatus ?? (() => undefined);
  file.addEventListener('change', () => void (async () => {
    const picked = file.files?.[0];
    file.value = '';
    if (!picked) return;
    try { src = (await stageFiles(store, [picked], status))[0].url; render(); }
    catch (error) { status(errorText(error, 'That file could not be prepared.')); }
  })());
  const actions = node('div', undefined, 'owner-popover__actions owner-popover__actions--start');
  actions.append(
    button(src ? 'Replace…' : 'Choose…', () => file.click(), 'writer-mini'),
    ...(kind === 'image' ? [button('From library', () => void chooseFromLibrary(store, true).then(url => { if (url) { src = url; render(); } }), 'writer-mini')] : []),
    button('Remove', () => { src = ''; render(); }, 'writer-mini writer-mini--danger'),
  );
  const alt = node('input', undefined, 'owner-field');
  alt.value = value.alt ?? '';
  alt.placeholder = kind === 'image' ? 'Describe the picture' : 'What is it?';
  alt.setAttribute('aria-label', `${label} description`);
  wrap.append(preview, actions, ...(options.describe ? [alt] : []), file);
  render();
  return { element: wrap, get: () => ({ src, alt: src ? alt.value.trim() : '' }) };
}

/** A reorderable list: rows can move up and down, be removed, and new rows be added. Each row reports its own value. */
export function listEditor<T>(options: {
  label: string;
  items: T[];
  row: (item: T) => Field<T>;
  create?: () => T | T[] | undefined | Promise<T | T[] | undefined>;
  addLabel?: string;
  empty?: string;
}): Field<T[]> {
  let items = [...options.items];
  let rows: Field<T>[] = [];
  const wrap = node('div', undefined, 'writer-field owner-list');
  wrap.append(node('span', options.label, 'writer-field__label'));
  const list = node('ol', undefined, 'owner-list__items');
  const sync = () => { items = rows.map(row => row.get()); };
  const render = () => {
    list.replaceChildren();
    rows = items.map(item => options.row(item));
    if (!items.length) list.append(node('li', options.empty ?? 'Nothing yet.', 'owner-hint'));
    rows.forEach((row, index) => {
      const item = node('li', undefined, 'owner-list__row');
      const controls = node('div', undefined, 'owner-list__controls');
      const move = (to: number) => { sync(); [items[to], items[index]] = [items[index], items[to]]; render(); };
      if (index > 0) controls.append(Object.assign(button('↑', () => move(index - 1), 'writer-mini'), { title: 'Move up', ariaLabel: 'Move up' }));
      if (index < rows.length - 1) controls.append(Object.assign(button('↓', () => move(index + 1), 'writer-mini'), { title: 'Move down', ariaLabel: 'Move down' }));
      controls.append(button('Remove', () => { sync(); items.splice(index, 1); render(); }, 'writer-mini writer-mini--danger'));
      item.append(row.element, controls);
      list.append(item);
    });
  };
  wrap.append(list);
  if (options.create) {
    const add = button(options.addLabel ?? '+ Add', () => void (async () => {
      add.disabled = true;
      try {
        const created = await options.create!();
        if (created !== undefined) { sync(); items = [...items, ...(Array.isArray(created) ? created : [created])]; render(); }
      } finally { add.disabled = false; }
    })(), 'owner-button');
    wrap.append(add);
  }
  render();
  return { element: wrap, get: () => { sync(); return [...items]; } };
}

export type Link = { label: string; url: string };

export function linksEditor(label: string, links: Link[]): Field<Link[]> {
  return listEditor<Link>({
    label, items: links.map(link => ({ ...link })), addLabel: '+ Add link', empty: 'No links yet.',
    create: () => ({ label: '', url: 'https://' }),
    row: link => {
      const row = node('div', undefined, 'owner-link-row');
      const text = node('input', undefined, 'owner-field');
      text.value = link.label; text.placeholder = 'Label'; text.setAttribute('aria-label', 'Link label');
      const url = node('input', undefined, 'owner-field');
      url.value = link.url; url.placeholder = 'https://'; url.type = 'url'; url.setAttribute('aria-label', 'Link address');
      row.append(text, url);
      return { element: row, get: () => ({ label: text.value.trim(), url: url.value.trim() }) };
    },
  });
}

/** Ask for local files of a kind and stage them; resolves with the staged files. */
export function pickFiles(store: SiteEditorStore, accept: string, multiple: boolean, onStatus: (text: string) => void): Promise<StagedFile[]> {
  const { promise, resolve } = Promise.withResolvers<StagedFile[]>();
  const input = node('input');
  input.type = 'file';
  input.accept = accept;
  input.multiple = multiple;
  input.addEventListener('change', () => void (async () => {
    const files = [...(input.files ?? [])];
    if (!files.length) { resolve([]); return; }
    try { resolve(await stageFiles(store, files, onStatus)); }
    catch (error) { onStatus(errorText(error, 'That file could not be prepared.')); resolve([]); }
  })());
  input.addEventListener('cancel', () => resolve([]));
  input.click();
  return promise;
}
