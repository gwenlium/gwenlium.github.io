import { editorBackend, type PreviewRegistry } from './admin-github';
import { preparePreview, previewInputKind } from './admin-media';
import type { PreparedPreview, PreviewInputKind } from './admin-media';
import '../styles/admin.css';

type PickerOptions = { imagesOnly?: boolean; allowMultiple?: boolean; value?: string | string[]; config?: { multiple?: boolean; kinds?: Array<'image' | 'video' | 'audio'> } };
const imageExtensions = '.jpg,.jpeg,.png,.webp,.gif';
const videoExtensions = '.mp4,.mov,.m4v,.webm,.mkv,.avi,.ogv,.mpg,.mpeg,.mts,.m2ts';
const audioExtensions = '.mp3,.wav,.flac,.ogg,.oga,.opus,.m4a,.aac,.aif,.aiff,.wma';

export const previewMediaLibrary = {
  name: 'gwenlium-previews',
  init({ handleInsert }: { handleInsert: (url: string | string[]) => void }) {
    const dialog = document.createElement('dialog');
    dialog.className = 'admin-media';
    dialog.setAttribute('aria-labelledby', 'admin-media-title');
    dialog.innerHTML = `<header><h1 id="admin-media-title">Media library</h1><button type="button" data-close aria-label="Close media picker">Close</button></header>
      <p>Originals stay on this device. Images and animations are resized and watermarked; video is watermarked and compressed; audio is converted to MP3. Uploaded copies and saved drafts are public.</p>
      <form data-prepare><label>Pictures, GIFs, audio or video<input type="file" data-file required></label>
        <label>Public name (optional)<input data-name pattern="[a-z0-9]+(?:-[a-z0-9]+)*" maxlength="54" placeholder="song-title or artwork-name"></label>
        <fieldset data-length hidden><legend>Publication length</legend>
          <label class="admin-media-choice"><input type="radio" name="admin-media-length" value="preview" data-short checked>Short preview</label>
          <label class="admin-media-choice"><input type="radio" name="admin-media-length" value="full" data-full>Full length</label>
          <p class="admin-media-warning" data-full-warning hidden>The complete recording or animation will be public. Only the processed copy is uploaded, never the original. Copies must fit within 32 MiB.</p>
        </fieldset>
        <fieldset data-timing hidden><legend>Preview excerpt</legend><label>Start (seconds)<input data-start type="number" min="0" step="0.01" value="0" required></label><label>Duration (seconds, maximum 60)<input data-duration type="number" min="0.01" max="60" step="0.01" value="30" required></label></fieldset>
        <p class="admin-media-help">JPEG, PNG, WebP and GIF up to 32 MiB; audio and video up to 128 MiB. GIF/WebP animation is preserved and needs ImageDecoder (current Chrome). Audio and video need WebAssembly. Large files may take time; canceling uploads nothing.</p>
        <div class="admin-media-actions"><button type="submit" data-convert disabled>Prepare preview</button><button type="button" data-cancel hidden>Cancel processing</button></div>
      </form>
      <p data-status role="status" aria-live="polite"></p><progress data-progress max="1" hidden></progress>
      <section data-preview hidden><h2>Prepared copy</h2><div data-preview-media></div><p data-preview-details></p><button type="button" data-publish>Upload and use copy</button></section>
      <button type="button" data-insert-selection hidden>Use selected pictures</button><section><h2>Existing media</h2><div class="admin-media-grid" data-library></div></section>`;
    document.body.append(dialog);
    const element = <T extends HTMLElement>(selector: string) => dialog.querySelector<T>(selector)!;
    const form = element<HTMLFormElement>('[data-prepare]');
    const input = element<HTMLInputElement>('[data-file]');
    const name = element<HTMLInputElement>('[data-name]');
    const timing = element<HTMLFieldSetElement>('[data-timing]');
    const length = element<HTMLFieldSetElement>('[data-length]');
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
    let controller: AbortController | undefined;
    let inspector: AbortController | undefined;
    let fileKind: PreviewInputKind | undefined;
    let prepared: PreparedPreview[] = [];
    let objectURLs: string[] = [];
    const selected = new Set<string>();
    const insertSelection = element<HTMLButtonElement>('[data-insert-selection]');
    const isMultiple = () => options.allowMultiple !== false && options.config?.multiple === true;
    let options: PickerOptions = {};
    let opener: HTMLElement | null = null;
    let publishing = false;
    let opening = 0;

    function clearPreview() {
      previewMedia.querySelectorAll<HTMLMediaElement>('video, audio').forEach(media => media.pause());
      previewMedia.replaceChildren();
      objectURLs.forEach(url => URL.revokeObjectURL(url));
      objectURLs = [];
      prepared = [];
      preview.hidden = true;
    }

    function hide() {
      if (publishing) return;
      opening++;
      controller?.abort();
      inspector?.abort();
      inspector = undefined;
      fileKind = undefined;
      input.value = '';
      dialog.querySelectorAll<HTMLMediaElement>('audio, video').forEach(media => media.pause());
      clearPreview();
      dialog.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    }

    function insert(url: string | string[]) {
      if (publishing) return;
      handleInsert(isMultiple() ? [...new Set([...(Array.isArray(options.value) ? options.value : options.value ? [options.value] : []), ...(Array.isArray(url) ? url : [url])])] : url);
      hide();
    }

    insertSelection.addEventListener('click', () => { if (selected.size) insert([...selected]); });

    function accepts(kind: PreviewInputKind) {
      const mediaKind = kind === 'animation' ? 'image' : kind;
      return (!options.imagesOnly || mediaKind === 'image') && (!options.config?.kinds || options.config.kinds.includes(mediaKind));
    }

    function syncLength() {
      const timed = fileKind !== undefined && fileKind !== 'image';
      length.hidden = !timed;
      length.disabled = Boolean(controller || inspector);
      timing.hidden = !timed || full.checked;
      timing.disabled = timing.hidden || Boolean(controller || inspector);
      fullWarning.hidden = !timed || !full.checked;
      convert.textContent = input.multiple && (input.files?.length ?? 0) > 1 ? 'Prepare pictures' : timed && full.checked ? 'Prepare full copy' : 'Prepare preview';
      convert.disabled = !fileKind || Boolean(controller || inspector);
    }

    function renderLibrary(registry: PreviewRegistry) {
      library.replaceChildren();
      const entries = Object.entries(registry.files).filter(([, entry]) => accepts(entry.kind));
      if (!entries.length) { library.textContent = 'No matching media yet.'; return; }
      for (const [url, entry] of entries) {
        const card = document.createElement('div');
        card.className = 'admin-media-card';
        if (entry.kind === 'image') {
          const image = document.createElement('img');
          image.src = url;
          image.alt = 'Prepared image preview';
          image.loading = 'lazy';
          card.append(image);
        } else {
          const player = document.createElement(entry.kind === 'audio' ? 'audio' : 'video');
          player.src = url;
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

    input.addEventListener('change', async () => {
      inspector?.abort();
      inspector = undefined;
      clearPreview();
      fileKind = undefined;
      short.checked = true;
      full.checked = false;
      start.value = '0';
      duration.value = '30';
      syncLength();
      const file = input.files?.[0];
      if (!file) { status.textContent = ''; return; }
      const abort = new AbortController();
      inspector = abort;
      cancel.hidden = progress.hidden = false;
      progress.removeAttribute('value');
      status.textContent = 'Checking the file on this device…';
      try {
        const kinds: PreviewInputKind[] = [];
        for (const candidate of Array.from(input.files ?? [])) kinds.push(await previewInputKind(candidate, abort.signal));
        if (kinds.some(kind => !accepts(kind))) throw new Error('Choose only supported files for this field. Nothing was uploaded.');
        const kind = kinds.find(kind => kind !== 'image') ?? 'image';
        if (abort.signal.aborted || !dialog.open) return;
        if (!accepts(kind)) throw new Error(`Choose ${options.imagesOnly ? 'an image or GIF' : options.config?.kinds?.join(' or ')} for this field. Nothing was uploaded.`);
        fileKind = kind;
        status.textContent = `${input.files?.length ?? 0} file(s) ready to prepare.`;
      } catch (error) {
        if (inspector === abort && dialog.open) {
          status.textContent = abort.signal.aborted ? 'Checking cancelled. Choose a file to try again.' : error instanceof Error ? error.message : 'Could not inspect this file.';
          if (abort.signal.aborted) input.value = '';
        }
      } finally {
        if (inspector === abort) {
          inspector = undefined;
          cancel.hidden = progress.hidden = true;
          syncLength();
        }
      }
    });
    form.addEventListener('input', event => {
      if (event.target === input || controller || inspector) return;
      clearPreview();
      status.textContent = '';
      syncLength();
    });
    close.addEventListener('click', hide);
    dialog.addEventListener('cancel', event => { event.preventDefault(); hide(); });
    cancel.addEventListener('click', () => { controller?.abort(); inspector?.abort(); });

    form.addEventListener('submit', async event => {
      event.preventDefault();
      const file = input.files?.[0];
      if (!file || !fileKind || controller || inspector || publishing) return;
      clearPreview();
      const abort = new AbortController();
      const request = opening;
      controller = abort;
      convert.disabled = input.disabled = name.disabled = timing.disabled = length.disabled = true;
      cancel.hidden = false;
      progress.hidden = false;
      progress.removeAttribute('value');
      status.textContent = 'Preparing on this device. Nothing has been uploaded.';
      try {
        const { creator } = await editorBackend().media();
        const files = Array.from(input.files ?? []);
        for (const [index, candidate] of files.entries()) {
          status.textContent = `Preparing ${index + 1} of ${files.length}: ${candidate.name}`;
          const kind = await previewInputKind(candidate, abort.signal);
          const result = await preparePreview(candidate, {
            creator, name: name.value.trim() && files.length > 1 ? `${name.value.trim()}-${index + 1}` : name.value.trim(), signal: abort.signal,
            ...(kind === 'image' ? {} : full.checked ? { fullLength: true } : { start: Number(start.value), duration: Number(duration.value) }),
            onProgress(value) {
              if (abort.signal.aborted) return;
              if (value === undefined) progress.removeAttribute('value');
              else progress.value = Math.max(0, Math.min(1, value));
            },
          });
          if (abort.signal.aborted || !dialog.open) { clearPreview(); return; }
          if (!accepts(result.entry.kind)) throw new Error('The prepared media does not match this field. Nothing was uploaded.');
          prepared.push(result);
          const objectURL = URL.createObjectURL(result.file);
          objectURLs.push(objectURL);
          const media = document.createElement(result.entry.kind === 'image' ? 'img' : result.entry.kind);
          media.src = objectURL;
          if (media instanceof HTMLMediaElement) media.controls = true;
          else media.alt = 'Prepared, watermarked image or animation';
          previewMedia.append(media);
        }
        previewDetails.textContent = `${prepared.length} prepared copy/copies. Review each copy before uploading.`;
        publish.textContent = prepared.length > 1 ? `Upload and use ${prepared.length} pictures` : 'Upload and use copy';
        preview.hidden = false;
        status.textContent = 'Review the prepared copy before uploading. Uploaded copies are public; the original stays on this device.';
        publish.focus();
      } catch (error) {
        clearPreview();
        if (request === opening && dialog.open) status.textContent = abort.signal.aborted ? 'Processing cancelled. Nothing was uploaded.' : error instanceof Error ? error.message : 'Could not prepare this file.';
      } finally {
        if (controller === abort) controller = undefined;
        input.disabled = name.disabled = false;
        syncLength();
        cancel.hidden = true;
        progress.hidden = true;
      }
    });

    publish.addEventListener('click', async () => {
      if (!prepared.length || publishing) return;
      publishing = true;
      close.disabled = publish.disabled = convert.disabled = input.disabled = true;
      form.inert = library.inert = true;
      status.textContent = 'Uploading the prepared copy and its registry together…';
      try {
        const urls: string[] = [];
        for (const [index, item] of prepared.entries()) {
          status.textContent = `Uploading ${index + 1} of ${prepared.length}…`;
          urls.push(await editorBackend().publishPreview(item));
        }
        publishing = false;
        insert(isMultiple() ? urls : urls[0]);
      } catch (error) {
        status.textContent = `${error instanceof Error ? error.message : 'Upload failed.'} Some copies may already be in Existing media. Retry to finish; existing copies are reused.`;
      } finally {
        publishing = false;
        close.disabled = publish.disabled = convert.disabled = input.disabled = false;
        form.inert = library.inert = false;
      }
    });

    return {
      async show(next: PickerOptions = {}) {
        if (dialog.open) return;
        options = next;
        selected.clear();
        input.multiple = isMultiple();
        insertSelection.hidden = !isMultiple();
        insertSelection.disabled = true;
        insertSelection.textContent = 'Use selected pictures';
        const request = ++opening;
        opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        form.reset();
        clearPreview();
        fileKind = undefined;
        syncLength();
        input.accept = [accepts('image') ? imageExtensions : '', accepts('audio') ? audioExtensions : '', accepts('video') ? videoExtensions : ''].filter(Boolean).join(',');
        library.replaceChildren();
        status.textContent = 'Loading registered media…';
        dialog.showModal();
        try {
          const { registry } = await editorBackend().media();
          if (request !== opening || !dialog.open) return;
          renderLibrary(registry);
          status.textContent = '';
        } catch (error) {
          if (request === opening && dialog.open) status.textContent = error instanceof Error ? error.message : 'Could not load previews.';
        }
      },
      hide,
      enableStandalone: () => true,
    };
  },
};
