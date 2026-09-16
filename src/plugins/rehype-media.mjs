import fs from 'node:fs';

const manifestFile = new URL('../generated/media.json', import.meta.url);
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

  return (tree) => {
    const visit = (parent) => {
      for (let index = 0; index < (parent.children?.length ?? 0); index++) {
        const node = parent.children[index];
        if (node.type !== 'element' || node.tagName !== 'img') {
          if (node.children) visit(node);
          continue;
        }
        const properties = node.properties ?? (node.properties = {});
        const original = typeof properties.src === 'string' ? properties.src : '';
        if (!original) continue;
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
