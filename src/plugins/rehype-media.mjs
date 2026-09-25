import fs from 'node:fs';
import { mediaKindOf, videoEmbed } from '../lib/embed.mjs';

const manifestFile = new URL('../generated/media.json', import.meta.url);
const registryFile = new URL('../content/media-previews.json', import.meta.url);
const sizes = '(min-width: 1200px) 960px, (min-width: 800px) calc(100vw - 280px), calc(100vw - 48px)';

/** Add responsive sources without rendering Markdown or changing author-owned links/captions. */
export default function rehypeMedia() {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Cannot read the generated media manifest: ${error.message}`, { cause: error });
    manifest = {};
  }

  // Which prepared videos are animations (looping, muted, no controls) and their stills.
  let registry = {};
  try { registry = JSON.parse(fs.readFileSync(registryFile, 'utf8')).files ?? {}; }
  catch (error) { if (error.code !== 'ENOENT') throw new Error(`Cannot read the media registry: ${error.message}`, { cause: error }); }

  return (tree) => {
    const visit = (parent) => {
      for (let index = 0; index < (parent.children?.length ?? 0); index++) {
        const node = parent.children[index];
        // A YouTube or Vimeo link alone in a paragraph becomes the embedded player.
        const only = node.type === 'element' && node.tagName === 'p'
          ? node.children.filter((child) => !(child.type === 'text' && !child.value.trim())) : [];
        if (only.length === 1 && only[0].type === 'element' && only[0].tagName === 'a') {
          const href = typeof only[0].properties?.href === 'string' ? only[0].properties.href : '';
          const embed = videoEmbed(href);
          if (embed) {
            const label = only[0].children.map((child) => child.value ?? '').join('').trim();
            parent.children[index] = { type: 'element', tagName: 'div', properties: { className: ['media-embed'] }, children: [{
              type: 'element', tagName: 'iframe', properties: {
                src: embed, title: label && label !== href ? label : 'Embedded video', loading: 'lazy',
                allow: 'fullscreen; picture-in-picture; encrypted-media', allowFullScreen: true, referrerPolicy: 'strict-origin-when-cross-origin',
              }, children: [],
            }] };
            continue;
          }
        }
        if (node.type !== 'element' || node.tagName !== 'img') {
          if (node.children) visit(node);
          continue;
        }
        const properties = node.properties ?? (node.properties = {});
        const original = typeof properties.src === 'string' ? properties.src : '';
        if (!original) continue;
        // Prepared video and audio use the picture syntax in text; render them as players.
        const kind = mediaKindOf(original);
        if (kind !== 'image') {
          const label = typeof properties.alt === 'string' ? properties.alt : '';
          const entry = registry[original];
          parent.children[index] = {
            type: 'element', tagName: kind, properties: entry?.loop ? {
              // An animation: plays like a GIF (src/scripts/media.ts pauses it for reduced motion).
              src: original, dataAnimation: '', autoPlay: true, muted: true, loop: true, playsInline: true, preload: 'metadata',
              disablePictureInPicture: true, ...(entry.poster ? { poster: entry.poster } : {}), ...(entry.width ? { width: entry.width, height: entry.height } : {}),
              ...(label ? { ariaLabel: label } : {}),
            } : {
              src: original, controls: true, preload: 'none', ...(kind === 'video' ? { playsInline: true, controlslist: 'nodownload' } : {}),
              ...(label ? { ariaLabel: label } : {}),
            }, children: [],
          };
          continue;
        }
        properties.loading ??= 'lazy';
        properties.decoding ??= 'async';
        properties.dataZoom = '';
        properties.dataZoomSrc = original;
        if (properties.title && !properties.dataZoomCaption) properties.dataZoomCaption = properties.title;

        // Relative image URLs retain their page-relative meaning; remote images are never rewritten.
        if (!original.startsWith('/') || original.startsWith('//')) continue;
        let key;
        let pathname;
        try {
          pathname = new URL(original, 'https://gwenlium.dev').pathname;
          key = decodeURIComponent(pathname);
        } catch {
          continue; // Source validation reports malformed URLs with their content filename.
        }
        if (/\.(?:gif|svg)$/i.test(key)) continue;
        const entry = manifest[key] ?? manifest[pathname];
        if (!entry) continue;
        properties.width = entry.width;
        properties.height = entry.height;
        if (parent.tagName === 'picture') continue;
        const sources = ['avif', 'webp'].flatMap((format) => {
          const variants = entry.sources?.[format] ?? [];
          if (!variants.length) return [];
          return [{
            type: 'element',
            tagName: 'source',
            properties: {
              type: `image/${format}`,
              srcSet: variants.map((variant) => `${variant.src} ${variant.width}w`).join(', '),
              sizes: properties.sizes || sizes,
            },
            children: [],
          }];
        });
        if (!sources.length) continue;
        parent.children[index] = {
          type: 'element',
          tagName: 'picture',
          properties: {},
          children: [...sources, node],
        };
      }
    };
    visit(tree);
  };
}
