import type { EditorMediaEntry } from './editor-types';

/**
 * The privacy and container checks for prepared media, shared by the browser (before it uploads
 * anything to GitHub) and the local editor stand-in. Prepared files must be exactly what the
 * local converters emit: no camera, location or other private metadata can ride along.
 */
export class MediaCheckError extends Error {}

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new MediaCheckError(message);
}

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

function container(bytes: Uint8Array, extension: string, entry: EditorMediaEntry): void {
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
      throw new MediaCheckError('Unterminated GIF data.');
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
/** Check a prepared file against its registry entry: digest, filename, container and metadata. */
export async function checkPreparedMedia(path: string, entry: EditorMediaEntry, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
  const match = /^\/media\/[a-z0-9]+(?:-[a-z0-9]+)*-preview-([a-f0-9]{32})\.(webp|gif|mp3|mp4)$/.exec(path);
  requireValue(match && entry.sha256.startsWith(match[1]), 'Preview filename must match its digest.');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  requireValue(Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('') === entry.sha256, 'Preview digest does not match its bytes.');
  try { container(bytes, match[2], entry); }
  catch (error) { if (error instanceof MediaCheckError) throw error; throw new MediaCheckError('Invalid prepared media container.'); }
}
