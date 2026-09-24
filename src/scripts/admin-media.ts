import classWorkerURL from '@ffmpeg/ffmpeg/worker?worker&url';
import coreURL from '@ffmpeg/core?url';
import wasmURL from '@ffmpeg/core/wasm?url';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { normalizeWatermarkCredit, watermarkCreditError, watermarkLayout } from '../lib/watermark.mjs';

type PreviewMetadata =
  | { kind: 'image'; width: number; height: number; duration?: number }
  | { kind: 'video'; width: number; height: number; duration: number }
  | { kind: 'audio'; duration: number };
export type PreviewInputKind = 'image' | 'animation' | 'audio' | 'video';

export type PreparedPreview = {
  file: File;
  url: string;
  entry: PreviewMetadata & { sha256: string };
};

type PreviewOptions = {
  creator: string;
  name?: string;
  start?: number;
  duration?: number;
  fullLength?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: number | undefined) => void;
};
type Settings = PreviewOptions & { start: number; duration: number };
type Dimensions = { width: number; height: number };
type CanvasSurface = { element: HTMLCanvasElement; context: CanvasRenderingContext2D };
type Raster = Dimensions & { mime: string; delays?: number[] };
type Generated = { blob: Blob; extension: 'webp' | 'gif' | 'mp4' | 'mp3'; entry: PreviewMetadata };
type ImageFrame = CanvasImageSource & { displayWidth: number; displayHeight: number; close(): void };
type AnimationDecoder = {
  tracks: { ready: Promise<void>; selectedTrack?: { frameCount: number } };
  decode(options: { frameIndex: number; completeFramesOnly: boolean }): Promise<{ image: ImageFrame; complete: boolean }>;
  close(): void;
};
type AnimationDecoderConstructor = {
  new(options: { data: ArrayBuffer; type: string; preferAnimation: boolean }): AnimationDecoder;
  isTypeSupported(type: string): Promise<boolean>;
};
type Probe = {
  streams?: Array<{
    index: number;
    codec_type?: string;
    width?: number;
    height?: number;
    disposition?: { attached_pic?: number };
  }>;
  format?: { duration?: string };
};

const MiB = 1024 * 1024;
const imageBytes = 32 * MiB;
const videoBytes = 128 * MiB;
const outputBytes = 32 * MiB;
const maxEdge = 8192;
const maxPixels = 40_000_000;
const maxFrames = 1800;
const maxAnimationPixels = 512_000_000;
const mediaDemuxers = 'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,ogg,mp3,wav,flac,aac,aiff,asf,mpeg,mpegts';
const stripMetadata = ['-map_metadata', '-1', '-map_metadata:s', '-1', '-map_chapters', '-1', '-metadata', 'encoder='];
const conversionError = 'This media could not be converted safely. It may be corrupt, use an unsupported codec, or exceed browser memory. Export a smaller supported copy locally; the original was not uploaded.';
let queue: Promise<unknown> = Promise.resolve();
const audioExtensions = new Set(['mp3', 'wav', 'flac', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'aif', 'aiff', 'wma']);
const videoExtensions = new Set(['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'ogv', 'mpg', 'mpeg', 'mts', 'm2ts']);
const imageMetadata = new WeakMap<File, Raster>();

class PreviewError extends Error {}

function fail(message: string): never {
  throw new PreviewError(message);
}

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Preview preparation was cancelled.', 'AbortError');
}

function abortable<T>(operation: Promise<T>, signal?: AbortSignal, dispose?: (value: T) => void): Promise<T> {
  if (!signal) return operation;
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const abort = () => reject(new DOMException('Preview preparation was cancelled.', 'AbortError'));
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  operation.then((value) => {
    signal.removeEventListener('abort', abort);
    if (signal.aborted) dispose?.(value);
    else resolve(value);
  }, (error: unknown) => {
    signal.removeEventListener('abort', abort);
    reject(error);
  });
  return promise;
}

function progress(options: PreviewOptions, value?: number) {
  // A caller's progress renderer must not compromise cleanup or media preparation.
  try { options.onProgress?.(value); } catch { /* UI callbacks are not conversion failures. */ }
}

function bytes(blob: Blob, signal?: AbortSignal): Promise<ArrayBuffer> {
  checkAbort(signal);
  const { promise, resolve, reject } = Promise.withResolvers<ArrayBuffer>();
  const reader = new FileReader();
  const abort = () => reader.abort();
  const finish = () => signal?.removeEventListener('abort', abort);
  reader.onload = () => {
    finish();
    if (reader.result instanceof ArrayBuffer) resolve(reader.result);
    else reject(new PreviewError('The selected local file could not be read.'));
  };
  reader.onerror = () => { finish(); reject(new PreviewError('The selected local file could not be read.')); };
  reader.onabort = () => { finish(); reject(new DOMException('Preview preparation was cancelled.', 'AbortError')); };
  signal?.addEventListener('abort', abort, { once: true });
  reader.readAsArrayBuffer(blob);
  return promise;
}

function dimensions(width: number, height: number, stillPhoto = false): Dimensions {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) fail('The media has no valid dimensions.');
  const edgeLimit = stillPhoto ? 16384 : maxEdge;
  const pixelLimit = stillPhoto ? 80_000_000 : maxPixels;
  if (width > edgeLimit || height > edgeLimit || width * height > pixelLimit) fail(stillPhoto ? 'Still photos must be at most 16384 pixels per edge and 80 megapixels.' : 'Source frames must be at most 8192 pixels per edge and 40 megapixels. Resize the original locally first.');
  return { width, height };
}

