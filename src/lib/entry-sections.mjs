/** One destination contract shared by the writer, renderer and publishing worker. */
export const entrySectionIds = /** @type {const} */ (['home', 'devlog', 'life', 'gallery', 'music', 'about', 'subscribe']);

/** @typedef {(typeof entrySectionIds)[number]} EntrySection */

/** @type {Record<EntrySection, { label: string, indexUrl: string, pathSegment: string, dated: boolean }>} */
export const entrySectionInfo = {
  home: { label: 'Home', indexUrl: '/', pathSegment: 'entries', dated: false },
  devlog: { label: 'Devlog', indexUrl: '/devlog/', pathSegment: 'devlog', dated: true },
  life: { label: 'Life', indexUrl: '/life/', pathSegment: 'life', dated: true },
  gallery: { label: 'Gallery', indexUrl: '/gallery/', pathSegment: 'gallery', dated: false },
  music: { label: 'Music', indexUrl: '/music/', pathSegment: 'music', dated: false },
  about: { label: 'About', indexUrl: '/about/', pathSegment: 'about', dated: false },
  subscribe: { label: 'Subscribe', indexUrl: '/subscribe/', pathSegment: 'subscribe', dated: false },
};

/** @param {unknown} value @returns {value is EntrySection} */
export function isEntrySection(value) {
  return typeof value === 'string' && Object.hasOwn(entrySectionInfo, value);
}

/** Missing sections in existing posts remain Devlog; an unknown destination is never silently moved there.
 * @param {unknown} value @returns {EntrySection}
 */
export function resolveEntrySection(value) {
  if (value === undefined) return 'devlog';
  if (!isEntrySection(value)) throw new Error('Unknown entry destination. Choose a supported section.');
  return value;
}

/** @param {EntrySection} section @param {string} permalink */
export function entryUrl(section, permalink) {
  return `/${entrySectionInfo[section].pathSegment}/${permalink}/`;
}

/** @param {string} pathname @returns {EntrySection | undefined} */
export function entrySectionFromPath(pathname) {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/') return 'home';
  if (path === '/game') return 'devlog';
  const segment = path.split('/').filter(Boolean)[0];
  return entrySectionIds.find(section => entrySectionInfo[section].pathSegment === segment);
}
