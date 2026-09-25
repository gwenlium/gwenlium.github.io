import { createHash } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mediaDirectory = path.join(root, 'public', 'media');
const outputDirectory = path.join(root, 'public', '_generated', 'media');
const manifestPath = path.join(root, 'src', 'generated', 'media.json');
const imageExtensions = { '.jpg': true, '.jpeg': true, '.png': true, '.webp': true, '.avif': true, '.tif': true, '.tiff': true };
const videoExtensions = { '.mp4': true, '.webm': true, '.mov': true, '.m4v': true, '.ogv': true, '.mkv': true };
const options = {
  schema: 1,
  widths: [320, 640, 960, 1280, 1600],
  maxWidth: 1600,
  avif: { quality: 50, effort: 4 },
  webp: { quality: 80, effort: 4 },
  sharp: sharp.versions.sharp,
  vips: sharp.versions.vips,
};
const optionKey = JSON.stringify(options);

async function exists(filename) {
  try { await access(filename); return true; }
  catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function walk(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  const files = [];
  for (const entry of entries) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(filename));
    else if (entry.isFile()) files.push(filename);
    // Do not follow symlinks outside public/media or into a directory cycle.
  }
  return files;
}

/** AVIF and WebP widths of one picture (a GIF's first frame when given one); undefined if encoding failed. */
async function variants(input, sourceUrl, width, key) {
  const maximum = Math.min(width, options.maxWidth);
  const widths = options.widths.filter((candidate) => candidate <= maximum);
  if (!widths.includes(maximum)) widths.push(maximum);
  const hash = createHash('sha256').update(input).update(key).digest('hex').slice(0, 32);
  const sources = { avif: [], webp: [] };
  for (const format of ['avif', 'webp']) {
    for (const variantWidth of widths) {
      const name = `${hash}-${variantWidth}.${format}`;
      const destination = path.join(outputDirectory, name);
      if (await exists(destination)) counts.cached++;
      else {
        const temporary = `${destination}.tmp-${process.pid}`;
        try {
          const image = sharp(input).rotate().resize({ width: variantWidth, withoutEnlargement: true });
          await image[format](options[format]).toFile(temporary);
          await rename(temporary, destination);
          counts.generated++;
        } catch (error) {
          // A format unsupported by this sharp build must not make a valid original unusable.
          if (['EACCES', 'EPERM', 'ENOSPC', 'EROFS'].includes(error.code)) throw error;
          console.warn(`[media] Could not encode ${sourceUrl} as ${format}; preview source preserved. ${error.message}`);
          return undefined;
        } finally {
          await rm(temporary, { force: true });
        }
      }
      sources[format].push({ src: `/_generated/media/${name}`, width: variantWidth });
    }
  }
  return sources;
}

const counts = { generated: 0, cached: 0 };

async function prepareMedia() {
  const files = await walk(mediaDirectory);
  const manifest = {};
  let preserved = 0;
  await mkdir(outputDirectory, { recursive: true });

  for (const filename of files) {
    const extension = path.extname(filename).toLowerCase();
    const relative = path.relative(mediaDirectory, filename).split(path.sep).join('/');
    const sourceKey = `/media/${relative}`;
    const sourceUrl = `/media/${relative.split('/').map(encodeURIComponent).join('/')}`;
    if (Object.hasOwn(videoExtensions, extension)) {
      const info = await stat(filename);
      if (info.size > 60 * 1024 * 1024) {
        console.warn(`[media] ${sourceUrl} is ${(info.size / 1024 / 1024).toFixed(1)} MiB. Consider a smaller web export; the original is preserved.`);
      }
      continue;
    }
    // GIFs are never converted or flattened; places that only need a thumbnail (post cards,
    // link previews) get still first-frame variants instead, so a list never downloads a whole
    // animation. `still: true` marks those variants: Media uses them only when asked for a still.
    if (extension === '.gif') {
      const input = await readFile(filename);
      let metadata;
      try { metadata = await sharp(input).metadata(); }
      catch (error) {
        console.warn(`[media] Could not inspect ${sourceUrl}; no still preview. ${error.message}`);
        preserved++;
        continue;
      }
      const width = metadata.width;
      const height = metadata.pageHeight || metadata.height;
      if (!width || !height) { preserved++; continue; }
      const sources = await variants(input, sourceUrl, width, `${optionKey}:still`);
      if (!sources) { preserved++; continue; }
      manifest[sourceKey] = { width, height, src: sourceUrl, sources, still: true };
      continue;
    }
    // SVG is intentionally never converted.
    if (!Object.hasOwn(imageExtensions, extension)) continue;

    const input = await readFile(filename);
    let metadata;
    try { metadata = await sharp(input).metadata(); }
    catch (error) {
      console.warn(`[media] Could not inspect ${sourceUrl}; preview source preserved. ${error.message}`);
      preserved++;
      continue;
    }
    if (!metadata.width || !metadata.height || (metadata.pages || 1) > 1) {
      console.warn(`[media] Preserving ${sourceUrl} without conversion (animated, multipage, or unknown dimensions).`);
      preserved++;
      continue;
    }

    const rotatesDimensions = [5, 6, 7, 8].includes(metadata.orientation || 1);
    const width = rotatesDimensions ? metadata.height : metadata.width;
    const height = rotatesDimensions ? metadata.width : metadata.height;
    const sources = await variants(input, sourceUrl, width, optionKey);
    if (!sources) { preserved++; continue; }
    manifest[sourceKey] = { width, height, src: sourceUrl, sources };
  }

  const currentVariants = new Set();
  for (const image of Object.values(manifest)) {
    for (const variants of Object.values(image.sources)) {
      for (const variant of variants) currentVariants.add(path.basename(variant.src));
    }
  }
  for (const entry of await readdir(outputDirectory, { withFileTypes: true })) {
    if (entry.isFile() && /^[a-f0-9]{32}-\d+\.(avif|webp)$/.test(entry.name) && !currentVariants.has(entry.name)) {
      await rm(path.join(outputDirectory, entry.name));
    }
  }

  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  let previous = '';
  try { previous = await readFile(manifestPath, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous !== serialized) {
    await mkdir(path.dirname(manifestPath), { recursive: true });
    const temporary = `${manifestPath}.tmp-${process.pid}`;
    try {
      await writeFile(temporary, serialized);
      await rename(temporary, manifestPath);
    } finally { await rm(temporary, { force: true }); }
  }
  console.log(`[media] ${Object.keys(manifest).length} images; ${counts.generated} variants generated, ${counts.cached} cached${preserved ? `, ${preserved} originals preserved without variants` : ''}.`);
}

prepareMedia().catch((error) => {
  console.error('[media] Preparation failed:', error);
  process.exitCode = 1;
});