function bounded(width: number, height: number, edge: number): Dimensions {
  const scale = Math.min(1, edge / width, edge / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function text(data: Uint8Array, start: number, length: number) {
  return String.fromCharCode(...data.subarray(start, start + length));
}

function rasterMime(data: Uint8Array): string | undefined {
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (text(data, 0, 8) === '\x89PNG\r\n\x1a\n') return 'image/png';
  if (['GIF87a', 'GIF89a'].includes(text(data, 0, 6))) return 'image/gif';
  if (text(data, 0, 4) === 'RIFF' && text(data, 8, 4) === 'WEBP') return 'image/webp';
  return undefined;
}

function inspectRaster(data: Uint8Array): Raster {
  const mime = rasterMime(data);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const need = (position: number, length: number) => {
    if (position < 0 || length < 0 || position + length > data.length) fail('The image is truncated or corrupt.');
  };
  const u24 = (position: number) => data[position]! + data[position + 1]! * 256 + data[position + 2]! * 65536;
  if (mime === 'image/jpeg') {
    let size: Dimensions | undefined;
    let position = 2;
    while (position < data.length) {
      if (data[position++] !== 0xff) fail('The JPEG header is corrupt.');
      while (data[position] === 0xff) position++;
      const marker = data[position++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker !== undefined && marker >= 0xd0 && marker <= 0xd7)) continue;
      need(position, 2);
      const length = view.getUint16(position);
      if (length < 2) fail('The JPEG header is corrupt.');
      need(position, length);
      // APP2 MPF metadata can describe a camera thumbnail or HDR gain map.
      // Decode the primary photograph; canvas re-encoding strips auxiliary images and metadata.
      if (marker !== undefined && [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 8) fail('The JPEG dimensions are corrupt.');
        size = dimensions(view.getUint16(position + 5), view.getUint16(position + 3), true);
      }
      position += length;
    }
    if (!size) fail('The JPEG has no readable dimensions.');
    return { mime, ...size };
  }
  if (mime === 'image/png') {
    need(0, 33);
    if (text(data, 12, 4) !== 'IHDR' || view.getUint32(8) !== 13) fail('The PNG header is corrupt.');
    const size = dimensions(view.getUint32(16), view.getUint32(20));
    let position = 8;
    let ended = false;
    while (position < data.length) {
      need(position, 12);
      const length = view.getUint32(position);
      const tag = text(data, position + 4, 4);
      need(position, length + 12);
      if (tag === 'acTL') fail('APNG is not flattened. Export an animated GIF/WebP locally instead.');
      position += length + 12;
      if (tag === 'IEND') { ended = true; break; }
    }
    if (!ended) fail('The PNG is incomplete.');
    return { mime, ...size };
  }
  if (mime === 'image/gif') {
    need(0, 13);
    const size = dimensions(view.getUint16(6, true), view.getUint16(8, true));
    let position = 13 + ((data[10]! & 0x80) ? 3 * 2 ** ((data[10]! & 7) + 1) : 0);
    let delay = 100;
    let ended = false;
    const delays: number[] = [];
    const subblocks = () => {
      while (true) {
        need(position, 1);
        const length = data[position++]!;
        if (!length) break;
        need(position, length);
        position += length;
      }
    };
    while (position < data.length) {
      const marker = data[position++]!;
      if (marker === 0x3b) { ended = true; break; }
      if (marker === 0x21) {
        need(position, 1);
        const label = data[position++]!;
        if (label === 0xf9) {
          need(position, 6);
          if (data[position] !== 4 || data[position + 5] !== 0) fail('The GIF timing data is corrupt.');
          delay = Math.max(10, view.getUint16(position + 2, true) * 10 || 100);
        }
        subblocks();
      } else if (marker === 0x2c) {
        need(position, 9);
        const left = view.getUint16(position, true);
        const top = view.getUint16(position + 2, true);
        const width = view.getUint16(position + 4, true);
        const height = view.getUint16(position + 6, true);
        if (!width || !height || left + width > size.width || top + height > size.height) fail('The GIF frame dimensions are corrupt.');
        const packed = data[position + 8]!;
        position += 9 + ((packed & 0x80) ? 3 * 2 ** ((packed & 7) + 1) : 0);
        need(position, 1);
        position++;
        subblocks();
        delays.push(delay);
        delay = 100;
        if (delays.length > maxFrames) fail('Animations may contain at most 1800 frames. Export a shorter animation locally first.');
      } else fail('The GIF contains an unsupported or corrupt block.');
    }
    if (!ended || !delays.length) fail('The GIF is incomplete.');
    return { mime, ...size, delays };
  }
  if (mime === 'image/webp') {
    need(0, 20);
    const end = view.getUint32(4, true) + 8;
    need(0, end);
    let position = 12;
    let size: Dimensions | undefined;
    let animation = false;
    let orientationMetadata = false;
    const delays: number[] = [];
    while (position < end) {
      need(position, 8);
      const tag = text(data, position, 4);
      const length = view.getUint32(position + 4, true);
      const body = position + 8;
      need(body, length + (length % 2));
      if (body + length > end) fail('The WebP chunk data is corrupt.');
      if (tag === 'VP8X') {
        if (length !== 10) fail('The WebP header is corrupt.');
        size = dimensions(u24(body + 4) + 1, u24(body + 7) + 1);
        animation = Boolean(data[body]! & 2);
      } else if (tag === 'VP8 ' && !size) {
        if (length < 10 || text(data, body + 3, 3) !== '\x9d\x01\x2a') fail('The WebP frame header is corrupt.');
        size = dimensions(view.getUint16(body + 6, true) & 0x3fff, view.getUint16(body + 8, true) & 0x3fff);
      } else if (tag === 'VP8L' && !size) {
        if (length < 5 || data[body] !== 0x2f) fail('The WebP frame header is corrupt.');
        const packed = view.getUint32(body + 1, true);
        size = dimensions((packed & 0x3fff) + 1, ((packed >>> 14) & 0x3fff) + 1);
      } else if (tag === 'ANMF') {
        if (length < 16 || !size || u24(body) * 2 + u24(body + 6) + 1 > size.width || u24(body + 3) * 2 + u24(body + 9) + 1 > size.height) fail('The animated WebP frame header is corrupt.');
        delays.push(Math.max(10, u24(body + 12) || 100));
        if (delays.length > maxFrames) fail('Animations may contain at most 1800 frames. Export a shorter animation locally first.');
      } else if (tag === 'EXIF') orientationMetadata = true;
      position = body + length + (length % 2);
    }
    if (!size || position !== end || animation !== (delays.length > 0)) fail('The WebP image structure is incomplete or inconsistent.');
    // Browser ImageDecoder implementations disagree on animated EXIF orientation.
    if (animation && orientationMetadata) fail('Animated WebP with EXIF metadata needs an orientation-normalized local export first. No frames were flattened.');
    return { mime, ...size, ...(animation ? { delays } : {}) };
  }
  return fail('Supported still images are JPEG, PNG, WebP and GIF. SVG, APNG, AVIF and TIFF need a supported local export.');
}

/** Classify local input for the picker without uploading or decoding its media. */
export async function previewInputKind(file: File, signal?: AbortSignal): Promise<PreviewInputKind> {
  checkAbort(signal);
  if (!(file instanceof File) || !file.size) fail('Choose a nonempty local media file.');
  if (file.size > videoBytes) fail('Originals must be at most 128 MiB (32 MiB for images). Trim or resize the original locally first.');
  const mime = rasterMime(new Uint8Array(await bytes(file.slice(0, 64), signal)));
  if (mime) {
    if (file.size > imageBytes) fail('Image originals must be at most 32 MiB. Resize the original locally first.');
    if (mime === 'image/gif' || mime === 'image/webp') {
      let raster = imageMetadata.get(file);
      if (!raster) {
        raster = inspectRaster(new Uint8Array(await bytes(file, signal)));
        imageMetadata.set(file, raster);
      }
      if (raster.delays && (raster.mime === 'image/webp' || raster.delays.length > 1)) return 'animation';
    }
    return 'image';
  }
  const extension = file.name.split('.').at(-1)?.toLowerCase() || '';
  if (audioExtensions.has(extension)) return 'audio';
  if (videoExtensions.has(extension)) return 'video';
  return fail('Choose JPEG, PNG, WebP, GIF, a supported audio file, or a supported video file. SVG, APNG, AVIF and TIFF need a supported local export.');
}

function canvas(size: Dimensions): CanvasSurface {
  const element = document.createElement('canvas');
  element.width = size.width;
  element.height = size.height;
  const context = element.getContext('2d');
  if (!context) fail('This browser cannot create a 2D canvas for safe preview preparation.');
  return { element, context };
}

function encodeCanvas(element: HTMLCanvasElement, type: string, signal?: AbortSignal): Promise<Blob> {
  checkAbort(signal);
  const { promise, resolve, reject } = Promise.withResolvers<Blob>();
  element.toBlob((blob) => {
    if (!blob || blob.type !== type) reject(new PreviewError(`This browser cannot encode ${type === 'image/webp' ? 'WebP' : 'PNG'} previews.`));
    else resolve(blob);
  }, type, type === 'image/webp' ? 0.78 : undefined);
  return abortable(promise, signal);
}

function stripWebpMetadata(data: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < 12 || view.getUint32(0, true) !== 0x46464952 || view.getUint32(8, true) !== 0x50424557 || view.getUint32(4, true) + 8 !== data.length) fail('The browser produced an invalid WebP image.');
  let output = 12;
  for (let offset = 12; offset < data.length;) {
    if (offset + 8 > data.length) fail('The browser produced a truncated WebP image.');
    const kind = view.getUint32(offset, true);
    const length = view.getUint32(offset + 4, true);
    const end = offset + 8 + length + (length & 1);
    if (end > data.length) fail('The browser produced a truncated WebP chunk.');
    // Canvas is sRGB. Its optional ICC profile is redundant; no EXIF or XMP
    // belongs in a public preview, even if a browser encoder adds it.
    if (kind !== 0x50434349 && kind !== 0x46495845 && kind !== 0x20504d58) {
      if (kind === 0x58385056) {
        if (length !== 10) fail('The browser produced an invalid extended WebP header.');
        data[offset + 8] &= ~0x2c;
      }
      data.copyWithin(output, offset, end);
      output += end - offset;
    }
    offset = end;
  }
  view.setUint32(4, output - 8, true);
  return data.subarray(0, output);
}

