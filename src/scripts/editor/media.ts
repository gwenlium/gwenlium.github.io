import { preparePreview, previewInputKind } from './prepare-media';
import { createPreviewPicker } from './library';
import type { SiteEditorStore } from './store';

export type StagedFile = { url: string; kind: 'image' | 'video' | 'audio'; name: string };

// Originals of still pictures added during this visit, so a crop can start from full quality
// and the result is signed once. They stay in this tab and are never uploaded.
const originals = new Map<string, File>();

export function rememberOriginal(url: string, file: File): void {
  originals.delete(url);
  originals.set(url, file);
  for (const oldest of originals.keys()) {
    if (originals.size <= 40) break;
    originals.delete(oldest);
  }
}

export function originalOf(url: string): File | undefined {
  return originals.get(url);
}

/** A readable public file name from the original, e.g. "Lyn Front.PNG" becomes "lyn-front". */
export function publicName(file: File): string | undefined {
  const name = file.name.replace(/\.[^.]+$/, '').normalize('NFKD').replace(/\p{M}/gu, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) && !/^(img|dsc|image|screenshot|photo)?-?\d*$/.test(name) ? name : undefined;
}

/**
 * Prepare local files the way the site always has (resized, watermarked, metadata stripped)
 * and stage them in the private draft. Originals never leave this device.
 */
export async function stageFiles(store: SiteEditorStore, files: File[], onStatus: (text: string) => void, signal?: AbortSignal): Promise<StagedFile[]> {
  const { creator } = await store.media();
  const staged: StagedFile[] = [];
  for (const [index, file] of files.entries()) {
    const label = files.length > 1 ? ` ${index + 1} of ${files.length}` : '';
    const kind = await previewInputKind(file, signal);
    const noun = kind === 'video' ? 'video' : kind === 'audio' ? 'audio' : 'picture';
    const onProgress = (value: number | undefined) => onStatus(`Preparing ${noun}${label}${value !== undefined ? ` ${Math.round(value * 100)}%` : ''}…`);
    onProgress(undefined);
    const name = publicName(file);
    let prepared;
    if (kind === 'video' || kind === 'audio' || kind === 'animation') {
      try {
        prepared = await preparePreview(file, { creator, name, fullLength: true, signal, onProgress });
      } catch (error) {
        if (signal?.aborted) throw error;
        // Long recordings can exceed the 32 MiB limit in full; keep the first minute instead.
        prepared = await preparePreview(file, { creator, name, start: 0, duration: 60, signal, onProgress });
        onStatus(`That ${noun} was too long to publish in full, so the first minute was kept.`);
      }
    } else prepared = await preparePreview(file, { creator, name, signal, onProgress });
    const url = await store.addMedia(prepared);
    if (kind === 'image') rememberOriginal(url, file);
    staged.push({ url, kind: prepared.entry.kind, name: file.name.replace(/\.[^.]+$/, '') });
  }
  if (files.length) onStatus(files.length === 1 ? 'Ready.' : `${files.length} files ready.`);
  return staged;
}

/** Pick something already on the website (or already staged in this draft). */
export function chooseFromLibrary(store: SiteEditorStore, imagesOnly: boolean): Promise<string | undefined> {
  const { promise, resolve } = Promise.withResolvers<string | undefined>();
  let settled = false;
  const finish = (value?: string) => {
    if (settled) return;
    settled = true;
    queueMicrotask(() => picker.destroy());
    resolve(value);
  };
  const picker = createPreviewPicker({
    load: () => store.media(),
    save: preview => store.addMedia(preview),
    resolveURL: url => store.resolveMedia(url),
    onCancel: () => finish(),
    onInsert: value => finish(Array.isArray(value) ? value[0] : value),
  });
  void picker.show({ imagesOnly, allowMultiple: false }).catch(() => finish());
  return promise;
}
