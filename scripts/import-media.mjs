import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegPath from 'ffmpeg-static';
import sharp from 'sharp';
import { normalizeWatermarkCredit, watermarkLayout } from '../src/lib/watermark.mjs';

// A short-lived import must release native image handles before removing its temporary files.
sharp.cache(false);

const projectPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const safeName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const previewUrl = /^\/media\/[a-z0-9]+(?:-[a-z0-9]+)*-preview-[a-f0-9]{32}\.(webp|gif|mp3|mp4)$/;
/** @type {Record<string, 'image' | 'media'>} */
const inputTypes = {
  '.jpg': 'image', '.jpeg': 'image', '.png': 'image', '.webp': 'image',
  '.gif': 'image', '.avif': 'image', '.tif': 'image', '.tiff': 'image',
  '.mp3': 'media', '.wav': 'media', '.flac': 'media', '.ogg': 'media',
  '.opus': 'media', '.m4a': 'media', '.aac': 'media', '.aif': 'media',
  '.aiff': 'media', '.wma': 'media', '.mp4': 'media', '.mov': 'media',
  '.m4v': 'media', '.webm': 'media', '.mkv': 'media', '.avi': 'media',
  '.ogv': 'media', '.mpg': 'media', '.mpeg': 'media', '.mts': 'media', '.m2ts': 'media',
};
/** @type {Record<string, 'image' | 'audio' | 'video'>} */
const outputKinds = { webp: 'image', gif: 'image', mp3: 'audio', mp4: 'video' };
/** @type {Record<string, string>} */
const xmlEntities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const mediaDemuxers = 'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,ogg,mp3,wav,flac,aac,aiff,asf,mpeg,mpegts';
const settings = {
  version: 3,
  imageEdge: 1600,
  webpQuality: 78,
  videoWidth: 1280,
  videoFps: 30,
  videoCrf: 28,
  audioBitrate: '96k',
  defaultDuration: 30,
  maxDuration: 60,
  codecPaddingReserve: 0.1,
  sharp: sharp.versions.sharp,
  vips: sharp.versions.vips,
};
const usage = `Usage: npm run media:import -- /absolute/path/to/original [--name safe-name] [--start seconds] [--duration seconds]

Keep originals outside this repository, including outside public/. Only previews are published.
--name      Public lowercase letters/numbers separated by hyphens, up to 64 characters.
            Defaults to image, audio, or video; the original filename is never published.
--start     Excerpt offset, in seconds (default 0; audio/video/animated images only).
--duration  Excerpt length, in seconds (default 30, maximum 60).

Raster images: JPEG, PNG, WebP, GIF, AVIF, single-page TIFF -> watermarked WebP, max 1600px.
Animated GIF/WebP -> watermarked GIF, max 1600px, one clipped animation cycle.
Audio: MP3, WAV, FLAC, Ogg/Opus, M4A/AAC, AIFF, WMA -> 96 kbps MP3 excerpt.
Video: MP4/MOV/M4V, WebM/MKV, AVI, OGV, MPEG/TS -> watermarked H.264 MP4, max 1280px wide.
Codec availability depends on the bundled ffmpeg-static binary. SVG, APNG and multipage
still images are not accepted; export a supported copy outside the repository first.
Public previews remain downloadable and copyable. Watermarks are attribution, not DRM.`;

function parseArguments(args) {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) return null;
  const result = { input: '', name: '', start: 0, duration: settings.defaultDuration, hasTiming: false };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument.startsWith('--')) {
      if (!['--name', '--start', '--duration'].includes(argument)) throw new Error(`Unknown option ${argument}. Use --help for usage.`);
      if (seen.has(argument)) throw new Error(`Specify ${argument} only once.`);
      seen.add(argument);
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value.`);
      if (argument === '--name') {
        if (value.length > 64 || !safeName.test(value)) throw new Error('--name must be 1–64 lowercase letters/numbers separated by single hyphens, without an extension.');
        result.name = value;
      } else {
        if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) || !Number.isFinite(Number(value))) throw new Error(`${argument} must be a finite number of seconds.`);
        const seconds = Number(value);
        if (argument === '--duration' && (seconds <= 0 || seconds > settings.maxDuration)) throw new Error('--duration must be greater than 0 and at most 60 seconds.');
        result[argument.slice(2)] = seconds;
        result.hasTiming = true;
      }
    } else {
      if (result.input) throw new Error('Import one original at a time; quote paths containing spaces.');
      result.input = argument;
    }
  }
  if (!result.input || !path.isAbsolute(result.input)) throw new Error('Provide an absolute path to an original outside the repository. Use --help for usage.');
  return result;
}

function isInside(directory, filename) {
  const relative = path.relative(directory, filename);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function hashFile(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function plainDirectory(directory) {
  await mkdir(directory, { recursive: true });
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Refusing a linked or non-directory output location: ${directory}`);
}