async function watermark(creator: string, size: Dimensions): Promise<HTMLCanvasElement> {
  const mark = canvas({ width: 1, height: 1 });
  const layout = await watermarkLayout(creator, size.width, size.height, (label, fontSize) => {
    mark.context.font = `500 ${fontSize}px sans-serif`;
    const metrics = mark.context.measureText(label);
    return Math.max(metrics.width, metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight);
  });
  mark.element.width = layout.width;
  mark.element.height = layout.height;
  mark.context.scale(layout.scale, layout.scale);
  mark.context.lineWidth = 2;
  mark.context.strokeStyle = 'rgba(0, 0, 0, 0.4)';
  mark.context.fillStyle = 'rgba(255, 255, 255, 0.65)';
  for (const line of layout.lines) {
    mark.context.font = `500 ${line.fontSize}px sans-serif`;
    mark.context.strokeText(line.text, line.x, line.y);
    mark.context.fillText(line.text, line.x, line.y);
  }
  return mark.element;
}

async function decodeBitmap(blob: Blob, signal?: AbortSignal, resizeWidth?: number): Promise<ImageBitmap> {
  if (typeof createImageBitmap !== 'function') fail('This browser needs createImageBitmap support to prepare image previews safely.');
  return abortable(createImageBitmap(blob, { imageOrientation: 'from-image', ...(resizeWidth ? { resizeWidth, resizeQuality: 'high' as const } : {}) }), signal, (image) => image.close());
}

