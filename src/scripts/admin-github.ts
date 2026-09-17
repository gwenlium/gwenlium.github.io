import { GitHubBackend, type Entry, type GitFile, type PersistOptions } from 'decap-cms-backend-github';
import type { PreparedPreview } from './admin-media';

type PreviewMetadata = { sha256: string; kind: 'image' | 'video' | 'audio'; width?: number; height?: number; duration?: number };
export type PreviewRegistry = { files: Record<string, PreviewMetadata> };
const registryPath = 'src/content/media-previews.json';
const previewPath = /^\/media\/[a-z0-9]+(?:-[a-z0-9]+)*-preview-[a-f0-9]{32}\.(webp|gif|mp4|mp3)$/;
let activeBackend: PreparedGitHubBackend | undefined;

function registryFrom(raw: string | Blob): PreviewRegistry {
  if (typeof raw !== 'string') throw new Error('The preview registry could not be read.');
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1
    || !value.files || typeof value.files !== 'object' || Array.isArray(value.files)) throw new Error('The preview registry is invalid. Nothing was uploaded.');
  for (const [url, metadata] of Object.entries(value.files)) {
    const entry = metadata as PreviewMetadata;
    if (!previewPath.test(url) || !entry || typeof entry !== 'object' || Array.isArray(entry)
      || !/^[a-f0-9]{64}$/.test(entry.sha256) || !['image', 'video', 'audio'].includes(entry.kind)
      || Object.keys(entry).some(key => !['sha256', 'kind', 'width', 'height', 'duration'].includes(key))) {
      throw new Error('The preview registry is invalid. Nothing was uploaded.');
    }
  }
  return value as PreviewRegistry;
}

function fileBase64(file: File): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const reader = new FileReader();
  reader.onerror = () => reject(new Error('Could not read the prepared preview.'));
  reader.onload = () => {
    const data = reader.result;
    if (typeof data !== 'string') reject(new Error('Could not encode the prepared preview.'));
    else resolve(data.slice(data.indexOf(',') + 1));
  };
  reader.readAsDataURL(file);
  return promise;
}

export function editorBackend(): PreparedGitHubBackend {
  if (!activeBackend?.api || !activeBackend.token) throw new Error('Sign in with GitHub before managing media.');
  return activeBackend;
}

export class PreparedGitHubBackend extends GitHubBackend {
  private writes: Promise<unknown> = Promise.resolve();

  constructor(config: unknown, options?: unknown) {
    super(config, options);
    activeBackend = this;
  }

  async media(): Promise<{ registry: PreviewRegistry; creator: string }> {
    if (!this.api || !this.token) throw new Error('Sign in with GitHub before managing media.');
    const head = await this.api.getDefaultBranch();
    const [registry, site] = await Promise.all([
      this.api.readFile(registryPath, null, { branch: head.commit.sha }),
      this.api.readFile('src/content/site.json', null, { branch: head.commit.sha }),
    ]);
    const creator = typeof site === 'string' ? JSON.parse(site).name : undefined;
    if (typeof creator !== 'string' || !creator.trim()) throw new Error('Set your display name in Site settings before uploading.');
    return { registry: registryFrom(registry), creator: creator.trim() };
  }

  publishPreview(preview: PreparedPreview): Promise<string> {
    const publish = this.writes.then(async () => {
      if (!this.api || !this.token) throw new Error('Sign in with GitHub before uploading.');
      if (!previewPath.test(preview.url) || preview.url !== `/media/${preview.file.name}`
        || !/^[a-f0-9]{64}$/.test(preview.entry.sha256)) throw new Error('Only prepared previews can be uploaded.');
      const api = this.api;
      // Pin every read and the commit to one HEAD. A concurrent edit makes the non-force
      // reference update fail rather than overwriting someone else's registry changes.
      const head = await api.getDefaultBranch();
      const registry = registryFrom(await api.readFile(registryPath, null, { branch: head.commit.sha }));
      const existing = registry.files[preview.url];
      if (existing) {
        if (existing.sha256 !== preview.entry.sha256) throw new Error('A different preview already uses this filename.');
        return preview.url;
      }
      registry.files[preview.url] = preview.entry;
      const sorted = { files: Object.fromEntries(Object.entries(registry.files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) };
      const files: GitFile[] = [
        { path: `public${preview.url}`, toBase64: () => fileBase64(preview.file) },
        { path: registryPath, raw: `${JSON.stringify(sorted, null, 2)}\n` },
      ];
      await Promise.all(files.map(file => api.uploadBlob(file)));
      const tree = await api.updateTree(head.commit.sha, files.map(file => ({ path: file.path, sha: file.sha! })));
      const commit = await api.commit(`Upload prepared ${preview.entry.kind} preview`, tree);
      try { await api.patchBranch(this.branch, commit.sha, { force: false }); }
      catch { throw new Error('The preview was not published. The repository may have changed or your access may have expired. Reopen Media and try again; existing content was not overwritten.'); }
      return preview.url;
    });
    this.writes = publish.catch(() => undefined);
    return publish;
  }

  override persistEntry(entry: Entry, options: PersistOptions): Promise<unknown> {
    // Drag-and-drop native editor uploads can bypass external media pickers. Never let
    // original AssetProxy bytes reach the stock GitHub upload path.
    if (entry.assets.length) return Promise.reject(new Error('Use the media picker to prepare and upload pictures, GIFs, audio or video before saving. Direct file drops are not published.'));
    return super.persistEntry(entry, options);
  }

  override persistMedia(): Promise<never> {
    return Promise.reject(new Error('Use the media picker to prepare a listening or viewing copy before uploading. Originals are never uploaded.'));
  }

  override deleteFiles(paths: string[], message: string): Promise<unknown> {
    if (paths.some(path => path.startsWith('public/media/') || path === registryPath)) {
      return Promise.reject(new Error('Published media is retained so existing posts and shared links keep working. Remove references before managing these files in GitHub.'));
    }
    return super.deleteFiles(paths, message);
  }
}
