import type { PreviewRegistry } from '../../lib/editor-types';
import { preparePreview, previewInputKind } from './prepare-media';
import type { PreparedPreview, PreviewInputKind } from './prepare-media';
import '../../styles/media-library.css';

export type PreviewPickerOptions = {
  imagesOnly?: boolean;
  allowMultiple?: boolean;
  value?: string | string[];
  file?: File;
  config?: { multiple?: boolean; kinds?: Array<'image' | 'video' | 'audio'> };
};

export type PreviewPickerSettings = {
  load: () => Promise<{ registry: PreviewRegistry; creator: string }>;
  save: (preview: PreparedPreview) => Promise<string>;
  onInsert: (url: string | string[]) => void;
  onCancel?: () => void;
  resolveURL?: (url: string) => string;
};

const imageExtensions = '.jpg,.jpeg,.png,.webp,.gif';
const videoExtensions = '.mp4,.mov,.m4v,.webm,.mkv,.avi,.ogv,.mpg,.mpeg,.mts,.m2ts';
const audioExtensions = '.mp3,.wav,.flac,.ogg,.oga,.opus,.m4a,.aac,.aif,.aiff,.wma';
let pickerSequence = 0;

export function createPreviewPicker(settings: PreviewPickerSettings) {
  const resolveURL = settings.resolveURL ?? ((url: string) => url);
  const titleId = `media-library-title-${++pickerSequence}`;
  const dialog = document.createElement('dialog');
  dialog.className = 'media-library';
  dialog.setAttribute('aria-labelledby', titleId);
  dialog.innerHTML = `<header><h1 id="${titleId}">Media library</h1><button type="button" data-close aria-label="Close media picker">Close</button></header>
    <p>Originals stay on this device. Images and animations are resized and watermarked; video is watermarked and compressed; audio is converted to MP3. Prepared copies stay in your unpublished changes until you explicitly Publish. Publishing makes those copies public, never the originals.</p>
    <form data-prepare><label>Pictures, GIFs, audio or video<input type="file" data-file required></label>
      <label>Public name (optional)<input data-name pattern="[a-z0-9]+(?:-[a-z0-9]+)*" maxlength="54" placeholder="song-title or artwork-name"></label>
      <fieldset data-length hidden><legend>Prepared copy length</legend>
        <label class="media-library-choice"><input type="radio" name="${titleId}-length" value="preview" data-short checked>Short preview</label>
        <label class="media-library-choice"><input type="radio" name="${titleId}-length" value="full" data-full>Full length</label>
        <p class="media-library-warning" data-full-warning hidden>Publishing will make the complete recording or animation public. Until then the processed copy stays in your unpublished changes. The original is never uploaded. Copies must fit within 32 MiB.</p>
      </fieldset>
      <fieldset data-timing hidden><legend>Preview excerpt</legend><label>Start (seconds)<input data-start type="number" min="0" step="0.01" value="0" required></label><label>Duration (seconds, maximum 60)<input data-duration type="number" min="0.01" max="60" step="0.01" value="30" required></label></fieldset>
      <p class="media-library-help">JPEG, PNG, WebP and GIF up to 256 MiB and 80 megapixels; audio and video up to 128 MiB. GIF/WebP animation is preserved and needs ImageDecoder (current Chrome). Audio and video need WebAssembly. Large files may take time; canceling processing uploads nothing.</p>
      <div class="media-library-actions"><button type="submit" data-convert disabled>Prepare preview</button><button type="button" data-cancel hidden>Cancel processing</button></div>
    </form>
    <p data-status role="status" aria-live="polite"></p><progress data-progress max="1" hidden></progress>
    <section data-preview hidden><h2>Prepared copy</h2><div data-preview-media></div><p data-preview-details></p><button type="button" data-publish>Use copy</button></section>
    <button type="button" data-insert-selection hidden>Use selected pictures</button><section><h2>Existing media</h2><div class="media-library-grid" data-library></div></section>`;
  document.body.append(dialog);
  const lifetime = new AbortController();
  const listener = { signal: lifetime.signal };
  const element = <T extends HTMLElement>(selector: string) => dialog.querySelector<T>(selector)!;
  const form = element<HTMLFormElement>('[data-prepare]');
  const input = element<HTMLInputElement>('[data-file]');
  const name = element<HTMLInputElement>('[data-name]');
  const length = element<HTMLFieldSetElement>('[data-length]');
  const timing = element<HTMLFieldSetElement>('[data-timing]');
  const short = element<HTMLInputElement>('[data-short]');
  const full = element<HTMLInputElement>('[data-full]');
  const fullWarning = element('[data-full-warning]');
  const start = element<HTMLInputElement>('[data-start]');
  const duration = element<HTMLInputElement>('[data-duration]');
  const status = element('[data-status]');
  const progress = element<HTMLProgressElement>('[data-progress]');
  const convert = element<HTMLButtonElement>('[data-convert]');
  const cancel = element<HTMLButtonElement>('[data-cancel]');
  const close = element<HTMLButtonElement>('[data-close]');
  const publish = element<HTMLButtonElement>('[data-publish]');
  const preview = element('[data-preview]');
  const previewMedia = element('[data-preview-media]');
  const previewDetails = element('[data-preview-details]');
  const library = element('[data-library]');
  const insertSelection = element<HTMLButtonElement>('[data-insert-selection]');
  const selected = new Set<string>();
  let options: PreviewPickerOptions = {};
  let controller: AbortController | undefined;
  let inspector: AbortController | undefined;
  let fileKind: PreviewInputKind | undefined;
  let files: File[] = [];
  let prepared: PreparedPreview[] = [];
  let objectURLs: string[] = [];
  let opener: HTMLElement | null = null;
  let saving = false;
  let opening = 0;
  let destroyed = false;
  let inserted = false;
  const isMultiple = () => options.allowMultiple === true;

  function clearPreview() {
    previewMedia.querySelectorAll<HTMLMediaElement>('video, audio').forEach(media => media.pause());
    previewMedia.replaceChildren();
    objectURLs.forEach(url => URL.revokeObjectURL(url));
    objectURLs = [];
    prepared = [];
    preview.hidden = true;
  }

  function dismiss() {
    const wasOpen = dialog.open;
    opening++;
    controller?.abort();
    inspector?.abort();
    controller = inspector = undefined;
    fileKind = undefined;
    files = [];
    input.value = '';
    dialog.querySelectorAll<HTMLMediaElement>('audio, video').forEach(media => media.pause());
    clearPreview();
    dialog.close();
    if (wasOpen && opener?.isConnected) opener.focus({ preventScroll: true });
    if (wasOpen && !inserted) settings.onCancel?.();
  }

  function hide() {
    if (!saving && !destroyed) dismiss();
  }

  function insert(url: string | string[]) {
    if (saving || destroyed || !dialog.open) return;
    inserted = true;
    try {
      settings.onInsert(url);
    } catch (error) {
      inserted = false;
      throw error;
    }
    hide();
  }

  function accepts(kind: PreviewInputKind) {
    const mediaKind = kind === 'animation' ? 'image' : kind;
    return (!(options.imagesOnly || isMultiple()) || mediaKind === 'image')
      && (!options.config?.kinds || options.config.kinds.includes(mediaKind));
  }

  function syncLength() {
    const timed = fileKind !== undefined && fileKind !== 'image';
    length.hidden = !timed;
    length.disabled = Boolean(controller || inspector);
    timing.hidden = !timed || full.checked;
    timing.disabled = timing.hidden || Boolean(controller || inspector);
    fullWarning.hidden = !timed || !full.checked;
    convert.textContent = input.multiple && files.length > 1 ? 'Prepare pictures' : timed && full.checked ? 'Prepare full copy' : 'Prepare preview';
    convert.disabled = !fileKind || Boolean(controller || inspector);
  }

  function renderLibrary(registry: PreviewRegistry) {
    library.replaceChildren();
    const entries = Object.entries(registry.files).filter(([, entry]) => accepts(entry.kind));
    if (!entries.length) { library.textContent = 'No matching media yet.'; return; }
    for (const [url, entry] of entries) {
      const card = document.createElement('div');
      card.className = 'media-library-card';
      if (entry.kind === 'image') {
        const image = document.createElement('img');
        image.src = resolveURL(url);
        image.alt = 'Prepared image preview';
        image.loading = 'lazy';
        card.append(image);
      } else {
        const player = document.createElement(entry.kind === 'audio' ? 'audio' : 'video');
        player.src = resolveURL(url);
        player.controls = true;
        player.preload = 'none';
        card.append(player);
      }
      const label = document.createElement('span');
      label.textContent = `${url.slice('/media/'.length)} - ${entry.kind}${entry.width && entry.height ? ` ${entry.width} × ${entry.height}` : ''}${entry.duration ? ` (${entry.duration.toFixed(1)} seconds)` : ''}`;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = isMultiple() ? (selected.has(url) ? 'Selected' : 'Select picture') : 'Use media';
      if (isMultiple()) button.setAttribute('aria-pressed', String(selected.has(url)));
      button.title = url;
      button.addEventListener('click', () => {
        if (!isMultiple()) { insert(url); return; }
        if (selected.has(url)) selected.delete(url); else selected.add(url);
        button.textContent = selected.has(url) ? 'Selected' : 'Select picture';
        button.setAttribute('aria-pressed', String(selected.has(url)));
        insertSelection.disabled = selected.size === 0;
        insertSelection.textContent = `Use selected pictures (${selected.size})`;
      });
      card.append(label, button);
      library.append(card);
    }
  }

  async function inspectFiles() {
    inspector?.abort();
    inspector = undefined;
    clearPreview();
    fileKind = undefined;
    short.checked = true;
    full.checked = false;
    start.value = '0';
    duration.value = '30';
    syncLength();
    if (!files.length) { status.textContent = ''; return; }
    const abort = new AbortController();
    inspector = abort;
    syncLength();
    cancel.hidden = progress.hidden = false;
    progress.removeAttribute('value');
    status.textContent = 'Checking the file on this device…';
    try {
      const kinds: PreviewInputKind[] = [];
      for (const candidate of files) kinds.push(await previewInputKind(candidate, abort.signal));
      if (abort.signal.aborted || !dialog.open || inspector !== abort) return;
      if (kinds.some(kind => !accepts(kind))) throw new Error('Choose only supported files for this field. Nothing was uploaded.');
      fileKind = kinds.find(kind => kind !== 'image') ?? 'image';
      status.textContent = `${files.length} file(s) ready to prepare${files.length === 1 ? `: ${files[0].name}` : '.'}`;
    } catch (error) {
      if (inspector === abort && dialog.open) {
        status.textContent = abort.signal.aborted ? 'Checking cancelled. Choose a file to try again.' : error instanceof Error ? error.message : 'Could not inspect this file.';
        if (abort.signal.aborted) { input.value = ''; files = []; }
      }
    } finally {
      if (inspector === abort) {
        inspector = undefined;
        cancel.hidden = progress.hidden = true;
        syncLength();
      }
    }
  }

  input.addEventListener('change', () => {
    if (controller || saving) return;
    files = Array.from(input.files ?? []);
    input.required = true;
    void inspectFiles();
  }, listener);
  form.addEventListener('input', event => {
    if (event.target === input || controller || inspector) return;
    clearPreview();
    status.textContent = '';
    syncLength();
  }, listener);
  insertSelection.addEventListener('click', () => { if (selected.size) insert([...selected]); }, listener);
  close.addEventListener('click', hide, listener);
  dialog.addEventListener('cancel', event => { event.preventDefault(); hide(); }, listener);
  cancel.addEventListener('click', () => { controller?.abort(); inspector?.abort(); }, listener);

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!files.length || !fileKind || controller || inspector || saving) return;
    clearPreview();
    const abort = new AbortController();
    const request = opening;
    controller = abort;
    convert.disabled = input.disabled = name.disabled = timing.disabled = length.disabled = true;
    cancel.hidden = progress.hidden = false;
    progress.removeAttribute('value');
    status.textContent = 'Preparing on this device for your unpublished changes.';
    try {
      const { creator } = await settings.load();
      if (abort.signal.aborted || request !== opening) return;
      for (const [index, candidate] of files.entries()) {
        status.textContent = `Preparing ${index + 1} of ${files.length}: ${candidate.name}`;
        const kind = await previewInputKind(candidate, abort.signal);
        const result = await preparePreview(candidate, {
          creator, name: name.value.trim() && files.length > 1 ? `${name.value.trim()}-${index + 1}` : name.value.trim(), signal: abort.signal,
          ...(kind === 'image' ? {} : full.checked ? { fullLength: true } : { start: Number(start.value), duration: Number(duration.value) }),
          onProgress(value) {
            if (abort.signal.aborted || request !== opening) return;
            if (value === undefined) progress.removeAttribute('value');
            else progress.value = Math.max(0, Math.min(1, value));
          },
        });
        if (abort.signal.aborted || request !== opening || !dialog.open) return;
        if (!accepts(result.entry.kind)) throw new Error('The prepared media does not match this field. Nothing was uploaded.');
        prepared.push(result);
        const objectURL = URL.createObjectURL(result.file);
        objectURLs.push(objectURL);
        const media = document.createElement(result.entry.kind === 'image' ? 'img' : result.entry.kind);
        media.src = resolveURL(objectURL);
        if (media instanceof HTMLMediaElement) media.controls = true;
        else media.alt = 'Prepared, watermarked image or animation';
        previewMedia.append(media);
      }
      previewDetails.textContent = `${prepared.length} prepared copy/copies. Review each copy before adding it.`;
      publish.textContent = prepared.length > 1 ? `Use ${prepared.length} pictures` : `Use copy`;
      preview.hidden = false;
      status.textContent = 'Check the prepared copy. Nothing is public until you publish, and the original stays on this device.';
      publish.focus();
    } catch (error) {
      if (request === opening && dialog.open) {
        clearPreview();
        status.textContent = abort.signal.aborted ? `Processing cancelled. Nothing was staged.` : error instanceof Error ? error.message : 'Could not prepare this file.';
      }
    } finally {
      if (controller === abort) {
        controller = undefined;
        input.disabled = name.disabled = false;
        syncLength();
        cancel.hidden = progress.hidden = true;
      }
    }
  }, listener);

  publish.addEventListener('click', async () => {
    if (!prepared.length || saving) return;
    saving = true;
    const request = opening;
    close.disabled = publish.disabled = convert.disabled = input.disabled = true;
    form.inert = library.inert = insertSelection.inert = true;
    status.textContent = 'Adding the prepared copies…';
    try {
      const urls: string[] = [];
      for (const [index, item] of prepared.entries()) {
        if (destroyed || request !== opening) return;
        status.textContent = `Adding ${index + 1} of ${prepared.length}…`;
        urls.push(await settings.save(item));
      }
      saving = false;
      if (request === opening) insert(isMultiple() ? urls : urls[0]);
    } catch (error) {
      if (!destroyed && request === opening) status.textContent = `${error instanceof Error ? error.message : 'Adding failed.'} Some prepared copies may already be in your unpublished changes. Nothing was published. Retry to finish; existing copies are reused.`;
    } finally {
      saving = false;
      close.disabled = publish.disabled = input.disabled = false;
      form.inert = library.inert = insertSelection.inert = false;
      syncLength();
    }
  }, listener);

  return {
    async show(next: PreviewPickerOptions = {}): Promise<void> {
      if (destroyed) throw new Error('This media picker has been destroyed.');
      if (dialog.open) return;
      options = next;
      inserted = false;
      selected.clear();
      input.multiple = isMultiple();
      insertSelection.hidden = !isMultiple();
      insertSelection.disabled = true;
      insertSelection.textContent = 'Use selected pictures';
      const request = ++opening;
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      form.reset();
      input.disabled = name.disabled = publish.disabled = close.disabled = false;
      form.inert = true;
      clearPreview();
      files = next.file ? [next.file] : [];
      input.required = !next.file;
      fileKind = undefined;
      cancel.hidden = progress.hidden = true;
      syncLength();
      input.accept = [accepts('image') ? imageExtensions : '', accepts('audio') ? audioExtensions : '', accepts('video') ? videoExtensions : ''].filter(Boolean).join(',');
      library.replaceChildren();
      status.textContent = 'Loading your pictures and media…';
      dialog.showModal();
      try {
        const { registry } = await settings.load();
        if (request !== opening || !dialog.open) return;
        renderLibrary(registry);
        status.textContent = '';
      } catch (error) {
        if (request === opening && dialog.open) status.textContent = error instanceof Error ? error.message : 'Could not load previews.';
      } finally {
        if (request === opening && dialog.open) form.inert = false;
      }
      if (request === opening && dialog.open && files.length) await inspectFiles();
    },
    hide,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      lifetime.abort();
      dismiss();
      dialog.remove();
    },
  };
}