async function still(blob: Blob, options: Settings, source: Dimensions): Promise<Generated> {
  const bitmap = await decodeBitmap(blob, options.signal, Math.min(1600, source.width, source.height));
  let surface: CanvasSurface | undefined;
  let mark: HTMLCanvasElement | undefined;
  try {
    dimensions(bitmap.width, bitmap.height, true);
    const size = bounded(bitmap.width, bitmap.height, 1600);
    surface = canvas(size);
    surface.context.drawImage(bitmap, 0, 0, size.width, size.height);
    mark = await watermark(options.creator, size);
    surface.context.drawImage(mark, size.width - mark.width, size.height - mark.height);
    const encoded = await encodeCanvas(surface.element, 'image/webp', options.signal);
    const output = new Blob([stripWebpMetadata(new Uint8Array(await bytes(encoded, options.signal)))], { type: 'image/webp' });
    const verified = await decodeBitmap(output, options.signal);
    try {
      if (verified.width !== size.width || verified.height !== size.height) fail('The generated image has unexpected dimensions. Nothing was prepared.');
    } finally { verified.close(); }
    return { blob: output, extension: 'webp', entry: { kind: 'image', ...size } };
  } finally {
    bitmap.close();
    if (surface) surface.element.width = surface.element.height = 1;
    if (mark) mark.width = mark.height = 1;
  }
}

async function withTranscoder<T>(options: Settings, convert: (ffmpeg: FFmpeg) => Promise<T>): Promise<T> {
  if (typeof Worker === 'undefined' || typeof WebAssembly === 'undefined') fail('This browser needs Web Workers and WebAssembly for audio, animated images and video.');
  checkAbort(options.signal);
  const ffmpeg = new FFmpeg();
  const stop = () => ffmpeg.terminate();
  options.signal?.addEventListener('abort', stop, { once: true });
  // A terminated worker also destroys its in-memory filesystem, including all originals.
  // Use a fresh instance for each job instead of keeping private media in a shared heap.
  try {
    const urls = [classWorkerURL, coreURL, wasmURL].map((url) => new URL(url, location.href));
    if (urls.some((url) => url.origin !== location.origin)) fail('The preview converter must be served from this site, not a remote CDN.');
    progress(options);
    checkAbort(options.signal);
    const timeout = Promise.withResolvers<never>();
    const timer = setTimeout(() => {
      timeout.reject(new PreviewError('The local preview converter could not load. Reload the admin page and try again.'));
      stop();
    }, 120_000);
    try {
      await Promise.race([
        ffmpeg.load({ classWorkerURL: urls[0]!.href, coreURL: urls[1]!.href, wasmURL: urls[2]!.href }),
        timeout.promise,
      ]);
    } finally { clearTimeout(timer); }
    checkAbort(options.signal);
    return await convert(ffmpeg);
  } finally {
    options.signal?.removeEventListener('abort', stop);
    stop();
  }
}

async function execute(ffmpeg: FFmpeg, args: string[]) {
  // Native/worker log messages can contain embedded source metadata; never forward them.
  if (await ffmpeg.exec(['-hide_banner', '-loglevel', 'error', ...args], 600_000) !== 0) fail(conversionError);
}

function input(filename: string, demuxers = mediaDemuxers) {
  return ['-protocol_whitelist', 'file,pipe', '-format_whitelist', demuxers, '-i', filename];
}

async function binary(ffmpeg: FFmpeg, name: string): Promise<Uint8Array<ArrayBuffer>> {
  const result = await ffmpeg.readFile(name);
  if (!(result instanceof Uint8Array)) fail('The local converter returned invalid binary media.');
  return result as Uint8Array<ArrayBuffer>;
}

