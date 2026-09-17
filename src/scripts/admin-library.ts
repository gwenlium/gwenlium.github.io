import { editorBackend, type PreviewRegistry } from './admin-github';
import type { PreparedPreview } from './admin-media';
import '../styles/admin.css';

type PickerOptions = { imagesOnly?: boolean };
const imageExtensions = '.jpg,.jpeg,.png,.webp,.gif';
const videoExtensions = '.mp4,.mov,.m4v,.webm,.mkv,.avi,.ogv,.mpg,.mpeg,.mts,.m2ts';

export const previewMediaLibrary = {
  name: 'gwenlium-previews',
  init({ handleInsert }: { handleInsert: (url: string) => void }) {
    const dialog = document.createElement('dialog');
    dialog.className = 'admin-media';
    dialog.setAttribute('aria-labelledby', 'admin-media-title');
    dialog.innerHTML = `<header><h1 id="admin-media-title">Media previews</h1><button type="button" data-close aria-label="Close media picker">Close</button></header>
      <p>Originals stay on this device. Images are resized and watermarked; videos are published as watermarked excerpts. Prepared previews and saved drafts are public.</p>
      <form data-prepare><label>Image or video<input type="file" data-file required></label>
        <label>Public name (optional)<input data-name pattern="[a-z0-9]+(?:-[a-z0-9]+)*" maxlength="64" placeholder="image or video"></label>
        <fieldset data-timing hidden><legend>Video excerpt</legend><label>Start (seconds)<input data-start type="number" min="0" step="0.01" value="0"></label><label>Duration (seconds, maximum 60)<input data-duration type="number" min="0.01" max="60" step="0.01" value="30"></label></fieldset>
        <p class="admin-media-help">JPEG, PNG, WebP and GIF up to 32 MiB. Videos up to 128 MiB. Animated GIF/WebP conversion requires a browser with ImageDecoder, such as Chrome. Video processing may take time.</p>
        <div class="admin-media-actions"><button type="submit" data-convert>Prepare preview</button><button type="button" data-cancel hidden>Cancel processing</button></div>
      </form>
      <p data-status role="status" aria-live="polite"></p><progress data-progress max="1" hidden></progress>
      <section data-preview hidden><h2>Prepared preview</h2><div data-preview-media></div><p data-preview-details></p><button type="button" data-publish>Upload and use preview</button></section>
      <section><h2>Existing previews</h2><div class="admin-media-grid" data-library></div></section>`;
    document.body.append(dialog);
    const element = <T extends HTMLElement>(selector: string) => dialog.querySelector<T>(selector)!;
    const form = element<HTMLFormElement>('[data-prepare]');
    const input = element<HTMLInputElement>('[data-file]');
    const name = element<HTMLInputElement>('[data-name]');
    const timing = element<HTMLFieldSetElement>('[data-timing]');
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
    let prepared: PreparedPreview | undefined;
    let objectURL: string | undefined;
    let options: PickerOptions = {};
    let opener: HTMLElement | null = null;
    let publishing = false;
    let opening = 0;

    function clearPreview() {
      previewMedia.querySelector('video')?.pause();
      previewMedia.replaceChildren();
      if (objectURL) URL.revokeObjectURL(objectURL);
      objectURL = undefined;
      prepared = undefined;
      preview.hidden = true;
    }

    function hide() {
      if (publishing) return;
      opening++;
      controller?.abort();
      clearPreview();
      dialog.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    }

    function insert(url: string) {
      if (publishing) return;
      handleInsert(url);
      hide();
    }

    function renderLibrary(registry: PreviewRegistry) {
      library.replaceChildren();
      const entries = Object.entries(registry.files).filter(([, entry]) => !options.imagesOnly || entry.kind === 'image');
      if (!entries.length) { library.textContent = 'No matching previews yet.'; return; }
      for (const [url, entry] of entries) {
        const card = document.createElement('div');
        card.className = 'admin-media-card';
        if (entry.kind === 'image') {
          const image = document.createElement('img');
          image.src = url;
          image.alt = 'Prepared image preview';
          image.loading = 'lazy';
          card.append(image);
        }
        const label = document.createElement('span');
        label.textContent = `${entry.kind}${entry.width && entry.height ? ` ${entry.width} × ${entry.height}` : ''}${entry.duration ? ` (${entry.duration.toFixed(1)} seconds)` : ''}`;
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'Use preview';
        button.title = url;
        button.addEventListener('click', () => insert(url));
        card.append(label, button);
        library.append(card);
      }
    }

    input.addEventListener('change', () => {
      clearPreview();
      const file = input.files?.[0];
      timing.hidden = !file || !(/\.(?:mp4|mov|m4v|webm|mkv|avi|ogv|mpg|mpeg|mts|m2ts)$/i.test(file.name) || file.type.startsWith('video/'));
      status.textContent = '';
    });
    close.addEventListener('click', hide);
    dialog.addEventListener('cancel', event => { event.preventDefault(); hide(); });
    cancel.addEventListener('click', () => controller?.abort());

    form.addEventListener('submit', async event => {
      event.preventDefault();
      const file = input.files?.[0];
      if (!file || controller || publishing) return;
      clearPreview();
      const abort = new AbortController();
      controller = abort;
      convert.disabled = input.disabled = name.disabled = timing.disabled = true;
      cancel.hidden = false;
      progress.hidden = false;
      progress.removeAttribute('value');
      status.textContent = 'Preparing on this device. Nothing has been uploaded.';
      try {
        const [{ preparePreview }, { creator }] = await Promise.all([import('./admin-media'), editorBackend().media()]);
        const result = await preparePreview(file, {
          creator, name: name.value.trim(), signal: abort.signal,
          ...(!timing.hidden ? { start: Number(start.value), duration: Number(duration.value) } : {}),
          onProgress(value) {
            if (abort.signal.aborted) return;
            if (value === undefined) progress.removeAttribute('value');
            else progress.value = Math.max(0, Math.min(1, value));
          },
        });
        if (abort.signal.aborted || !dialog.open) return;
        if (options.imagesOnly && result.entry.kind !== 'image') throw new Error('Choose an image for this field. Nothing was uploaded.');
        prepared = result;
        objectURL = URL.createObjectURL(result.file);
        const media = document.createElement(result.entry.kind === 'video' ? 'video' : 'img');
        media.src = objectURL;
        if (media instanceof HTMLVideoElement) media.controls = true;
        else media.alt = 'Prepared, watermarked preview';
        previewMedia.append(media);
        previewDetails.textContent = `${result.entry.width} × ${result.entry.height}${result.entry.duration ? `, ${result.entry.duration.toFixed(2)} seconds` : ''}, ${(result.file.size / 1048576).toFixed(2)} MiB`;
        preview.hidden = false;
        status.textContent = 'Check the preview, then upload it. The original will not be uploaded.';
        publish.focus();
      } catch (error) {
        if (dialog.open) status.textContent = abort.signal.aborted ? 'Processing cancelled. Nothing was uploaded.' : error instanceof Error ? error.message : 'Could not prepare this file.';
      } finally {
        if (controller === abort) controller = undefined;
        convert.disabled = input.disabled = name.disabled = timing.disabled = false;
        cancel.hidden = true;
        progress.hidden = true;
      }
    });

    publish.addEventListener('click', async () => {
      if (!prepared || publishing) return;
      publishing = true;
      close.disabled = publish.disabled = convert.disabled = input.disabled = true;
      form.inert = library.inert = true;
      status.textContent = 'Publishing the prepared preview and its registry together…';
      try {
        const url = await editorBackend().publishPreview(prepared);
        publishing = false;
        insert(url);
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : 'The preview was not published.';
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
        const request = ++opening;
        opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        form.reset();
        clearPreview();
        timing.hidden = true;
        input.accept = options.imagesOnly ? imageExtensions : `${imageExtensions},${videoExtensions}`;
        library.replaceChildren();
        status.textContent = 'Loading registered previews…';
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
