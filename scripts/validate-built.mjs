import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'cheerio';
import {
  containedFile, isPublishedPost, mediaFilePattern, previewReferenceIssue, publicBranding, readMediaPreviews,
  readPosts, resolvePublicUrl, siteOrigin, srcsetUrls, validatePreviewFiles, walkFiles,
} from './validate-source.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const relativeName = (root, file) => path.relative(root, file).split(path.sep).join('/');
const routeForFile = (directory, file) => `/${relativeName(directory, file)}`.replace(/(?:^|\/)index\.html$/, '/');

function readDerivativePaths(root, previews, report) {
  const name = 'src/generated/media.json';
  const derivatives = new Set();
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('Expected an image optimizer manifest object.');
  } catch (error) {
    report(name, 'optimized previews', `Cannot read generated image variants: ${error.message} Run the normal build to regenerate them from registered previews.`);
    return derivatives;
  }
  for (const [source, entry] of Object.entries(manifest)) {
    if (!Object.hasOwn(previews, source) || previews[source].kind !== 'image' || entry?.src !== source ||
        !Number.isSafeInteger(entry.width) || entry.width <= 0 || !Number.isSafeInteger(entry.height) || entry.height <= 0 ||
        !entry.sources || typeof entry.sources !== 'object' || Array.isArray(entry.sources)) {
      report(name, source, 'Optimized images must be generated from a registered image preview. Rebuild rather than editing this file.');
      continue;
    }
    for (const [format, variants] of Object.entries(entry.sources)) {
      if (!['avif', 'webp'].includes(format) || !Array.isArray(variants)) {
        report(name, source, 'Expected generated AVIF/WebP variant arrays. Rebuild the image optimizer output.');
        continue;
      }
      for (const variant of variants) {
        const match = typeof variant?.src === 'string' && /^\/_generated\/media\/[a-f0-9]{32}-(\d+)\.(avif|webp)$/.exec(variant.src);
        if (!match || match[2] !== format || !Number.isSafeInteger(variant.width) || variant.width <= 0 ||
            variant.width > Math.min(entry.width, 1600) || Number(match[1]) !== variant.width) {
          report(name, source, 'Invalid optimized preview path or dimensions. Rebuild the image optimizer output.');
        } else derivatives.add(variant.src);
      }
    }
  }
  return derivatives;
}