async function probe(ffmpeg: FFmpeg, filename: string): Promise<Probe> {
  const code = await ffmpeg.ffprobe(['-v', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', mediaDemuxers,
    '-show_entries', 'stream=index,codec_type,width,height:stream_disposition=attached_pic:format=duration',
    '-show_error', '-of', 'json', '-o', 'probe.json', filename], 30_000);
  // core 0.12.10 leaves its return sentinel at -1 even after a successful ffprobe.
  // Require complete structured output without an error; never accept a partial probe.
  if (code !== 0 && code !== -1) fail(conversionError);
  const encoded = await ffmpeg.readFile('probe.json', 'utf8');
  await ffmpeg.deleteFile('probe.json');
  if (typeof encoded !== 'string') fail('The media has no readable stream information.');
  const value: unknown = JSON.parse(encoded);
  if (!value || typeof value !== 'object' || 'error' in value || !('streams' in value) || !Array.isArray(value.streams) || !value.streams.length) fail('The media has no readable stream information.');
  const streams: NonNullable<Probe['streams']> = [];
  for (const stream of value.streams) {
    if (!stream || typeof stream !== 'object' || !Number.isSafeInteger(stream.index) || stream.index < 0 || typeof stream.codec_type !== 'string') fail('The media stream information is invalid.');
    if (stream.codec_type === 'video') dimensions(stream.width, stream.height);
    streams.push({ index: stream.index, codec_type: stream.codec_type, width: stream.width, height: stream.height,
      disposition: { attached_pic: stream.disposition?.attached_pic === 1 ? 1 : 0 } });
  }
  const format = 'format' in value && value.format && typeof value.format === 'object' && 'duration' in value.format && typeof value.format.duration === 'string'
    ? { duration: value.format.duration } : undefined;
  return { streams, format };
}

async function viewableMedia(blob: Blob, signal?: AbortSignal): Promise<{ width?: number; height?: number; duration: number }> {
  checkAbort(signal);
  const element = document.createElement(blob.type.startsWith('video/') ? 'video' : 'audio');
  const url = URL.createObjectURL(blob);
  element.preload = 'auto';
  element.muted = true;
  if (element instanceof HTMLVideoElement) element.playsInline = true;
  try {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      element.removeEventListener('loadeddata', loaded);
      element.removeEventListener('error', error);
    };
    const loaded = () => { cleanup(); resolve(); };
    const error = () => { cleanup(); reject(new PreviewError('The generated media cannot be decoded by this browser. Nothing was prepared.')); };
    const abort = () => { cleanup(); reject(new DOMException('Preview preparation was cancelled.', 'AbortError')); };
    const timer = setTimeout(error, 30_000);
    signal?.addEventListener('abort', abort, { once: true });
    element.addEventListener('loadeddata', loaded, { once: true });
    element.addEventListener('error', error, { once: true });
    element.src = url;
    element.load();
    await promise;
    return { ...(element instanceof HTMLVideoElement ? dimensions(element.videoWidth, element.videoHeight) : {}), duration: element.duration };
  } finally {
    element.pause();
    element.removeAttribute('src');
    element.load();
    URL.revokeObjectURL(url);
  }
}

function mediaDuration(sourceDuration: number, options: Settings): number {
  if (options.fullLength) {
    if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) fail('Full-length publishing needs readable duration metadata. Export a supported local copy first.');
    return sourceDuration;
  }
  if (Number.isFinite(sourceDuration) && sourceDuration > 0 && options.start >= sourceDuration) fail('The excerpt must start before the end of the media.');
  return Math.min(options.duration, 59.9);
}

function verifyMediaDuration(actual: number, expected: number, fullLength = false): void {
  if (!Number.isFinite(actual) || actual <= 0 || (fullLength
    ? Math.abs(actual - expected) > 0.25
    : actual > 60 || actual > expected + 0.1)) {
    fail('The generated media did not preserve the selected duration. Nothing was prepared.');
  }
}

async function audio(file: File, options: Settings): Promise<Generated> {
  return withTranscoder(options, async ffmpeg => {
    await ffmpeg.writeFile('source', new Uint8Array(await bytes(file, options.signal)));
    const source = await probe(ffmpeg, 'source');
    const stream = source.streams?.find(item => item.codec_type === 'audio');
    if (!stream || source.streams?.some(item => item.codec_type === 'video' && !item.disposition?.attached_pic)) fail('Choose an audio file, not a video or a file without an audio stream.');
    const duration = mediaDuration(Number(source.format?.duration), options);
    const update = ({ time }: { time: number }) => progress(options, Math.min(0.9, Math.max(0, time / (duration * 1_000_000)) * 0.9));
    ffmpeg.on('progress', update);
    try {
      await execute(ffmpeg, ['-ss', String(options.start), ...input('source'),
        '-map', `0:${stream.index}`, ...(options.fullLength ? [] : ['-t', String(duration)]),
        '-vn', '-sn', '-dn', '-c:a', 'libmp3lame', '-b:a', options.fullLength ? '192k' : '96k', '-ar', '44100', '-ac', '2',
        ...stripMetadata, '-id3v2_version', '0', '-write_id3v1', '0', '-fs', String(outputBytes + 1), 'preview.mp3']);
    } finally { ffmpeg.off('progress', update); }
    await ffmpeg.deleteFile('source');
    const output = await binary(ffmpeg, 'preview.mp3');
    if (!output.length || output.length > outputBytes) fail('The prepared audio exceeds the 32 MiB limit or is empty. Choose a shorter excerpt.');
    const blob = new Blob([output], { type: 'audio/mpeg' });
    const playable = await viewableMedia(blob, options.signal);
    verifyMediaDuration(playable.duration, duration, options.fullLength);
    return { blob, extension: 'mp3', entry: { kind: 'audio', duration: playable.duration } };
  });
}

