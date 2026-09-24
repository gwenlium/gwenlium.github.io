import { devEditorPath, editorConfig } from '../../lib/editor-config';
import { BrowserOwnerAuth, DevOwnerAuth } from './auth';
import { SiteEditorStore } from './store';

let store: SiteEditorStore | undefined;

/** One store per tab, shared by the page controls and the writing page across view transitions. */
export function ownerStore(): SiteEditorStore {
  if (!store) {
    // `npm run dev` edits the local files through scripts/dev-editor.mjs instead of GitHub.
    const local = import.meta.env.DEV;
    store = local
      ? new SiteEditorStore({ authOrigin: `${location.origin}${devEditorPath}`, siteOrigin: location.origin, auth: new DevOwnerAuth(), local })
      : new SiteEditorStore({ ...editorConfig, auth: new BrowserOwnerAuth(editorConfig.authOrigin, editorConfig.siteOrigin) });
  }
  return store;
}

export const writerUrl = (options: { entry?: string; section?: 'devlog' | 'life'; fresh?: boolean } = {}) => {
  const url = new URL('/write/', location.origin);
  if (options.entry) url.searchParams.set('entry', options.entry);
  if (options.fresh) url.searchParams.set('new', options.section ?? 'devlog');
  return `${url.pathname}${url.search}`;
};