export function validateBuilt(root = projectRoot, directory = path.join(root, 'dist'), now = new Date()) {
  const errors = [];
  const errorSet = new Set();
  const report = (file, field, message) => {
    const error = `${file}: ${field} — ${message}`;
    if (!errorSet.has(error)) {
      errorSet.add(error);
      errors.push(error);
    }
  };
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    report(relativeName(root, directory), 'output', 'Build the Astro site first; the output directory does not exist.');
    return { errors, pages: 0, references: 0 };
  }
  const files = walkFiles(directory);
  const previews = readMediaPreviews(root, report);
  validatePreviewFiles(root, directory, previews, report);
  const derivatives = readDerivativePaths(root, previews, report);
  const generatedDirectory = path.join(directory, '_generated/media');
  if (fs.existsSync(generatedDirectory)) {
    if (fs.lstatSync(path.join(directory, '_generated')).isSymbolicLink() || fs.lstatSync(generatedDirectory).isSymbolicLink() || !fs.statSync(generatedDirectory).isDirectory()) {
      report(relativeName(root, generatedDirectory), 'optimized previews', 'Generated media must be a real directory, not a symlink or file.');
    } else {
      for (const entry of fs.readdirSync(generatedDirectory, { withFileTypes: true })) {
        if (!entry.isFile() || !derivatives.has(`/_generated/media/${entry.name}`)) report(relativeName(root, path.join(generatedDirectory, entry.name)), 'optimized preview', 'Unexpected output: only current optimizer variants of registered previews may be published. Remove stale generated output and rebuild.');
      }
    }
  }
  for (const pathname of derivatives) {
    if (!containedFile(directory, pathname)) report(relativeName(root, directory), pathname, 'Missing or unsafe optimized preview. Rebuild image variants from registered previews.');
  }
  for (const file of files) {
    const pathname = `/${relativeName(directory, file)}`;
    if (mediaFilePattern.test(pathname) && !Object.hasOwn(publicBranding, pathname) && !Object.hasOwn(previews, pathname) && !derivatives.has(pathname)) {
      report(relativeName(root, file), 'media output', 'Unexpected public media. Import a preview with npm run media:import; keep original masters outside the repository.');
    }
  }
  const htmlFiles = files.filter((file) => /\.html$/i.test(file));
  if (!htmlFiles.length) report(relativeName(root, directory), 'output', 'No HTML pages were generated.');
  const posts = readPosts(root, report);
  const unpublished = new Map(posts.filter((post) => !isPublishedPost(post.data, now) && typeof post.data.permalink === 'string' && post.data.permalink)
    .map((post) => [`/${post.data.section ?? 'devlog'}/${post.data.permalink}/`, post.file]));
  const documents = new Map();
  const targets = new Map();
  let references = 0;

  const documentFor = (file) => {
    if (!documents.has(file)) {
      const $ = load(fs.readFileSync(file, 'utf8'), { xmlMode: /\.(?:svg|xml)$/i.test(file) });
      const ids = new Set();
      $('[id]').each((_, element) => {
        const id = $(element).attr('id');
        if (ids.has(id)) report(relativeName(root, file), 'id', `Duplicate element ID ${JSON.stringify(id)}. Give repeated windows and controls distinct identifiers.`);
        ids.add(id);
      });
      $('a[name]').each((_, element) => ids.add($(element).attr('name')));
      documents.set(file, { $, ids });
    }
    return documents.get(file);
  };
  const targetFor = (pathname) => {
    if (!targets.has(pathname)) {
      const candidates = pathname.endsWith('/')
        ? [`${pathname}index.html`]
        : [pathname, `${pathname}/index.html`, ...(path.posix.extname(pathname) ? [] : [`${pathname}.html`])];
      targets.set(pathname, candidates.map((candidate) => containedFile(directory, candidate)).find(Boolean) ?? null);
    }
    return targets.get(pathname);
  };
  const check = (value, file, field, base, { media = false, kind, allowTrailer = false, required = false, sitemap = false } = {}) => {
    if (typeof value !== 'string' || (required && !value.trim())) {
      report(file, field, 'Provide a nonempty URL, or omit this element when no content is configured.');
      return;
    }
    references++;
    let local;
    try {
      local = resolvePublicUrl(value, base, { media, allowContact: !sitemap && !media });
    } catch (error) {
      report(file, field, `${error.message} Value: ${JSON.stringify(value)}.`);
      return;
    }
    if (sitemap) {
      let parsed;
      try { parsed = new URL(value); } catch { /* Report below rather than losing the file context. */ }
      if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || !local) {
        report(file, field, `Use an absolute ${siteOrigin} URL in the sitemap, not ${JSON.stringify(value)}.`);
        return;
      }
      if (parsed.hash) report(file, field, 'Sitemap locations must not contain anchor fragments.');
    }
    if (media || (local && (local.pathname.startsWith('/media/') || local.pathname.startsWith('/_generated/media/') || mediaFilePattern.test(local.pathname)))) {
      const issue = previewReferenceIssue(value, local, previews, { kind, allowTrailer, derivatives });
      if (issue) report(file, field, issue);
    }
    if (!local) return;
    const canonicalPostRoute = local.pathname.replace(/\/(?:index\.html)?$/, '').replace(/\.html$/, '') + '/';
    if (unpublished.has(canonicalPostRoute)) {
      report(file, field, `Links to unpublished post ${JSON.stringify(value)} (${unpublished.get(canonicalPostRoute)}). Publish it with a nonfuture date or remove the public link.`);
    }
    const target = targetFor(local.pathname);
    if (!target) {
      report(file, field, `Missing local target ${JSON.stringify(value)} (resolved to ${local.pathname}). Correct the URL or include the target in the build.`);
      return;
    }
    const fragment = local.fragment.split(':~:text=', 1)[0];
    if (!fragment || fragment.toLowerCase() === 'top') return;
    if (/\.svg$/i.test(target) && fragment.startsWith('svgView(')) return;
    if (!/\.(?:html|svg)$/i.test(target)) return;
    if (!documentFor(target).ids.has(fragment)) {
      report(file, field, `Missing anchor #${fragment} in ${relativeName(root, target)}. Update the fragment to an existing heading or element ID.`);
    }
  };
  const checkAttributes = ($, file, base) => {
    $('*').each((_, element) => {
      const node = $(element);
      for (const attribute of ['href', 'xlink:href', 'src', 'poster', 'action', 'formaction', 'data', 'data-full-src']) {
        if (attribute === 'data' && element.tagName !== 'object') continue;
        if (attribute === 'href' && element.tagName === 'base') continue;
        const value = node.attr(attribute);
        if (value === undefined) continue;
        check(value, file, `<${element.tagName}>[${attribute}]`, base, {
          media: ['poster', 'data', 'data-full-src'].includes(attribute) || (attribute === 'src' && ['img', 'audio', 'video', 'source', 'iframe', 'embed'].includes(element.tagName)),
          kind: attribute === 'poster' || attribute === 'data-full-src' || element.tagName === 'img' ? 'image' : ['audio', 'video'].includes(element.tagName) ? element.tagName : undefined,
          allowTrailer: element.tagName === 'iframe',
          required: !['href', 'xlink:href'].includes(attribute),
        });
      }
      for (const value of srcsetUrls(node.attr('srcset') ?? '')) check(value, file, `<${element.tagName}>[srcset]`, base, { media: true, kind: 'image', required: true });
      for (const value of srcsetUrls(node.attr('imagesrcset') ?? '')) check(value, file, `<${element.tagName}>[imagesrcset]`, base, { media: true, kind: 'image', required: true });
      if (element.tagName === 'meta' && ['og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image'].includes(node.attr('property') ?? node.attr('name'))) {
        check(node.attr('content'), file, '<meta>[content]', base, { media: true, kind: 'image', required: true });
      }
    });
  };

  for (const file of htmlFiles) {
    const name = relativeName(root, file);
    const route = routeForFile(directory, file);
    if (unpublished.has(route)) report(name, 'route', `Unpublished source ${unpublished.get(route)} generated a public page. Exclude drafts and future posts from getStaticPaths().`);
    const { $ } = documentFor(file);
    let base = new URL(route, siteOrigin).href;
    const configuredBase = $('base[href]').first().attr('href');
    if (configuredBase !== undefined) {
      try {
        resolvePublicUrl(configuredBase, base);
        base = new URL(configuredBase, base).href;
      } catch (error) {
        report(name, '<base>[href]', error.message);
      }
    }
    checkAttributes($, name, base);
  }

  const sitemaps = files.filter((file) => /^sitemap(?:[-.][^/]*)?\.xml$/i.test(path.basename(file)));
  if (!sitemaps.length) report('dist/', 'sitemap', 'No sitemap XML was generated. Enable the Astro sitemap integration.');
  for (const file of sitemaps) {
    const name = relativeName(root, file);
    const { $ } = documentFor(file);
    const rootName = $.root().children().first().get(0)?.tagName;
    if (!['sitemapindex', 'urlset'].includes(rootName)) {
      report(name, 'XML', 'Expected a sitemapindex or urlset XML root.');
      continue;
    }
    const entries = rootName === 'sitemapindex' ? $('sitemapindex > sitemap') : $('urlset > url');
    if (rootName === 'sitemapindex' && !entries.length) report(name, 'sitemapindex', 'List at least one generated sitemap.');
    entries.each((index, element) => {
      const location = $(element).children('loc').text().trim();
      check(location, name, `${rootName}[${index}].loc`, `${siteOrigin}/`, { required: true, sitemap: true });
    });
  }

  const searchFile = containedFile(directory, '/search-index.json');
  if (!searchFile) report('dist/search-index.json', 'search', 'Generate the site search index.');
  else {
    const name = relativeName(root, searchFile);
    try {
      const { entries } = JSON.parse(fs.readFileSync(searchFile, 'utf8'));
      if (!Array.isArray(entries)) report(name, 'entries', 'Search entries must be an array.');
      else {
        const ids = new Set();
        entries.forEach((entry, index) => {
          if (!entry || typeof entry.id !== 'string' || !entry.id || ids.has(entry.id)) report(name, `entries[${index}].id`, 'Every search result needs a unique ID.');
          ids.add(entry?.id);
          check(entry?.url, name, `entries[${index}].url`, `${siteOrigin}/`, { required: true });
        });
      }
    } catch (error) {
      report(name, 'search', `Cannot read search index: ${error.message}`);
    }
  }

  const rssFile = containedFile(directory, '/rss.xml');
  if (!rssFile) report('dist/rss.xml', 'RSS', 'Generate a valid RSS channel, even when there are no published posts.');
  else {
    const name = relativeName(root, rssFile);
    const { $ } = documentFor(rssFile);
    const channel = $('rss > channel');
    if (channel.length !== 1) report(name, 'RSS', 'Expected one RSS channel.');
    else {
      for (const field of ['title', 'description', 'link']) {
        if (!channel.children(field).length) report(name, `channel.${field}`, `Include the required RSS ${field} element.`);
      }
      if (channel.children('link').length) check(channel.children('link').first().text().trim(), name, 'channel.link', `${siteOrigin}/`, { required: true });
      const expectedPosts = new Map(posts.filter((post) => isPublishedPost(post.data, now))
        .map((post) => [new URL(`/${post.data.section ?? 'devlog'}/${post.data.permalink}/`, siteOrigin).href, post]));
      channel.children('item').each((index, element) => {
        const item = $(element);
        const field = `item[${index}]`;
        const itemLink = item.children('link').first().text().trim();
        check(itemLink, name, `${field}.link`, `${siteOrigin}/`, { required: true });
        if (!expectedPosts.delete(itemLink)) report(name, field, 'Feed entry is duplicated or does not match a published post.');
        const content = item.children('content\\:encoded').text();
        if (!item.children('content\\:encoded').length) report(name, field, 'Include full article content, not only an excerpt.');
        let articleFile;
        try { articleFile = targetFor(new URL(itemLink).pathname); } catch { /* Reported by check above. */ }
        if (articleFile) {
          const article = documentFor(articleFile).$;
          const normalize = (value) => value.replace(/\s+/g, ' ').trim();
          const articleText = normalize(article('.entry-body').text());
          const feedText = normalize(load(content, {}, false).text());
          if (articleText && !feedText.includes(articleText)) report(name, field, 'RSS content is missing article text.');
        }
        const guid = item.children('guid').first();
        if (guid.length && guid.attr('isPermaLink') !== 'false') check(guid.text().trim(), name, `${field}.guid`, `${siteOrigin}/`, { required: true });
        item.find('enclosure').each((enclosureIndex, enclosure) => check($(enclosure).attr('url'), name, `${field}.enclosure[${enclosureIndex}].url`, itemLink || `${siteOrigin}/`, { media: true, required: true }));
        item.children().each((_, child) => {
          if (!['description', 'content:encoded'].includes(child.tagName)) return;
          const content = $(child).text();
          if (!content.includes('<')) return;
          let base = `${siteOrigin}/`;
          try { base = new URL(itemLink, base).href; } catch { /* The item link was already reported. */ }
          checkAttributes(load(content, {}, false), `${name} ${field}.${child.tagName}`, base);
        });
      });
      for (const link of expectedPosts.keys()) report(name, 'RSS', `Missing published post ${link}.`);
      $('*').each((_, element) => {
        if (element.tagName === 'atom:link') check($(element).attr('href'), name, 'atom:link[href]', `${siteOrigin}/`, { required: true });
      });
    }
  }
  return { errors, pages: htmlFiles.length, references };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = validateBuilt();
  if (result.errors.length) {
    console.error(`Built-output validation failed (${result.errors.length} issue${result.errors.length === 1 ? '' : 's'}):\n${result.errors.map((error) => `  ${error}`).join('\n')}`);
    process.exitCode = 1;
  } else console.log(`Built-output validation passed: ${result.pages} pages and ${result.references} URL references; sitemap and RSS checked.`);
}