async function video(file: File, options: Settings): Promise<Generated> {
  return withTranscoder(options, async (ffmpeg) => {
    await ffmpeg.writeFile('source', new Uint8Array(await bytes(file, options.signal)));
    const source = await probe(ffmpeg, 'source');
    const stream = source.streams?.find((item) => item.codec_type === 'video' && !item.disposition?.attached_pic);
    if (!stream || !Number.isSafeInteger(stream.index)) fail('Select a file with a moving-video stream. Audio-only files and cover artwork are not video previews.');
    const rawSize = dimensions(stream.width ?? 0, stream.height ?? 0);
    if (rawSize.width < 2 || rawSize.height < 2) fail('H.264 previews require source frames at least 2 by 2 pixels.');
    const duration = mediaDuration(Number(source.format?.duration), options);
    const seek = ['-ss', String(options.start)];
    const displayWidth = 'iw*if(gt(sar,0),sar,1)';
    const scale = `scale=w='max(2,trunc(min(1280,${displayWidth})/2)*2)':h='max(2,trunc(ih*min(1,1280/(${displayWidth}))/2)*2)',setsar=1`;
    await execute(ffmpeg, [...seek, ...input('source'), '-map', `0:${stream.index}`, '-vf', scale,
      '-frames:v', '1', '-an', '-sn', '-dn', ...stripMetadata, 'frame.png']);
    const frame = await binary(ffmpeg, 'frame.png');
    const size = inspectRaster(frame);
    if (size.width > 1280 || size.width < 2 || size.height < 2) fail('The selected frame cannot meet the video preview dimensions.');
    const mark = await watermark(options.creator, size);
    try { await ffmpeg.writeFile('watermark.png', new Uint8Array(await bytes(await encodeCanvas(mark, 'image/png', options.signal), options.signal))); }
    finally { mark.width = mark.height = 1; }
    await ffmpeg.deleteFile('frame.png');
    const filter = `[0:${stream.index}]${scale},fps=30[base];[base][1:v]overlay=x=main_w-overlay_w:y=main_h-overlay_h:format=auto,format=yuv420p[preview]`;
    const update = ({ time }: { time: number }) => progress(options, Math.min(0.9, Math.max(0, time / (duration * 1_000_000)) * 0.9));
    ffmpeg.on('progress', update);
    try {
      await execute(ffmpeg, [...seek, ...input('source'), ...input('watermark.png', 'png_pipe'),
        '-filter_complex', filter, '-map', '[preview]', '-map', '0:a:0?', '-c:a', 'aac', '-b:a', '96k', '-ac', '2',
        ...(options.fullLength ? [] : ['-t', String(duration)]), '-sn', '-dn', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p',
        ...stripMetadata, '-metadata:s:v:0', 'rotate=0', '-fs', String(outputBytes + 1), '-movflags', '+faststart', 'preview.mp4']);
    } finally { ffmpeg.off('progress', update); }
    await ffmpeg.deleteFile('source');
    const output = await binary(ffmpeg, 'preview.mp4');
    if (!output.length || output.length > outputBytes) fail('The generated preview exceeds the 32 MiB limit or is empty. Choose a shorter excerpt.');
    const result = await probe(ffmpeg, 'preview.mp4');
    const resultStream = result.streams?.find((item) => item.codec_type === 'video');
    const blob = new Blob([output], { type: 'video/mp4' });
    const visible = await viewableMedia(blob, options.signal);
    verifyMediaDuration(visible.duration, duration, options.fullLength);
    if (resultStream?.width !== size.width || resultStream.height !== size.height || visible.width !== size.width || visible.height !== size.height) {
      fail('The generated video failed its dimension bounds. Nothing was prepared.');
    }
    return { blob, extension: 'mp4', entry: { kind: 'video', width: size.width, height: size.height, duration: visible.duration } };
  });
}

