import fs from 'node:fs';
import rehypeRaw from 'rehype-raw';
import { mediaCaption, mediaKindOf, videoEmbed } from '../lib/embed.mjs';

const manifestFile = new URL('../generated/media.json', import.meta.url);
const registryFile = new URL('../content/media-previews.json', import.meta.url);
const sizes = '(min-width: 1200px) 960px, (min-width: 800px) calc(100vw - 280px), calc(100vw - 48px)';

const contentChildren = (node) => (node.children ?? []).filter((child) => !(child.type === 'text' && !child.value.trim()));
const hasRaw = (node) => node.type === 'raw' || node.children?.some(hasRaw);

function captionOf(node) {
  const properties = node.properties ?? {};
  const description = typeof properties.alt === 'string' ? properties.alt : properties.ariaLabel;
  return mediaCaption(typeof properties.title === 'string' ? properties.title : '', typeof description === 'string' ? description : '');
}

function standaloneMedia(node) {
  if (node?.type !== 'element') return undefined;
  if (['img', 'video', 'audio'].includes(node.tagName)) return node;
  if (node.tagName === 'picture') {
    const children = contentChildren(node).filter((child) => child.type !== 'element' || child.tagName !== 'source');
    return children.length === 1 && children[0].tagName === 'img' ? children[0] : undefined;
  }
  if (node.tagName === 'a') {
    const children = contentChildren(node);
    return children.length === 1 ? standaloneMedia(children[0]) : undefined;
  }
  return undefined;
}

function firstMedia(nodes, withCaption = false) {
  for (const node of nodes) {
    if (node.type !== 'element' || node.tagName === 'figure' || node.tagName === 'figcaption') continue;
    if (['img', 'video', 'audio'].includes(node.tagName) && (!withCaption || captionOf(node))) return node;
    const media = firstMedia(node.children ?? [], withCaption);
    if (media) return media;
  }
  return undefined;
}

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
  const parseRaw = rehypeRaw();

  return (tree, file) => {
    // Astro parses raw HTML after custom plugins; normalize it now so authored media shares the same rules.
    if (hasRaw(tree)) tree = parseRaw(tree, file);
    const visit = (parent) => {
      for (let index = 0; index < (parent.children?.length ?? 0); index++) {
        const node = parent.children[index];
        // A text link alone in a paragraph becomes an embedded player; linked media stays linked.
        const only = node.type === 'element' && node.tagName === 'p' ? contentChildren(node) : [];
        if (only.length === 1 && only[0].type === 'element' && only[0].tagName === 'a' && !firstMedia(only[0].children)) {
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
            type: 'element', tagName: kind, properties: {
              ...(entry?.loop ? {
                // An animation: plays like a GIF (src/scripts/media.ts pauses it for reduced motion).
                src: original, dataAnimation: '', autoPlay: true, muted: true, loop: true, playsInline: true, preload: 'metadata',
                disablePictureInPicture: true, ...(entry.poster ? { poster: entry.poster } : {}), ...(entry.width ? { width: entry.width, height: entry.height } : {}),
                ...(label ? { ariaLabel: label } : {}),
              } : {
                src: original, controls: true, preload: kind === 'video' && !entry?.poster ? 'metadata' : 'none',
                ...(kind === 'video' ? { playsInline: true, controlslist: 'nodownload', ...(entry?.poster ? { poster: entry.poster } : {}), ...(entry?.width ? { width: entry.width, height: entry.height } : {}) } : {}),
                ...(label ? { ariaLabel: label } : {}),
              }),
              ...(typeof properties.title === 'string' ? { title: properties.title } : {}),
              dataZoomCaption: captionOf(node),
            }, children: [],
          };
          continue;
        }
        properties.loading ??= 'lazy';
        properties.decoding ??= 'async';
        properties.dataZoom = '';
        properties.dataZoomSrc = original;
        properties.dataZoomCaption = mediaCaption(typeof properties.dataZoomCaption === 'string' ? properties.dataZoomCaption : '', captionOf(node));

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

    const addCaptions = (node, insideFigure = false) => {
      if (node.type === 'element' && node.tagName === 'figcaption') return;
      const figure = node.type === 'element' && node.tagName === 'figure';
      for (const child of node.children ?? []) addCaptions(child, insideFigure || figure);

      let media;
      if (figure) {
        // Authored captions, even deliberately empty ones, always remain authoritative.
        if (node.children.some((child) => child.type === 'element' && child.tagName === 'figcaption')) return;
        media = firstMedia(node.children, true);
      } else if (!insideFigure && node.type === 'element' && node.tagName === 'p') {
        const children = contentChildren(node);
        media = children.length === 1 ? standaloneMedia(children[0]) : undefined;
      }
      if (!media) return;
      const caption = captionOf(media);
      if (!caption) return;
      if (!figure) {
        node.tagName = 'figure';
        const properties = node.properties ?? (node.properties = {});
        const classes = Array.isArray(properties.className) ? properties.className : typeof properties.className === 'string' ? properties.className.split(/\s+/) : [];
        properties.className = [...classes, 'media', `media--${media.tagName === 'img' ? 'image' : media.tagName}`];
      }
      node.children.push({ type: 'element', tagName: 'figcaption', properties: {}, children: [{ type: 'text', value: caption }] });
    };
    addCaptions(tree);
    return tree;
  };
}
