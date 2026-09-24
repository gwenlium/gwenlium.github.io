import { parseDocument } from 'yaml';
import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Root, RootContent } from 'mdast';
import { builtinWindowPages, systemWindowIds, windowContents, windowPages, windowTones } from '../../src/lib/window-catalogue.mjs';
import type { EditorMediaEntry, EditorPublishRequest } from '../../src/lib/editor-types';
import { normalizeWatermarkCredit, watermarkCreditError } from '../../src/lib/watermark.mjs';

export const registryPath = 'src/content/media-previews.json';
export const maxTextBytes = 1024 * 1024;
export const maxMediaBytes = 32 * 1024 * 1024;
export const maxRequestBytes = 48 * 1024 * 1024;
export const shaPattern = /^[a-f0-9]{40}$/;
export const mediaFilePattern = /^public\/media\/[a-z0-9]+(?:-[a-z0-9]+)*-preview-[a-f0-9]{32}\.(?:webp|gif|mp3|mp4)$/;
const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const previewPattern = /^\/media\/([a-z0-9]+(?:-[a-z0-9]+)*)-preview-([a-f0-9]{32})\.(webp|gif|mp3|mp4)$/;
const kinds: Record<string, string> = { webp: 'image', gif: 'image', mp3: 'audio', mp4: 'video' };
const encoder = new TextEncoder();
// Only the box families emitted by the local H.264/AAC preview converter.
// Unknown camera/location/UUID metadata must not become public by being nested.
const mp4Children: Record<string, readonly string[]> = {
  root: ['ftyp', 'moov', 'free', 'mdat'], moov: ['mvhd', 'trak', 'udta'],
  trak: ['tkhd', 'edts', 'mdia'], edts: ['elst'], mdia: ['mdhd', 'hdlr', 'minf'],
  minf: ['vmhd', 'smhd', 'dinf', 'stbl'], dinf: ['dref'], dref: ['url '],
  stbl: ['stsd', 'stts', 'stss', 'ctts', 'stsc', 'stsz', 'stco', 'co64', 'sgpd', 'sbgp'],
  stsd: ['avc1', 'mp4a'], avc1: ['avcC', 'pasp', 'btrt', 'colr'], mp4a: ['esds', 'btrt'],
  udta: ['meta'], meta: ['hdlr', 'ilst'], ilst: ['©too'], '©too': ['data'],
};

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
  keys(entry, ['sha256', 'kind', 'width', 'height', 'duration']);
  requireValue(typeof entry.sha256 === 'string' && /^[a-f0-9]{64}$/.test(entry.sha256) && entry.kind === kinds[match[3]], 'Invalid preview digest or media kind.');
  for (const field of ['width', 'height']) if (entry[field] !== undefined) requireValue(Number.isSafeInteger(entry[field]) && Number(entry[field]) > 0 && Number(entry[field]) <= 8192, 'Invalid preview dimensions.');
  if (entry.duration !== undefined) requireValue(typeof entry.duration === 'number' && Number.isFinite(entry.duration) && entry.duration > 0 && entry.duration <= 86400, 'Invalid preview duration.');
  return entry as unknown as EditorMediaEntry;
}
export function previewRegistry(content: string): Record<string, EditorMediaEntry> {
  const registry = parseJson(content);
  keys(registry, ['files']);
  const files = object(registry.files);
  for (const [path, entry] of Object.entries(files)) metadata(path, entry);
  return files as Record<string, EditorMediaEntry>;
}
function magic(bytes: Uint8Array, extension: string, entry: EditorMediaEntry): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number, value: string) => [...value].every((character, index) => bytes[offset + index] === character.charCodeAt(0));
  let width: number | undefined;
  let height: number | undefined;
  if (extension === 'webp') {
    requireValue(bytes.length >= 30 && tag(0, 'RIFF') && tag(8, 'WEBP') && view.getUint32(4, true) + 8 === bytes.length, 'Invalid prepared WebP.');
    let image = false;
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const length = view.getUint32(offset + 4, true);
      requireValue(offset + 8 + length <= bytes.length, 'Truncated WebP chunk.');
      requireValue(!tag(offset, 'EXIF') && !tag(offset, 'XMP ') && !tag(offset, 'ANIM') && !tag(offset, 'ANMF'), 'WebP previews must be still images without private metadata.');
      if (tag(offset, 'VP8X')) {
        requireValue(length === 10 && (bytes[offset + 8] & 0x2e) === 0, 'Unsupported WebP metadata.');
        width = 1 + bytes[offset + 12] + (bytes[offset + 13] << 8) + (bytes[offset + 14] << 16);
        height = 1 + bytes[offset + 15] + (bytes[offset + 16] << 8) + (bytes[offset + 17] << 16);
      } else if (tag(offset, 'VP8 ')) {
        requireValue(length >= 10 && tag(offset + 11, '\x9d\x01\x2a'), 'Invalid WebP image frame.');
        width ??= view.getUint16(offset + 14, true) & 0x3fff;
        height ??= view.getUint16(offset + 16, true) & 0x3fff;
        image = true;
      } else if (tag(offset, 'VP8L')) {
        requireValue(length >= 5 && bytes[offset + 8] === 0x2f, 'Invalid lossless WebP frame.');
        const bits = view.getUint32(offset + 9, true);
        width ??= (bits & 0x3fff) + 1;
        height ??= ((bits >>> 14) & 0x3fff) + 1;
        image = true;
      }
      offset += 8 + length + (length % 2);
      requireValue(offset <= bytes.length, 'Invalid WebP chunk padding.');
    }
    requireValue(image && entry.duration === undefined, 'WebP must contain a still image.');
  } else if (extension === 'gif') {
    requireValue(bytes.length >= 14 && (tag(0, 'GIF89a') || tag(0, 'GIF87a')) && bytes.at(-1) === 0x3b, 'Invalid prepared GIF.');
    width = view.getUint16(6, true); height = view.getUint16(8, true);
    let offset = 13 + ((bytes[10] & 0x80) ? 3 * (1 << ((bytes[10] & 7) + 1)) : 0);
    let frames = 0; let duration = 0;
    const subblocks = (): void => {
      while (offset < bytes.length) {
        const size = bytes[offset++];
        requireValue(offset + size <= bytes.length, 'Truncated GIF data.');
        offset += size;
        if (size === 0) return;
      }
      throw new EditorError('Unterminated GIF data.');
    };
    while (offset < bytes.length - 1) {
      const marker = bytes[offset++];
      if (marker === 0x21) {
        const label = bytes[offset++];
        if (label === 0xf9) {
          requireValue(offset + 6 <= bytes.length && bytes[offset] === 4 && bytes[offset + 5] === 0, 'Invalid GIF frame control.');
          duration += Math.max(1, view.getUint16(offset + 2, true)) / 100;
          offset += 6;
        } else {
          requireValue(label === 0xff && bytes[offset] === 11 && tag(offset + 1, 'NETSCAPE2.0'), 'GIF previews cannot contain private comments or metadata.');
          subblocks();
        }
      } else {
        requireValue(marker === 0x2c && offset + 9 <= bytes.length, 'Invalid GIF image frame.');
        requireValue(view.getUint16(offset, true) + view.getUint16(offset + 4, true) <= width && view.getUint16(offset + 2, true) + view.getUint16(offset + 6, true) <= height, 'GIF frame exceeds its canvas.');
        const packed = bytes[offset + 8];
        offset += 9 + ((packed & 0x80) ? 3 * (1 << ((packed & 7) + 1)) : 0);
        requireValue(bytes[offset] >= 2 && bytes[offset] <= 8, 'Invalid GIF image coding.'); offset++;
        subblocks(); frames++;
      }
    }
    requireValue(offset === bytes.length - 1 && frames > 0 && entry.duration !== undefined && Math.abs(duration - entry.duration) <= 0.02, 'GIF duration does not match its frames.');
  } else if (extension === 'mp3') {
    requireValue(entry.duration !== undefined && entry.width === undefined && entry.height === undefined, 'Invalid audio metadata.');
    let offset = 0; let frames = 0;
    const bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
    while (offset + 4 <= bytes.length) {
      const bitrate = bitrates[bytes[offset + 2] >>> 4];
      requireValue(bytes[offset] === 0xff && (bytes[offset + 1] & 0xfe) === 0xfa && (bytes[offset + 2] & 0x0c) === 0 && bitrate, 'Audio must be a prepared 44.1 kHz MP3 without ID3 metadata.');
      offset += Math.floor(144000 * bitrate / 44100) + ((bytes[offset + 2] >>> 1) & 1);
      requireValue(offset <= bytes.length, 'Truncated MP3 frame.'); frames++;
    }
    requireValue(offset === bytes.length && frames > 0 && Math.abs(frames * 1152 / 44100 - entry.duration) < 0.2, 'MP3 duration does not match its frames.');
  } else {
    requireValue(bytes.length >= 24 && tag(4, 'ftyp') && view.getUint32(0) >= 16, 'Video must be a prepared MP4.');
    requireValue(entry.width !== undefined && entry.width >= 2 && entry.width <= 1280 && entry.width % 2 === 0 && entry.height !== undefined && entry.height >= 2 && entry.height % 2 === 0, 'Video previews require even dimensions and a maximum width of 1280 pixels.');
    let moov = false; let mdat = false; let video = false; let videoCodec = false; let duration: number | undefined;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const boxes = (start: number, end: number, parent: string, depth: number): void => {
      requireValue(depth <= 8, 'Invalid MP4 nesting.');
      let offset = start;
      while (offset + 8 <= end) {
        const size = view.getUint32(offset);
        requireValue(size >= 8 && offset + size <= end, 'Invalid MP4 container.');
        const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
        requireValue(mp4Children[parent]?.includes(type), 'MP4 previews cannot contain original camera, location or private metadata.');
        let childStart = offset + 8;
        if (type === 'moov') { requireValue(!moov, 'Duplicate MP4 movie.'); moov = true; }
        else if (type === 'mdat') { requireValue(size > 8, 'Empty MP4 media data.'); mdat = true; }
        else if (type === 'free') requireValue(bytes.subarray(offset + 8, offset + size).every(byte => byte === 0), 'MP4 padding cannot contain private metadata.');
        else if (type === 'mvhd' || type === 'mdhd' || type === 'tkhd') {
          const version = bytes[offset + 8];
          requireValue((version === 0 || version === 1) && size >= (type === 'tkhd' ? (version ? 104 : 92) : (version ? 44 : 32)), 'Unsupported MP4 track or timing header.');
          const timeEnd = offset + (version ? 28 : 20);
          requireValue(bytes.subarray(offset + 12, timeEnd).every(byte => byte === 0), 'MP4 creation and modification dates must be removed.');
          if (type === 'mvhd') {
            const timescale = view.getUint32(timeEnd);
            requireValue(timescale > 0, 'Invalid MP4 timescale.');
            duration = (version ? Number(view.getBigUint64(timeEnd + 4)) : view.getUint32(timeEnd + 4)) / timescale;
          } else if (type === 'tkhd') {
            const trackWidth = view.getUint32(offset + size - 8) / 65536;
            const trackHeight = view.getUint32(offset + size - 4) / 65536;
            if (trackWidth || trackHeight) { requireValue(trackWidth === entry.width && trackHeight === entry.height, 'MP4 dimensions do not match its track.'); video = true; }
          }
        } else if (type === 'hdlr') {
          requireValue(size >= 33, 'Invalid MP4 handler.');
          const name = decoder.decode(bytes.subarray(offset + 32, offset + size)).replace(/\0+$/, '');
          requireValue(['', 'VideoHandler', 'SoundHandler'].includes(name) && (tag(offset + 16, 'vide') || tag(offset + 16, 'soun') || parent === 'meta' && tag(offset + 16, 'mdir')), 'MP4 handler metadata must be removed.');
        } else if (type === 'stsd' || type === 'dref') {
          requireValue(size >= 16 && view.getUint32(offset + 8) === 0 && view.getUint32(offset + 12) === 1, 'Unsupported MP4 sample or data reference.');
          childStart = offset + 16;
        } else if (type === 'url ') requireValue(size === 12 && view.getUint32(offset + 8) === 1, 'MP4 previews cannot reference external media.');
        else if (type === 'avc1') {
          requireValue(size >= 86 && view.getUint16(offset + 32) === entry.width && view.getUint16(offset + 34) === entry.height, 'Invalid H.264 sample dimensions.');
          const nameLength = bytes[offset + 50];
          requireValue(nameLength <= 31, 'Invalid H.264 encoder metadata.');
          const name = decoder.decode(bytes.subarray(offset + 51, offset + 51 + nameLength));
          requireValue(name === '' || /^Lavc[0-9.]+ libx264$/.test(name), 'H.264 encoder metadata must be generated locally.');
          childStart = offset + 86; videoCodec = true;
        } else if (type === 'mp4a') { requireValue(size >= 36, 'Invalid AAC sample description.'); childStart = offset + 36; }
        else if (type === 'colr') requireValue((size === 18 && tag(offset + 8, 'nclc')) || (size === 19 && tag(offset + 8, 'nclx')), 'MP4 embedded color profiles are not permitted.');
        else if (type === 'meta') { requireValue(size >= 12 && view.getUint32(offset + 8) === 0, 'Unsupported MP4 metadata.'); childStart = offset + 12; }
        else if (type === 'data') {
          requireValue(size >= 17 && size <= 64 && view.getUint32(offset + 8) === 1 && view.getUint32(offset + 12) === 0, 'Unsupported MP4 metadata value.');
          requireValue(/^Lavf[0-9.]+$/.test(decoder.decode(bytes.subarray(offset + 16, offset + size))), 'Only generated FFmpeg encoder metadata may remain.');
        }
        if (Object.hasOwn(mp4Children, type)) boxes(childStart, offset + size, type, depth + 1);
        offset += size;
      }
      requireValue(offset === end, 'Truncated MP4 box.');
    };
    boxes(0, bytes.length, 'root', 0);
    requireValue(moov && mdat && video && videoCodec && duration !== undefined && entry.duration !== undefined && Math.abs(duration - entry.duration) <= 0.2, 'Incomplete MP4 or inconsistent duration metadata.');
  }
  if (entry.kind === 'image') requireValue(width && height && width === entry.width && height === entry.height && Math.max(width, height) <= 1600, 'Prepared image dimensions do not match its bytes.');
}
export async function publishPayload(value: unknown): Promise<EditorPublishRequest> {
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
  let mediaBytes = 0;
  for (const value of request.media) {
    const upload = object(value); keys(upload, ['path', 'content', 'entry']);
    requireValue(typeof upload.path === 'string' && upload.path.startsWith('public/media/') && !seen.has(upload.path), 'Disallowed or duplicate media path.');
    seen.add(upload.path);
    const path = upload.path.slice(6);
    const entry = metadata(path, upload.entry);
    const match = previewPattern.exec(path)!;
    requireValue(entry.sha256.startsWith(match[2]), 'Preview filename must match its digest.');
    requireValue(typeof upload.content === 'string', 'Media content must be base64.');
    const bytes = decodeBase64(upload.content, maxMediaBytes);
    mediaBytes += bytes.length;
    requireValue(mediaBytes <= maxMediaBytes, 'Publish at most 32 MiB of prepared media at a time.');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    requireValue(Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('') === entry.sha256, 'Preview digest does not match its bytes.');
    try { magic(bytes, match[3], entry); }
    catch (error) { if (error instanceof EditorError) throw error; throw new EditorError('Invalid prepared media container.'); }
  }
  return request as unknown as EditorPublishRequest;
}

export function validateContent(files: Map<string, string>, previews: Record<string, EditorMediaEntry>, exists: (path: string) => boolean, siteOrigin: string): void {
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
      requireValue((!kind || kind === 'image') && exists(`public${parsed.pathname}`), 'Missing public branding image.'); return;
    }
    const entry = previews[parsed.pathname];
    requireValue(entry && (!kind || kind === entry.kind) && exists(`public${parsed.pathname}`), 'Missing preview or incorrect media kind. Prepare the media before publishing.');
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
      if (node.type === 'link' || node.type === 'image' || node.type === 'definition') url(node.url, node.type === 'image' ? 'image' : undefined, true);
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