async function animation(data: ArrayBuffer, raster: Raster, options: Settings): Promise<Generated> {
  const delays = raster.delays!;
  if (raster.width * raster.height * delays.length > maxAnimationPixels) fail('Animations may contain at most 512 million total frame pixels. Resize or shorten the animation locally first.');
  // ImageDecoder is not yet declared in every TypeScript DOM library.
  const decoderGlobal: unknown = 'ImageDecoder' in globalThis ? globalThis.ImageDecoder : undefined;
  const Decoder = typeof decoderGlobal === 'function' && 'isTypeSupported' in decoderGlobal && typeof decoderGlobal.isTypeSupported === 'function'
    ? decoderGlobal as AnimationDecoderConstructor : undefined;
  if (!Decoder || !await abortable(Decoder.isTypeSupported(raster.mime), options.signal)) {
    fail('Animated GIF/WebP previews need ImageDecoder support (current Chromium browsers). Use a supported browser or the local media importer; animations are never flattened.');
  }
  const start = options.start * 1000;
  const end = options.fullLength ? Infinity : start + options.duration * 1000;
  let elapsed = 0;
  const excerpt: Array<{ index: number; delay: number }> = [];
  for (const [index, delay] of delays.entries()) {
    const overlap = Math.min(elapsed + delay, end) - Math.max(elapsed, start);
    const clipped = Math.floor((overlap + 0.000001) / 10) * 10;
    if (clipped > 0) excerpt.push({ index, delay: clipped });
    elapsed += delay;
    if (elapsed >= end) break;
  }
  if (!excerpt.length) fail('Choose an offset inside the first animation cycle and an excerpt of at least 0.01 seconds.');
  const duration = excerpt.reduce((sum, frame) => sum + frame.delay, 0) / 1000;
  const decoder = new Decoder({ data, type: raster.mime, preferAnimation: true });
  const close = () => decoder.close();
  options.signal?.addEventListener('abort', close, { once: true });
  const surfaces: { frame?: CanvasSurface; mark?: HTMLCanvasElement } = {};
  try {
    await abortable(decoder.tracks.ready, options.signal);
    if (decoder.tracks.selectedTrack?.frameCount !== delays.length) fail('The browser could not identify every animation frame. Nothing was flattened or prepared.');
    return await withTranscoder(options, async (ffmpeg) => {
      const concat = ['ffconcat version 1.0'];
      let frameBytes = 0;
      let size: Dimensions | undefined;
      for (const [position, frame] of excerpt.entries()) {
        checkAbort(options.signal);
        const decoded = await abortable(decoder.decode({ frameIndex: frame.index, completeFramesOnly: true }), options.signal, (value) => value.image.close());
        try {
          if (!decoded.complete || decoded.image.displayWidth !== raster.width || decoded.image.displayHeight !== raster.height) fail('The browser returned an incomplete or unexpectedly oriented animation frame. Export an orientation-normalized animation locally.');
          if (!surfaces.frame) {
            size = bounded(decoded.image.displayWidth, decoded.image.displayHeight, 1600);
            surfaces.frame = canvas(size);
            surfaces.mark = await watermark(options.creator, size);
          }
          const { frame: surface, mark } = surfaces;
          surface.context.clearRect(0, 0, surface.element.width, surface.element.height);
          surface.context.drawImage(decoded.image, 0, 0, surface.element.width, surface.element.height);
          surface.context.drawImage(mark!, surface.element.width - mark!.width, surface.element.height - mark!.height);
          const blob = await encodeCanvas(surface.element, 'image/png', options.signal);
          frameBytes += blob.size;
          if (frameBytes > videoBytes) fail('The animation needs more than 128 MiB of intermediate frames. Choose a shorter excerpt or resize it locally.');
          const name = `frame-${position}.png`;
          await ffmpeg.writeFile(name, new Uint8Array(await bytes(blob, options.signal)));
          concat.push(`file ${name}`, 'option framerate 100', `duration ${(frame.delay / 1000).toFixed(3)}`);
        } finally { decoded.image.close(); }
        progress(options, (position + 1) / excerpt.length * 0.55);
      }
      await ffmpeg.writeFile('frames.ffconcat', concat.join('\n') + '\n');
      // This concat file contains only generated constant-prefix filenames, never user input.
      const sequence = ['-protocol_whitelist', 'file,pipe', '-format_whitelist', 'concat,png_pipe,image2', '-f', 'concat', '-safe', '0', '-i', 'frames.ffconcat'];
      // Two passes avoid buffering every decoded frame while a global palette is built.
      await execute(ffmpeg, [...sequence, '-vf', 'palettegen=reserve_transparent=1', '-frames:v', '1', '-an', '-sn', '-dn', ...stripMetadata, 'palette.png']);
      progress(options, 0.7);
      const update = ({ time }: { time: number }) => progress(options, 0.7 + Math.min(1, Math.max(0, time / (duration * 1_000_000))) * 0.2);
      ffmpeg.on('progress', update);
      try {
        await execute(ffmpeg, [...sequence, ...input('palette.png', 'png_pipe'),
          '-filter_complex', '[0:v][1:v]paletteuse=dither=sierra2_4a[preview]',
          '-map', '[preview]', '-vsync', 'vfr', '-enc_time_base', '1:100', '-an', '-sn', '-dn', ...stripMetadata,
          '-loop', '0', '-final_delay', String(excerpt.at(-1)!.delay / 10), '-fs', String(outputBytes + 1), 'preview.gif']);
      } finally { ffmpeg.off('progress', update); }
      const output = await binary(ffmpeg, 'preview.gif');
      if (!output.length || output.length > outputBytes) fail('The generated GIF exceeds the 32 MiB limit or is empty. Choose a shorter excerpt.');
      const verified = inspectRaster(output);
      const actualDuration = (verified.delays ?? []).reduce((sum, delay) => sum + delay, 0) / 1000;
      if (!size || verified.width !== size.width || verified.height !== size.height || actualDuration <= 0 || (!options.fullLength && actualDuration > 60) || Math.abs(actualDuration - duration) > 0.011) {
        fail('The generated GIF failed its dimension or timing bounds. Nothing was prepared.');
      }
      const blob = new Blob([output], { type: 'image/gif' });
      const bitmap = await decodeBitmap(blob, options.signal);
      try {
        if (bitmap.width !== size.width || bitmap.height !== size.height) fail('This browser cannot display the generated GIF correctly.');
      } finally { bitmap.close(); }
      return { blob, extension: 'gif', entry: { kind: 'image', ...size, duration: actualDuration } };
    });
  } finally {
    options.signal?.removeEventListener('abort', close);
    close();
    if (surfaces.frame) surfaces.frame.element.width = surfaces.frame.element.height = 1;
    if (surfaces.mark) surfaces.mark.width = surfaces.mark.height = 1;
  }
}