async function optionalFileInfo(filename) {
  try { return await lstat(filename); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function runFfmpeg(args, { probe = false } = {}) {
  if (!ffmpegPath) throw new Error('ffmpeg-static does not provide a converter for this platform. Use a supported Windows, macOS or Linux machine; no system ffmpeg is used.');
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-hide_banner', '-nostdin', ...args], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AV_LOG_FORCE_NOCOLOR: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-262144); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-262144); });
    child.once('error', (error) => reject(new Error(`Could not start bundled ffmpeg: ${error.message}. Run npm install with install scripts enabled.`)));
    child.once('close', (code) => {
      // ffmpeg's input-only probe intentionally exits 1 because it has no output.
      if (code === 0 || (probe && code === 1 && stderr.includes('At least one output file must be specified'))) resolve({ stdout, stderr });
      else reject(new Error(`Media conversion failed (ffmpeg exit ${code}). The source may be corrupt or use an unsupported codec; export a supported copy outside the repository.\n${stderr.trim().slice(-6000)}`));
    });
  });
}

function ffmpegInput(filename, demuxers = mediaDemuxers) {
  // Never allow playlists/network protocols to pull other files or remote sources into an import.
  return ['-protocol_whitelist', 'file,pipe', '-format_whitelist', demuxers, '-i', filename];
}

async function probeMedia(filename, demuxers = mediaDemuxers) {
  const { stderr } = await runFfmpeg(ffmpegInput(filename, demuxers), { probe: true });
  const durationMatch = stderr.match(/^\s*Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/m);
  const duration = durationMatch ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3]) : undefined;
  let video;
  let audio;
  for (const match of stderr.matchAll(/^\s*Stream #0:(\d+)(?:\[[^\]\r\n]+\])?(?:\([^\)\r\n]*\))?: (Video|Audio): ([^\r\n]+)/gm)) {
    if (match[2] === 'Audio' && !audio) audio = { index: Number(match[1]) };
    if (match[2] === 'Video' && !video && !match[3].includes('(attached pic)')) {
      const dimensions = match[3].match(/(?:^|[,\s])(\d{1,6})x(\d{1,6})(?=[,\s]|$)/);
      video = { index: Number(match[1]), width: dimensions ? Number(dimensions[1]) : undefined, height: dimensions ? Number(dimensions[2]) : undefined };
    }
  }
  if (!video && !audio) throw new Error('No supported audio or moving-video stream was found. Export a supported media file outside the repository.');
  return { video, audio, duration };
}

async function isAnimatedPng(filename) {
  const file = await open(filename, 'r');
  try {
    const size = (await file.stat()).size;
    const header = Buffer.alloc(8);
    let position = 8;
    while (position + 8 <= size) {
      if ((await file.read(header, 0, 8, position)).bytesRead !== 8) break;
      const type = header.toString('ascii', 4, 8);
      if (type === 'acTL') return true;
      if (type === 'IDAT' || type === 'IEND') return false;
      position += header.readUInt32BE(0) + 12;
    }
    return false;
  } finally { await file.close(); }
}

