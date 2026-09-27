/** Existing public pages, kept separate from repeatable Devlog/Life journal entries. */
export const editablePages = {
  home: { label: 'Home page', url: '/', file: 'src/content/site.json', description: 'Introduction, featured entry, game details and site settings.' },
  devlog: { label: 'Devlog page', url: '/devlog/', file: 'src/content/pages/devlog.json', description: 'The Devlog heading and introduction.' },
  life: { label: 'Life page', url: '/life/', file: 'src/content/pages/life.json', description: 'The Life heading and introduction.' },
  gallery: { label: 'Gallery page', url: '/gallery/', file: 'src/content/pages/gallery.json', description: 'Page text, pictures and gallery items.' },
  music: { label: 'Music page', url: '/music/', file: 'src/content/pages/music.json', description: 'Page text, music tracks and their covers.' },
  about: { label: 'About page', url: '/about/', file: 'src/content/pages/about.json', description: 'Biography, portrait, profile links and media.' },
  subscribe: { label: 'Subscribe page', url: '/subscribe/', file: 'src/content/pages/subscribe.json', description: 'Page text, RSS description and email subscription settings.' },
  'not-found': { label: 'Page not found', url: '/404.html', file: 'src/content/pages/not-found.json', description: 'The message shown when an address does not exist.' },
} as const;

export type EditablePageId = keyof typeof editablePages;

export function isEditablePageId(value: string): value is EditablePageId {
  return Object.hasOwn(editablePages, value);
}

export function editablePageForPath(pathname: string): EditablePageId | undefined {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/game') return 'devlog';
  if (path === '/404') return 'not-found';
  for (const [id, page] of Object.entries(editablePages)) {
    if ((page.url.replace(/\/+$/, '') || '/') === path) return id as EditablePageId;
  }
}