async function prepare(file: File, options: Settings, hasTiming: boolean): Promise<PreparedPreview> {
  checkAbort(options.signal);
  progress(options);
  const header = new Uint8Array(await bytes(file.slice(0, 64), options.signal));
  const mime = rasterMime(header);
  let generated: Generated;
  if (mime) {
    if (file.size > imageBytes) fail('Image originals must be at most 32 MiB. Resize the original locally first.');
    const data = await bytes(file, options.signal);
    const raster = imageMetadata.get(file) || inspectRaster(new Uint8Array(data));
    if (raster.delays && (raster.mime === 'image/webp' || raster.delays.length > 1)) generated = await animation(data, raster, options);
    else {
      if (hasTiming || options.fullLength) fail('Length and trim settings apply only to audio, video and animated images, not still images.');
      generated = await still(new Blob([data], { type: mime }), options, raster);
    }
  } else {
    const extension = file.name.split('.').at(-1)?.toLowerCase() || '';
    if (audioExtensions.has(extension)) generated = await audio(file, options);
    else if (videoExtensions.has(extension)) generated = await video(file, options);
    else fail('Choose JPEG, PNG, WebP, GIF, a supported audio file, or a supported video file. SVG, APNG, AVIF and TIFF need a supported local export.');
  }
  checkAbort(options.signal);
  if (!generated.blob.size || generated.blob.size > outputBytes) fail('The generated preview must be nonempty and at most 32 MiB. Resize or trim the source locally first.');
  const digest = await abortable(crypto.subtle.digest('SHA-256', await bytes(generated.blob, options.signal)), options.signal);
  const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  checkAbort(options.signal);
  const name = `${options.name || generated.entry.kind}-preview-${sha256.slice(0, 32)}.${generated.extension}`;
  const output = new File([generated.blob], name, { type: generated.blob.type, lastModified: 0 });
  progress(options, 1);
  return { file: output, url: `/media/${name}`, entry: { sha256, ...generated.entry } };
}

/** Only re-encoded listening/viewing copies are returned; this module never uploads media. */
export async function preparePreview(file: File, options: PreviewOptions): Promise<PreparedPreview> {
  checkAbort(options.signal);
  if (!globalThis.isSecureContext || !globalThis.crypto?.subtle || typeof document === 'undefined' || typeof FileReader === 'undefined' || typeof Promise.withResolvers !== 'function') fail('Safe preview preparation needs a current HTTPS browser with Canvas, FileReader, Web Crypto and Promise.withResolvers support.');
  if (typeof File === 'undefined' || !(file instanceof File) || !file.size) fail('Choose a nonempty local media file in a supported browser.');
  if (file.size > videoBytes) fail('Originals must be at most 128 MiB (32 MiB for images). Trim or resize the original locally first.');
  let creator: string;
  try { creator = normalizeWatermarkCredit(options.creator); }
  catch { fail(watermarkCreditError); }
  if (!creator) fail(watermarkCreditError);
  if (options.name !== undefined && options.name !== '' && (typeof options.name !== 'string' || options.name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.name))) fail('The public name must be 1–64 lowercase letters or numbers separated by single hyphens, without an extension.');
  if (options.fullLength !== undefined && typeof options.fullLength !== 'boolean') fail('Choose short preview or full length.');
  if (options.fullLength && (options.start !== undefined || options.duration !== undefined)) fail('Full-length publishing cannot also specify excerpt settings.');
  const start = options.start ?? 0;
  const duration = options.duration ?? 30;
  if (!Number.isFinite(start) || start < 0 || start > Number.MAX_SAFE_INTEGER / 1000) fail('The excerpt offset must be a finite, nonnegative number of seconds.');
  if (!Number.isFinite(duration) || duration <= 0 || duration > 60) fail('The excerpt duration must be greater than zero and at most 60 seconds.');
  const settings: Settings = { ...options, creator, start, duration };
  const hasTiming = options.start !== undefined || options.duration !== undefined;
  // Queue whole jobs, not just exec(), so concurrent originals cannot exhaust the WASM heap.
  // Cancelling a queued job does not terminate the currently active user's conversion.
  const job = queue.then(async () => {
    try { return await prepare(file, settings, hasTiming); }
    catch (error: unknown) {
      checkAbort(settings.signal);
      if (error instanceof PreviewError) throw error;
      throw new PreviewError(conversionError);
    }
  });
  queue = job.catch(() => undefined);
  return abortable(job, options.signal);
}