async function inspectInput(filename, options) {
  const type = inputTypes[path.extname(filename).toLowerCase()];
  if (!type) throw new Error('Unsupported file format. Use --help for supported raster, audio and video formats; export a supported copy outside the repository.');
  if (type === 'image') {
    let metadata;
    try { metadata = await sharp(filename).metadata(); }
    catch (error) { throw new Error(`Cannot decode this raster image. Export a JPEG/PNG/WebP/GIF/AVIF/TIFF copy outside the repository. ${error.message}`); }
    if (!['jpeg', 'png', 'webp', 'gif', 'heif', 'tiff'].includes(metadata.format)) throw new Error('Only supported raster images can be imported; SVG and other document/vector formats are not accepted.');
    if (!metadata.width || !metadata.height) throw new Error('The image has no readable dimensions.');
    if (metadata.format === 'png' && await isAnimatedPng(filename)) throw new Error('APNG is not supported without losing animation. Export an animated GIF/WebP copy outside the repository instead.');
    const animated = (metadata.pages || 1) > 1;
    if (animated && !['gif', 'webp'].includes(metadata.format)) throw new Error('Multipage still images are not flattened. Export the desired page outside the repository, or use an animated GIF/WebP.');
    if (!animated && options.hasTiming) throw new Error('--start and --duration apply only to audio, video and animated images, not still images.');
    return { kind: 'image', extension: animated ? 'gif' : 'webp', metadata, animated };
  }
  const probe = await probeMedia(filename);
  if (probe.duration !== undefined && options.start >= probe.duration) throw new Error(`--start must be before the end of the source (${probe.duration} seconds).`);
  return { kind: probe.video ? 'video' : 'audio', extension: probe.video ? 'mp4' : 'mp3', probe };
}

