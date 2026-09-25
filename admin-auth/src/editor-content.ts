import { parseDocument } from 'yaml';
import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Root, RootContent } from 'mdast';
import { builtinWindowPages, systemWindowIds, windowContents, windowPages, windowTones } from '../../src/lib/window-catalogue.mjs';
import type { EditorMediaEntry, EditorPublishRequest } from '../../src/lib/editor-types';
import { normalizeWatermarkCredit, watermarkCreditError } from '../../src/lib/watermark.mjs';

export const registryPath = 'src/content/media-previews.json';
export const maxTextBytes = 1024 * 1024;
export const maxMediaBytes = 32 * 1024 * 1024;
export const maxRequestBytes = 12 * 1024 * 1024;
export const shaPattern = /^[a-f0-9]{40}$/;
export const mediaFilePattern = /^public\/media\/[a-z0-9]+(?:-[a-z0-9]+)*-preview-[a-f0-9]{32}\.(?:webp|gif|mp3|mp4)$/;
const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const previewPattern = /^\/media\/([a-z0-9]+(?:-[a-z0-9]+)*)-preview-([a-f0-9]{32})\.(webp|gif|mp3|mp4)$/;
const kinds: Record<string, string> = { webp: 'image', gif: 'image', mp3: 'audio', mp4: 'video' };
const encoder = new TextEncoder();
export class EditorError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new EditorError(message);
}
export function object(value: unknown): Record<string, unknown> {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected a content object.');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  requireValue(Object.keys(value).every(key => allowed.includes(key)), 'Unsupported content field.');
}
export function contentPath(path: unknown, readOnly = false): path is string {
  return typeof path === 'string' && path.length <= 240 && (
    /^src\/content\/(site|windows|gallery|music)\.json$/.test(path) ||
    /^src\/content\/pages\/[a-z0-9]+(?:-[a-z0-9]+)*\.json$/.test(path) ||
    /^src\/content\/posts\/(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)*[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(path) ||
    (readOnly && path === registryPath)
  );
}
export function parseJson(content: string): Record<string, unknown> {
  try { return object(JSON.parse(content)); }
  catch { throw new EditorError('Content must contain a valid JSON object.'); }
}
export function decodeBase64(content: string, maximum: number, whitespace = false): Uint8Array<ArrayBuffer> {
  const encoded = whitespace ? content.replace(/[\r\n]/g, '') : content;
  const padding = encoded.indexOf('=');
  requireValue(encoded.length > 0 && encoded.length % 4 === 0 && encoded.length <= Math.ceil(maximum / 3) * 4 && !/[^A-Za-z0-9+/=]/.test(encoded) && (padding === -1 || padding >= encoded.length - 2 && /^={1,2}$/.test(encoded.slice(padding))), 'Invalid or oversized base64 content.');
  const padBytes = padding === -1 ? 0 : encoded.length - padding;
  const length = encoded.length / 4 * 3 - padBytes;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  requireValue(length <= maximum && (padBytes === 0 || (alphabet.indexOf(encoded[padding - 1]) & (padBytes === 2 ? 15 : 3)) === 0), 'Invalid or oversized base64 content.');
  const bytes = new Uint8Array(length);
  // Decoding in aligned chunks avoids holding a second full media-sized string.
  for (let offset = 0; offset < encoded.length; offset += 65536) {
    const chunk = atob(encoded.slice(offset, offset + 65536));
    const start = offset / 4 * 3;
    for (let index = 0; index < chunk.length; index++) bytes[start + index] = chunk.charCodeAt(index);
  }
  return bytes;
}
function metadata(path: string, value: unknown): EditorMediaEntry {
  const match = previewPattern.exec(path);
  requireValue(match && match[1].length <= 64, 'Only prepared preview media paths are allowed.');
  const entry = object(value);
  keys(entry, ['sha256', 'kind', 'width', 'height', 'duration', 'loop', 'poster']);
  requireValue(typeof entry.sha256 === 'string' && /^[a-f0-9]{64}$/.test(entry.sha256) && entry.kind === kinds[match[3]], 'Invalid preview digest or media kind.');
  for (const field of ['width', 'height']) if (entry[field] !== undefined) requireValue(Number.isSafeInteger(entry[field]) && Number(entry[field]) > 0 && Number(entry[field]) <= 8192, 'Invalid preview dimensions.');
  if (entry.duration !== undefined) requireValue(typeof entry.duration === 'number' && Number.isFinite(entry.duration) && entry.duration > 0 && entry.duration <= 86400, 'Invalid preview duration.');
  // Animations are looping videos with a still first frame for thumbnails.
  requireValue(entry.loop === undefined || (entry.loop === true && entry.kind === 'video'), 'Only videos can loop like an animation.');
  requireValue(entry.poster === undefined || (entry.loop === true && typeof entry.poster === 'string' && previewPattern.exec(entry.poster)?.[3] === 'webp'), 'An animation poster must be a prepared WebP still.');
  return entry as unknown as EditorMediaEntry;
}

/** Posters count as used while the animation that shows them is used. */
export function withPosters(used: Set<string>, previews: Record<string, EditorMediaEntry>): Set<string> {
  for (const [url, entry] of Object.entries(previews)) if (entry.poster && used.has(url)) used.add(entry.poster);
  return used;
}
export function previewRegistry(content: string): Record<string, EditorMediaEntry> {
  const registry = parseJson(content);
  keys(registry, ['files']);
  const files = object(registry.files);
  for (const [path, entry] of Object.entries(files)) metadata(path, entry);
  return files as Record<string, EditorMediaEntry>;
}
export function publishPayload(value: unknown): EditorPublishRequest {
  const request = object(value);
  keys(request, ['baseCommit', 'changes', 'media', 'deletions', 'message']);
  requireValue(typeof request.baseCommit === 'string' && shaPattern.test(request.baseCommit), 'A full base commit SHA is required.');
  request.deletions ??= [];
  requireValue(Array.isArray(request.changes) && request.changes.length <= 100 && Array.isArray(request.media) && request.media.length <= 32
    && Array.isArray(request.deletions) && request.deletions.length <= 100
    && request.changes.length + request.media.length + request.deletions.length > 0, 'Publish between 1 and 100 content changes, with at most 32 media files and 100 deletions.');
  // The commit message is shown in the repository history; one plain line.
  requireValue(request.message === undefined || (typeof request.message === 'string' && request.message.trim().length > 0 && request.message.length <= 200 && !/[\u0000-\u001f\u007f]/.test(request.message)), 'Invalid publish message.');
  const seen = new Set<string>();
  // Journal entries and unused prepared media can be deleted; pages and windows cannot.
  for (const path of request.deletions) {
    requireValue(typeof path === 'string' && ((contentPath(path) && path.startsWith('src/content/posts/')) || mediaFilePattern.test(path)) && !seen.has(path), 'Only journal entries and prepared media can be deleted, each once.');
    seen.add(path);
  }
  let textBytes = 0;
  for (const value of request.changes) {
    const change = object(value); keys(change, ['path', 'content']);
    requireValue(contentPath(change.path) && !seen.has(change.path), 'Disallowed or duplicate content path.');
    seen.add(change.path);
    requireValue(typeof change.content === 'string' && !change.content.includes('\0'), 'Content must be text without NUL bytes.');
    const length = encoder.encode(change.content).length;
    textBytes += length;
    requireValue(length <= maxTextBytes && textBytes <= 8 * maxTextBytes, 'Content changes are too large.');
  }
  // Media goes from the browser straight to GitHub as Git blobs (a Worker cannot hold or hash
  // tens of megabytes). The browser ran checkPreparedMedia on the bytes before uploading; here the
  // claims are checked for shape, and publishEditor confirms each blob exists with this size.
  for (const value of request.media) {
    const upload = object(value); keys(upload, ['path', 'blob', 'size', 'entry']);
    requireValue(typeof upload.path === 'string' && upload.path.startsWith('public/media/') && !seen.has(upload.path), 'Disallowed or duplicate media path.');
    seen.add(upload.path);
    const path = upload.path.slice(6);
    const entry = metadata(path, upload.entry);
    const match = previewPattern.exec(path)!;
    requireValue(entry.sha256.startsWith(match[2]), 'Preview filename must match its digest.');
    requireValue(typeof upload.blob === 'string' && shaPattern.test(upload.blob), 'Media must name the Git blob it was uploaded as.');
    requireValue(Number.isSafeInteger(upload.size) && Number(upload.size) > 0 && Number(upload.size) <= maxMediaBytes, 'Each prepared media file can be at most 32 MiB.');
  }
  return request as unknown as EditorPublishRequest;
}

export function validateContent(files: Map<string, string>, previews: Record<string, EditorMediaEntry>, exists: (path: string) => boolean, siteOrigin: string): void {
  for (const entry of Object.values(previews)) requireValue(!entry.poster || previews[entry.poster]?.kind === 'image', 'An animation poster must be a registered still picture.');
  const text = (value: unknown, required = false): value is string => {
    requireValue(value === undefined && !required || typeof value === 'string' && (!required || value.trim()), required ? 'A required text field is missing.' : 'Expected a text field.');
    return typeof value === 'string' && value.trim().length > 0;
  };
  const strings = (value: unknown): string[] => {
    if (value === undefined) return [];
    requireValue(Array.isArray(value) && value.every(item => text(item, true)), 'Expected a list of text values.');
    return value as string[];
  };
  const url = (value: unknown, kind?: string, required = false, trailer = false): void => {
    if (!text(value, required)) return;
    requireValue(!/[\u0000-\u0020\u007f\\]/.test(value), 'URLs cannot contain spaces, controls or backslashes.');
    let parsed: URL;
    try { parsed = new URL(value, siteOrigin); } catch { throw new EditorError('Invalid content URL.'); }
    requireValue(['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password, 'Use an HTTP(S), site-relative or anchor URL without credentials.');
    if (!kind && !parsed.pathname.startsWith('/media/')) return;
    const trailers = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtube-nocookie.com', 'youtube-nocookie.com', 'vimeo.com', 'www.vimeo.com', 'player.vimeo.com'];
    if (trailer && parsed.protocol === 'https:' && trailers.includes(parsed.hostname)) return;
    requireValue(parsed.origin === siteOrigin && !parsed.search && !parsed.hash && !/%/.test(parsed.pathname), 'Use a registered local media preview.');
    const branding = ['/avatar.webp', '/favicon.png', '/social-card.png', '/followit-logo.svg'];
    if (branding.includes(parsed.pathname)) {
      requireValue((!kind || kind === 'image' || kind === 'media') && exists(`public${parsed.pathname}`), 'Missing public branding image.'); return;
    }
    const entry = previews[parsed.pathname];
    requireValue(entry && (!kind || kind === 'media' || kind === entry.kind) && exists(`public${parsed.pathname}`), 'Missing preview or incorrect media kind. Prepare the media before publishing.');
  };
  const image = (source: unknown, alt: unknown): void => { url(source, 'image'); text(alt, Boolean(source)); };
  const links = (value: unknown): void => {
    if (value === undefined) return;
    requireValue(Array.isArray(value), 'Links must be an array.');
    for (const item of value) { const link = object(item); keys(link, ['label', 'url']); text(link.label, true); url(link.url, undefined, true); }
  };
  const media = (value: unknown, gallery = false): Set<string> => {
    const ids = new Set<string>();
    if (value === undefined) return ids;
    requireValue(Array.isArray(value), 'Media must be an array.');
    for (const item of value) {
      const entry = object(item); keys(entry, ['type', 'src', 'alt', 'caption', 'poster', ...(gallery ? ['id', 'title', 'topics'] : [])]);
      if (gallery) { text(entry.id, true); requireValue(!ids.has(entry.id as string), 'Duplicate gallery ID.'); ids.add(entry.id as string); text(entry.title, true); strings(entry.topics); }
      requireValue(typeof entry.type === 'string' && (gallery ? ['image', 'video'] : ['image', 'audio', 'video']).includes(entry.type), 'Invalid media type.');
      // Descriptions are encouraged by the editor but optional, like the older photo lists.
      url(entry.src, entry.type, true); text(entry.alt); text(entry.caption); url(entry.poster, 'image');
    }
    return ids;
  };
  const markdown = (source: unknown): void => {
    if (!text(source)) return;
    const tree = fromMarkdown(source);
    const definitions = new Map<string, string>();
    const walk = (node: Root | RootContent, visit: (node: Root | RootContent) => void): void => { visit(node); if ('children' in node) for (const child of node.children) walk(child, visit); };
    walk(tree, node => { if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url); });
    walk(tree, node => {
      // Inline HTML is not a code-editing escape hatch. Markdown supplies images and links.
      requireValue(node.type !== 'html', 'Use Markdown rather than raw HTML in editable content.');
      // Pictures, prepared video and audio share the picture syntax in text (any registered preview).
      if (node.type === 'link' || node.type === 'image' || node.type === 'definition') url(node.url, node.type === 'image' ? 'media' : undefined, true);
      if (node.type === 'image' || node.type === 'imageReference') text(node.alt, true);
      if (node.type === 'imageReference' || node.type === 'linkReference') url(definitions.get(node.identifier), node.type === 'imageReference' ? 'image' : undefined, true);
    });
  };
  const photos = (value: unknown): void => { if (value === '') return; for (const source of strings(value)) url(source, 'image', true); };
  const json = new Map<string, Record<string, unknown>>();
  const posts = new Map<string, { section: string; published: boolean }>();
  for (const [path, content] of files) {
    try {
      if (!path.endsWith('.md')) { json.set(path, parseJson(content)); continue; }
      const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(content);
      requireValue(match && match[1].length <= 64 * 1024, 'Posts require bounded YAML frontmatter.');
      const document = parseDocument(match[1], { uniqueKeys: true, strict: true });
      requireValue(!document.errors.length && !document.warnings.length, 'Invalid or unsupported YAML frontmatter.');
      const post = object(document.toJS({ maxAliasCount: 0 }));
      keys(post, ['title', 'permalink', 'date', 'publishAt', 'excerpt', 'draft', 'section', 'tags', 'cover', 'coverAlt', 'featured', 'photos', 'media']);
      for (const field of ['title', 'permalink', 'date', 'excerpt', 'cover', 'coverAlt']) text(post[field]);
      for (const field of ['draft', 'featured']) requireValue(post[field] === undefined || typeof post[field] === 'boolean', 'Post flags must be booleans.');
      requireValue(post.section === undefined || typeof post.section === 'string' && ['devlog', 'life'].includes(post.section), 'Invalid post section.');
      let validDate = false;
      if (typeof post.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(post.date)) { const date = new Date(`${post.date}T00:00:00.000Z`); validDate = Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === post.date; }
      // Optional go-live moment in UTC; the entry is public only after it.
      requireValue(post.publishAt === undefined || (typeof post.publishAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/.test(post.publishAt) && Number.isFinite(Date.parse(post.publishAt))), 'Use a UTC time such as 2026-09-26T16:00:00Z for the go-live time.');
      const due = post.publishAt === undefined || Date.parse(String(post.publishAt)) <= Date.now();
      if (post.draft === false) { text(post.title, true); requireValue(validDate && typeof post.permalink === 'string' && slug.test(post.permalink), 'Published posts need a valid calendar date and permalink.'); }
      if (text(post.permalink)) { requireValue(slug.test(post.permalink) && !posts.has(post.permalink), 'Invalid or duplicate post permalink.'); posts.set(post.permalink, { section: String(post.section ?? 'devlog'), published: post.draft === false && validDate && due && new Date(String(post.date)).getTime() <= Date.now() }); }
      strings(post.tags); image(post.cover, post.coverAlt); photos(post.photos); media(post.media); markdown(match[2]);
    } catch (error) { throw new EditorError(`${path}: ${error instanceof EditorError ? error.message : 'Invalid content structure.'}`); }
  }
  let galleryIds = new Set<string>(); const musicIds = new Set<string>();
  const gallery = json.get('src/content/gallery.json');
  if (gallery) { keys(gallery, ['items']); requireValue(Array.isArray(gallery.items), 'Gallery items must be an array.'); galleryIds = media(gallery.items, true); }
  const music = json.get('src/content/music.json');
  if (music) {
    keys(music, ['tracks']); requireValue(Array.isArray(music.tracks), 'Music tracks must be an array.');
    for (const value of music.tracks) { const track = object(value); keys(track, ['id', 'title', 'topics', 'src', 'cover', 'coverAlt']); text(track.id, true); requireValue(!musicIds.has(track.id as string), 'Duplicate music ID.'); musicIds.add(track.id as string); text(track.title, true); strings(track.topics); url(track.src, 'audio', true); image(track.cover, track.coverAlt); }
  }
  for (const [path, value] of json) {
    try {
      if (path === 'src/content/site.json') {
        keys(value, ['name', 'description', 'intro', 'status', 'githubUrl', 'featuredPost', 'newsletterHeading', 'newsletterButtonLabel', 'newsletterUrl', 'newsletterFormAction', 'maintenanceEnabled', 'maintenanceHeading', 'maintenanceMessage', 'watermarkText', 'game']);
        text(value.name, true);
        for (const [field, item] of Object.entries(value)) if (!['game', 'maintenanceEnabled'].includes(field)) text(item);
        try { normalizeWatermarkCredit(value.watermarkText) || normalizeWatermarkCredit(`© ${(value.name as string).trim()}`); }
        catch { throw new EditorError(watermarkCreditError); }
        requireValue(value.maintenanceEnabled === undefined || typeof value.maintenanceEnabled === 'boolean', 'Maintenance enabled must be a boolean.');
        url(value.githubUrl); url(value.newsletterUrl);
        if (text(value.newsletterUrl)) {
          const newsletter = new URL(value.newsletterUrl);
          requireValue(newsletter.protocol === 'https:' && !newsletter.username && !newsletter.password && !/(^|\.)(example\.(com|net|org)|example|localhost|invalid|test)$/.test(newsletter.hostname), 'Use a real absolute HTTPS newsletter subscription URL.');
        }
        if (text(value.newsletterFormAction)) { const action = new URL(value.newsletterFormAction); requireValue(action.protocol === 'https:' && action.hostname === 'api.follow.it' && action.pathname.startsWith('/subscription-form/') && !action.username && !action.password, 'Unsupported newsletter form endpoint.'); text(value.newsletterButtonLabel, true); }
        if (text(value.featuredPost)) requireValue(posts.get(value.featuredPost)?.published, 'Featured post must be published.');
        if (value.game !== undefined) { const game = object(value.game); keys(game, ['title', 'description', 'status', 'cover', 'coverAlt', 'trailerUrl', 'links']); for (const key of ['title', 'description', 'status']) text(game[key]); image(game.cover, game.coverAlt); url(game.trailerUrl, 'video', false, true); links(game.links); }
      } else if (path.startsWith('src/content/pages/')) {
        const about = path === 'src/content/pages/about.json';
        keys(value, ['title', 'eyebrow', 'intro', ...(about ? ['body', 'avatar', 'avatarAlt', 'photos', 'media', 'links'] : []), ...(path === 'src/content/pages/subscribe.json' ? ['rssDescription'] : [])]);
        text(value.title, true); text(value.eyebrow); text(value.intro);
        if (about) { markdown(value.body); image(value.avatar, value.avatarAlt); photos(value.photos); media(value.media); links(value.links); }
        if (path === 'src/content/pages/subscribe.json') text(value.rssDescription, true);
      } else if (path === 'src/content/windows.json') {
        keys(value, ['windows']); requireValue(Array.isArray(value.windows) && value.windows.length <= 200, 'Provide at most 200 windows.');
        const ids = new Set<string>();
        for (const item of value.windows) {
          const window = object(item); keys(window, ['id', 'page', 'title', 'enabled', 'tone', 'floating', 'initiallyClosed', 'width', 'height', 'x', 'y', 'content', 'body', 'media', 'links', 'items', 'limit']);
          requireValue(typeof window.id === 'string' && slug.test(window.id) && !ids.has(window.id), 'Invalid or duplicate window ID.'); ids.add(window.id);
          const builtin = Object.hasOwn(builtinWindowPages, window.id);
          requireValue(builtin || window.id.startsWith('custom-'), 'New window IDs must start with custom-.');
          requireValue(windowPages.includes(window.page as string) && (!builtin || window.page === builtinWindowPages[window.id as keyof typeof builtinWindowPages]), 'Invalid window page.');
          requireValue(windowContents.includes(window.content as string) && (builtin || window.content !== 'default') && windowTones.includes(window.tone as string), 'Invalid window content or tone.');
          for (const field of ['enabled', 'floating', 'initiallyClosed']) requireValue(typeof window[field] === 'boolean', 'Window flags must be booleans.');
          for (const field of ['width', 'height', 'limit']) requireValue(Number.isSafeInteger(window[field]) && Number(window[field]) >= 0, 'Invalid window size or item limit.');
          for (const field of ['x', 'y']) requireValue(window[field] === undefined || Number.isSafeInteger(window[field]) && Math.abs(Number(window[field])) <= 10000, 'Invalid window position.');
          requireValue(typeof window.title === 'string' && typeof window.body === 'string', 'Window title and body must be text strings.');
          text(window.title, window.enabled === true); text(window.body); markdown(window.body);
          requireValue(Array.isArray(window.media) && Array.isArray(window.links) && Array.isArray(window.items), 'Window media, links and items must be arrays.');
          for (const value of window.media) {
            const item = object(value);
            requireValue(['src', 'alt', 'caption', 'poster'].every(field => typeof item[field] === 'string'), 'Window media requires text src, alt, caption and poster fields.');
          }
          media(window.media); links(window.links); const selected = strings(window.items); requireValue(new Set(selected).size === selected.length, 'Duplicate selected item.');
          if (window.enabled) for (const id of selected) requireValue(window.content === 'gallery' ? galleryIds.has(id) : window.content === 'music' ? musicIds.has(id) : ['devlog', 'life'].includes(String(window.content)) && posts.get(id)?.published && posts.get(id)?.section === window.content, 'Window selects a missing or unpublished item.');
          if (systemWindowIds.includes(window.id)) requireValue(window.enabled === true && window.floating === true && window.content === 'default' && (window.id !== 'start-menu' || window.initiallyClosed === true), 'Keep required system window controls enabled.');
        }
        requireValue(systemWindowIds.every(id => ids.has(id)), 'Required system windows cannot be removed.');
      }
    } catch (error) { throw new EditorError(`${path}: ${error instanceof EditorError ? error.message : 'Invalid content structure.'}`); }
  }
}