function boundedDimensions(width, height, edge) {
  const scale = Math.min(1, edge / width, edge / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

async function watermark(directory, creator, width, height) {
  const escape = (text) => text.replace(/[&<>"']/g, (character) => xmlEntities[character]);
  const layout = await watermarkLayout(creator, width, height, async (label, fontSize) => {
    const metrics = await sharp({ text: { text: escape(label), font: `sans-serif Medium ${fontSize}`, dpi: 72 } }).metadata();
    return metrics.width;
  });
  const lines = layout.lines.map((line) => `<text x="${line.x}" y="${line.y}" font-size="${line.fontSize}">${escape(line.text)}</text>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}"><g transform="scale(${layout.scale})" font-family="sans-serif" font-weight="500" fill="#fff" fill-opacity="0.65" stroke="#000" stroke-opacity="0.4" stroke-width="2" paint-order="stroke">${lines}</g></svg>`;
  const filename = path.join(directory, 'watermark.png');
  await sharp(Buffer.from(svg)).png().toFile(filename);
  return filename;
}

function animationExcerpt(metadata, options) {
  const start = options.start * 1000;
  const end = start + options.duration * 1000;
  let elapsed = 0;
  let first = -1;
  const delay = [];
  for (let page = 0; page < metadata.pages; page++) {
    // GIF has centisecond timing; zero-delay frames conventionally display for 100ms.
    const frameDuration = Math.max(10, metadata.delay?.[page] || 100);
    const overlap = Math.min(elapsed + frameDuration, end) - Math.max(elapsed, start);
    const clipped = Math.floor((overlap + 0.000001) / 10) * 10;
    if (clipped > 0) {
      if (first === -1) first = page;
      delay.push(clipped);
    }
    elapsed += frameDuration;
    if (elapsed >= end) break;
  }
  if (first === -1) throw new Error('The animated excerpt is empty. Choose --start inside the first animation cycle and --duration of at least 0.01 seconds.');
  return { first, delay };
}

async function convertImage(input, output, directory, creator, media, options) {
  const metadata = media.metadata;
  const swapsAxes = [5, 6, 7, 8].includes(metadata.orientation || 1);
  const sourceHeight = metadata.pageHeight || metadata.height;
  const dimensions = boundedDimensions(swapsAxes ? sourceHeight : metadata.width, swapsAxes ? metadata.width : sourceHeight, settings.imageEdge);
  const mark = await watermark(directory, creator, dimensions.width, dimensions.height);
  const resize = { ...dimensions, fit: 'fill', withoutEnlargement: true };
  if (!media.animated) {
    await sharp(input).autoOrient().resize(resize).composite([{ input: mark, gravity: 'southeast' }]).webp({ quality: settings.webpQuality }).toFile(output);
  } else {
    const excerpt = animationExcerpt(metadata, options);
    // Tiling a transparent, exactly-one-frame canvas repeats the mark once per frame,
    // not just on the bottom of sharp's vertically stacked animated-image buffer.
    const overlay = path.join(directory, 'frame-watermark.png');
    await sharp({ create: { ...dimensions, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: mark, gravity: 'southeast' }]).png().toFile(overlay);
    try {
      await sharp(input, { page: excerpt.first, pages: excerpt.delay.length }).autoOrient().resize(resize)
        .composite([{ input: overlay, tile: true, gravity: 'northwest' }])
        .gif({ delay: excerpt.delay, loop: 0, effort: 7 }).toFile(output);
    } catch (error) {
      throw new Error(`Could not produce the animated preview without flattening it. The decoder may reject excessive pixel counts or rotated animation; export a smaller, orientation-normalized animated GIF/WebP outside the repository. ${error.message}`);
    }
  }
  const result = await sharp(output, { animated: media.animated }).metadata();
  const entry = { kind: 'image', width: result.width, height: result.pageHeight || result.height };
  if (media.animated) {
    const duration = (result.delay || []).reduce((total, delay) => total + delay, 0) / 1000;
    if (!(duration > 0 && duration <= settings.maxDuration)) throw new Error('The generated GIF did not have a valid bounded duration; nothing was published.');
    entry.duration = duration;
  }
  return entry;
}

const stripMetadata = ['-map_metadata', '-1', '-map_metadata:s', '-1', '-map_chapters', '-1', '-metadata', 'encoder='];

async function convertAudioVideo(input, output, directory, creator, media, options) {
  const seek = ['-ss', String(options.start)];
  // Leave room for codec/frame granularity at the hard 60-second ceiling.
  const durationLimit = Math.min(options.duration, settings.maxDuration - settings.codecPaddingReserve);
  if (media.kind === 'audio') {
    await runFfmpeg(['-loglevel', 'error', '-n', ...seek, ...ffmpegInput(input),
      '-map', `0:${media.probe.audio.index}`, '-t', String(durationLimit), '-vn', '-sn', '-dn',
      '-c:a', 'libmp3lame', '-b:a', settings.audioBitrate, '-ar', '44100', '-ac', '2',
      ...stripMetadata, '-id3v2_version', '0', '-write_id3v1', '0', output]);
  } else {
    // Read one decoded, auto-rotated frame after scaling; this also handles display matrices/SAR.
    const frame = path.join(directory, 'video-frame.png');
    const displayWidth = 'iw*if(gt(sar,0),sar,1)';
    const scale = `scale=w='max(2,trunc(min(${settings.videoWidth},${displayWidth})/2)*2)':h='max(2,trunc(ih*min(1,${settings.videoWidth}/(${displayWidth}))/2)*2)',setsar=1`;
    await runFfmpeg(['-loglevel', 'error', '-n', ...seek, ...ffmpegInput(input),
      '-map', `0:${media.probe.video.index}`, '-vf', scale, '-frames:v', '1', '-an', '-sn', '-dn', ...stripMetadata, frame]);
    let frameInfo;
    try { frameInfo = await sharp(frame).metadata(); }
    catch { throw new Error('No video frame exists at --start. Choose an earlier excerpt offset.'); }
    if (frameInfo.width < 2 || frameInfo.height < 2) throw new Error('H.264 previews require a video at least 2×2 pixels.');
    const mark = await watermark(directory, creator, frameInfo.width, frameInfo.height);
    // Paths and creator text never enter filter expressions: the mark is a separate PNG input.
    const filter = `[0:${media.probe.video.index}]${scale},fps=${settings.videoFps}[base];[base][1:v]overlay=x=main_w-overlay_w:y=main_h-overlay_h:format=auto,format=yuv420p[preview]`;
    const audioMap = media.probe.audio ? ['-map', `0:${media.probe.audio.index}`, '-c:a', 'aac', '-b:a', settings.audioBitrate, '-ac', '2'] : ['-an'];
    await runFfmpeg(['-loglevel', 'error', '-n', ...seek, ...ffmpegInput(input),
      ...ffmpegInput(mark, 'png_pipe'), '-filter_complex', filter, '-map', '[preview]', ...audioMap,
      '-t', String(durationLimit), '-sn', '-dn', '-c:v', 'libx264', '-preset', 'medium',
      '-crf', String(settings.videoCrf), '-pix_fmt', 'yuv420p', ...stripMetadata,
      '-metadata:s:v:0', 'rotate=0', '-movflags', '+faststart', output]);
  }
  if ((await stat(output)).size === 0) throw new Error('The selected excerpt produced no media. Choose an earlier --start.');
  const result = await probeMedia(output);
  // Decode the bounded result to obtain playback time, excluding MP3 encoder padding.
  const measured = await runFfmpeg(['-loglevel', 'error', ...ffmpegInput(output), '-map', '0', '-progress', 'pipe:1', '-nostats', '-f', 'null', '-']);
  const timestamps = [...measured.stdout.matchAll(/^out_time_us=(\d+)$/gm)];
  const duration = Number(timestamps.at(-1)?.[1]) / 1000000;
  if (!(duration > 0) || duration > settings.maxDuration) throw new Error('The generated excerpt has no valid bounded playback duration; nothing was published.');
  if (media.kind === 'audio') return { kind: 'audio', duration };
  if (!result.video || !(result.video.width > 0 && result.video.height > 0) || result.video.width > settings.videoWidth) throw new Error('The generated video did not meet the preview dimensions; nothing was published.');
  return { kind: 'video', width: result.video.width, height: result.video.height, duration };
}

async function readManifest(filename) {
  const info = await optionalFileInfo(filename);
  if (!info) return { files: {} };
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('media-previews.json must be a regular file, not a link.');
  let manifest;
  try { manifest = JSON.parse(await readFile(filename, 'utf8')); }
  catch { throw new Error('media-previews.json is invalid JSON; restore the manifest before importing.'); }
  if (!manifest || Array.isArray(manifest) || Object.keys(manifest).length !== 1 || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) throw new Error('media-previews.json must contain exactly {"files":{...}}.');
  for (const [url, entry] of Object.entries(manifest.files)) {
    const match = url.match(previewUrl);
    if (!match || !entry || typeof entry !== 'object' || Array.isArray(entry) || entry.kind !== outputKinds[match[1]] || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error(`Invalid registered preview ${url}; repair the manifest before importing.`);
    for (const [field, value] of Object.entries(entry)) {
      if (field === 'kind' || field === 'sha256') continue;
      // From the site editor: animations loop, and any video can name its registered still.
      if (field === 'loop' && value === true && entry.kind === 'video') continue;
      if (field === 'poster' && entry.kind === 'video' && typeof value === 'string' && previewUrl.test(value)) continue;
      if (!['width', 'height', 'duration'].includes(field) || typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || (field !== 'duration' && !Number.isInteger(value))) throw new Error(`Invalid preview metadata for ${url}; only public dimensions, duration, kind and sha256 are allowed.`);
    }
  }
  return manifest;
}

async function publishPreview(root, temporaryBase, output, filename, entry) {
  const publicDirectory = path.join(root, 'public');
  const mediaDirectory = path.join(publicDirectory, 'media');
  const sourceDirectory = path.join(root, 'src');
  const contentDirectory = path.join(sourceDirectory, 'content');
  for (const directory of [publicDirectory, mediaDirectory, sourceDirectory, contentDirectory]) await plainDirectory(directory);
  const manifestPath = path.join(contentDirectory, 'media-previews.json');
  const lock = path.join(temporaryBase, `gwenlium-media-lock-${createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 24)}`);
  try { await mkdir(lock); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Another import is publishing. Wait for it to finish. If an earlier import crashed, remove this lock directory only after ensuring no importer is running: ${lock}`);
    throw error;
  }
  let createdPreview = false;
  let committed = false;
  const destination = path.join(mediaDirectory, filename);
  const url = `/media/${filename}`;
  // A same-directory, public-metadata-only staging file makes rename atomic even
  // when the OS temporary directory is on a different drive from the repository.
  const manifestTemporary = path.join(contentDirectory, `.media-previews-${randomUUID()}.tmp`);
  try {
    const manifest = await readManifest(manifestPath);
    const caseCollision = (await readdir(mediaDirectory)).find((existing) => existing.toLowerCase() === filename && existing !== filename);
    if (caseCollision) throw new Error(`Case-conflicting preview ${caseCollision} already exists; it was not overwritten.`);
    const existing = await optionalFileInfo(destination);
    if (existing) {
      if (!existing.isFile() || existing.isSymbolicLink() || await hashFile(destination) !== entry.sha256) throw new Error(`Refusing to overwrite a different or linked file at ${url}. Choose another --name.`);
    } else {
      await copyFile(output, destination, constants.COPYFILE_EXCL);
      createdPreview = true;
    }
    manifest.files[url] = entry;
    const sorted = { files: Object.fromEntries(Object.entries(manifest.files).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) };
    const handle = await open(manifestTemporary, 'wx');
    try { await handle.writeFile(`${JSON.stringify(sorted, null, 2)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    await rename(manifestTemporary, manifestPath);
    committed = true;
    return url;
  } finally {
    try { await rm(manifestTemporary, { force: true }); }
    finally {
      try { if (createdPreview && !committed) await rm(destination, { force: true }); }
      finally { await rm(lock, { recursive: true, force: true }); }
    }
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options) { console.log(usage); return; }
  const root = await realpath(projectPath);
  const inputPath = path.resolve(options.input);
  const input = await realpath(inputPath);
  if (isInside(projectPath, inputPath) || isInside(root, inputPath) || isInside(root, input)) throw new Error('The original must be outside the repository, including after resolving symlinks. Move private originals out of the repository before importing; the importer never moves or deletes them.');
  if (!(await stat(input)).isFile()) throw new Error('The original must be a regular file, not a directory or device.');
  const temporaryBase = await realpath(tmpdir());
  if (isInside(root, temporaryBase)) throw new Error('The OS temporary directory is inside the repository. Set TMPDIR (macOS/Linux) or TEMP/TMP (Windows) to a directory outside it.');
  const media = await inspectInput(input, options);
  const site = JSON.parse(await readFile(path.join(root, 'src', 'content', 'site.json'), 'utf8'));
  if (typeof site.name !== 'string' || !site.name.trim() || site.name.length > 200 || /[\u0000-\u001f\u007f]/.test(site.name)) throw new Error('Set site.name to a nonempty creator name (up to 200 characters, without control characters) before importing.');
  const creator = normalizeWatermarkCredit(site.watermarkText) || normalizeWatermarkCredit(`© ${site.name.trim()}`);
  const inputHash = await hashFile(input);
  const converter = media.kind === 'image' ? '' : (await runFfmpeg(['-version'])).stdout.split(/\r?\n/, 1)[0];
  const conversionKey = JSON.stringify({ settings, kind: media.kind, extension: media.extension, creator, start: options.start, duration: options.duration, converter });
  const hash = createHash('sha256').update(inputHash).update(conversionKey).digest('hex').slice(0, 32);
  const filename = `${options.name || media.kind}-preview-${hash}.${media.extension}`;
  const directory = await mkdtemp(path.join(temporaryBase, 'gwenlium-preview-'));
  try {
    const output = path.join(directory, `preview.${media.extension}`);
    const metadata = media.kind === 'image'
      ? await convertImage(input, output, directory, creator, media, options)
      : await convertAudioVideo(input, output, directory, creator, media, options);
    if (await hashFile(input) !== inputHash) throw new Error('The original changed during conversion. Nothing was published; finish editing the original and import again.');
    const entry = { sha256: await hashFile(output), ...metadata };
    const url = await publishPreview(root, temporaryBase, output, filename, entry);
    console.log(url);
    console.log('Only this prepared preview was added. The original was not changed or uploaded. Public previews remain downloadable and copyable.');
  } finally { await rm(directory, { recursive: true, force: true }); }
}

main().catch((error) => {
  console.error(`[media:import] ${error.message}`);
  process.exitCode = 1;
});
