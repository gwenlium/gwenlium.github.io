import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import { parse as parseYaml } from 'yaml';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { load } from 'cheerio';
import { builtinWindowPages, systemWindowIds, windowContents, windowPages, windowTones } from '../src/lib/window-catalogue.mjs';
import { normalizeWatermarkCredit, watermarkCreditError } from '../src/lib/watermark.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const siteOrigin = 'https://gwenlium.dev';
const permalinkPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const relativeName = (root, file) => path.relative(root, file).split(path.sep).join('/');
const previewPathPattern = /^\/media\/([a-z0-9]+(?:-[a-z0-9]+)*)-preview-[a-f0-9]{32}\.(webp|gif|mp3|mp4)$/;
const previewKinds = { webp: 'image', gif: 'image', mp3: 'audio', mp4: 'video' };
export const publicBranding = { '/avatar.webp': true, '/favicon.png': true, '/social-card.png': true, '/followit-logo.svg': true };
export const mediaFilePattern = /\.(?:avif|bmp|gif|heic|heif|ico|jpe?g|png|psd|svg|tiff?|webp|aac|aiff?|alac|flac|m4a|mp3|oga|ogg|opus|wav|wma|3gp|avi|m4v|mkv|mov|mp4|mpeg|mpg|ogv|webm|wmv)$/i;
const trailerHosts = { 'youtube.com': true, 'www.youtube.com': true, 'm.youtube.com': true, 'youtu.be': true, 'www.youtube-nocookie.com': true, 'youtube-nocookie.com': true, 'vimeo.com': true, 'www.vimeo.com': true, 'player.vimeo.com': true };
const importInstruction = 'Use the admin media picker to upload a processed copy, or keep the original outside this repository and run npm run media:import -- "/absolute/path/to/original". Commit the generated public/media file and src/content/media-previews.json together.';

export function readMediaPreviews(root, report) {
  const file = 'src/content/media-previews.json';
  const previews = Object.create(null);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    if (!isObject(manifest) || Object.keys(manifest).some((key) => key !== 'files') || !isObject(manifest.files)) throw new Error('Expected exactly {"files": {...}}.');
  } catch (error) {
    report(file, 'registry', `Cannot read the preview registry: ${error.message} ${importInstruction}`);
    return previews;
  }
  for (const [url, entry] of Object.entries(manifest.files)) {
    const match = previewPathPattern.exec(url);
    const field = `files[${JSON.stringify(url)}]`;
    if (!match || match[1].length > 64) {
      report(file, field, `Use only importer-generated /media/name-preview-hash.webp, .gif, .mp3 or .mp4 paths. ${importInstruction}`);
      continue;
    }
    if (!isObject(entry) || Object.keys(entry).some((key) => !['sha256', 'kind', 'width', 'height', 'duration'].includes(key)) ||
        typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256) || entry.kind !== previewKinds[match[2]] ||
        ['width', 'height'].some((key) => entry[key] !== undefined && (!Number.isSafeInteger(entry[key]) || entry[key] <= 0)) ||
        (entry.duration !== undefined && (typeof entry.duration !== 'number' || !Number.isFinite(entry.duration) || entry.duration <= 0))) {
      report(file, field, `Invalid preview metadata: require a SHA256, the matching image/audio/video kind, and only optional positive width, height or duration. Never store original paths or private metadata here. ${importInstruction}`);
      continue;
    }
    previews[url] = entry;
  }
  return previews;
}

export function validatePreviewFiles(root, directory, previews, report) {
  const mediaDirectory = path.join(directory, 'media');
  const seen = new Set();
  try {
    const mediaStat = fs.lstatSync(mediaDirectory, { throwIfNoEntry: false });
    if (mediaStat) {
      if (fs.lstatSync(directory).isSymbolicLink() || mediaStat.isSymbolicLink() || !mediaStat.isDirectory()) {
        report(relativeName(root, mediaDirectory), 'previews', `Use a real media directory, not a symlink or file. ${importInstruction}`);
      } else {
        for (const entry of fs.readdirSync(mediaDirectory, { withFileTypes: true })) {
          const filename = path.join(mediaDirectory, entry.name);
          const url = `/media/${entry.name}`;
          if (!entry.isFile()) {
            report(relativeName(root, filename), 'preview', `Only prepared files directly inside media/ are allowed; no directories, symlinks or special files. ${importInstruction}`);
            continue;
          }
          if (entry.name === '.gitkeep') {
            if (fs.statSync(filename).size !== 0) report(relativeName(root, filename), 'preview', '.gitkeep must be empty; it is not a place to store media.');
            continue;
          }
          if (!Object.hasOwn(previews, url)) {
            report(relativeName(root, filename), 'preview', `Unregistered media cannot be published. ${importInstruction}`);
            continue;
          }
          seen.add(url);
          const contained = containedFile(directory, url);
          if (!contained) report(relativeName(root, filename), 'preview', `The preview is not safely contained in media/. ${importInstruction}`);
          else if (createHash('sha256').update(fs.readFileSync(contained)).digest('hex') !== previews[url].sha256) {
            report(relativeName(root, filename), 'SHA256', `The preview differs from its registered bytes. Re-import it instead of replacing or editing the file. ${importInstruction}`);
          }
        }
      }
    }
  } catch (error) {
    report(relativeName(root, mediaDirectory), 'previews', `Cannot inspect preview files: ${error.message}`);
  }
  for (const url of Object.keys(previews)) {
    if (!seen.has(url)) report(relativeName(root, directory), url, `Registered preview is missing. ${importInstruction}`);
  }
}

export function previewReferenceIssue(value, local, previews, { kind, allowTrailer = false, derivatives } = {}) {
  if (!local) {
    let external;
    try { external = new URL(value); } catch { /* Report the unsupported media reference below. */ }
    if (allowTrailer && external?.protocol === 'https:' && Object.hasOwn(trailerHosts, external.hostname)) return null;
    return `Use a registered /media/... preview URL, not an external or embedded original. ${importInstruction}`;
  }
  if (Object.hasOwn(publicBranding, local.pathname)) return kind && kind !== 'image' ? 'Public branding is an image, not an audio/video preview.' : null;
  if (derivatives?.has(local.pathname)) return kind && kind !== 'image' ? 'An optimized image cannot be used as an audio/video preview.' : null;
  const entry = previews[local.pathname];
  if (!entry) return `Unregistered media ${JSON.stringify(local.pathname)}. ${importInstruction}`;
  return kind && entry.kind !== kind ? `Expected a prepared ${kind} preview, but ${JSON.stringify(local.pathname)} is registered as ${entry.kind}.` : null;
}

export function walkFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name, 'en'))
    .flatMap((entry) => {
      const file = path.join(directory, entry.name);
      return entry.isDirectory() ? walkFiles(file) : entry.isFile() ? [file] : [];
    });
}

export function isoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}

export function isPublishedPost(data, now = new Date()) {
  const date = isoDate(data.date);
  return data.draft === false && date !== null && date.getTime() <= now.getTime();
}

export function readPosts(root, report) {
  return walkFiles(path.join(root, 'src/content/posts'))
    .filter((file) => /\.md$/i.test(file))
    .flatMap((file) => {
      const name = relativeName(root, file);
      try {
        const source = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
        const language = matter.test(source) ? matter.language(source).name : '';
        if (language && language !== 'yaml') throw new Error('Use YAML frontmatter delimited by ---. Executable or alternate frontmatter engines are not supported.');
        const parsed = matter(source, {
          engines: { yaml: (source) => parseYaml(source, { uniqueKeys: true }) },
        });
        if (!isObject(parsed.data)) throw new Error('Frontmatter must be a YAML mapping.');
        return [{ file: name, data: parsed.data, body: parsed.content }];
      } catch (error) {
        report(name, 'frontmatter', `Cannot parse YAML: ${error.message}`);
        return [];
      }
    });
}

// Follow the srcset URL-token rules: commas inside a URL (notably data:) are not separators.
export function srcsetUrls(value) {
  const urls = [];
  let index = 0;
  while (index < value.length) {
    while (index < value.length && /[\s,]/.test(value[index])) index++;
    if (index === value.length) break;
    const start = index;
    while (index < value.length && !/\s/.test(value[index])) index++;
    const token = value.slice(start, index);
    const url = token.replace(/,+$/, '');
    if (url) urls.push(url);
    if (token.endsWith(',')) continue;
    let parentheses = 0;
    while (index < value.length) {
      const character = value[index++];
      if (character === '(') parentheses++;
      else if (character === ')') parentheses = Math.max(0, parentheses - 1);
      else if (character === ',' && parentheses === 0) break;
    }
  }
  return urls;
}

// The returned pathname is decoded for the filesystem, never used without a containment check.
export function resolvePublicUrl(value, base = `${siteOrigin}/`, { media = false, allowContact = false } = {}) {
  if (typeof value !== 'string') throw new Error('Use a URL string.');
  const input = value.trim();
  if (/[\u0000-\u001f\u007f\\]/.test(input)) throw new Error('Remove control characters or backslashes from the URL.');
  const url = new URL(input, base);
  if (allowContact && ['data:', 'mailto:', 'tel:'].includes(url.protocol)) return null;
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Use http(s), a site-relative path, or an anchor; this URL protocol is not supported.');
  if (url.username || url.password) throw new Error('Remove embedded usernames or passwords from the URL.');
  if (url.host !== new URL(siteOrigin).host) return null;

  const rawPath = input.split(/[?#]/, 1)[0].replace(/^(?:https?:)?\/\/[^/]+/i, '');
  if (/%(?:2f|5c)/i.test(rawPath)) throw new Error('Do not percent-encode path separators; use ordinary forward slashes.');
  const decodedRaw = decodeURIComponent(rawPath);
  if (/[\u0000-\u001f\u007f\\:]/.test(decodedRaw)) throw new Error('The local URL contains an unsafe path character.');
  const rawSegments = decodedRaw.split('/');
  if (media && rawSegments.includes('..')) throw new Error('Media paths must not contain parent-directory traversal; use a /media/ path.');
  let depth = rawPath.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(input)
    ? 0
    : new URL(base).pathname.split('/').filter(Boolean).length - (new URL(base).pathname.endsWith('/') ? 0 : 1);
  for (const segment of rawSegments) {
    if (segment === '..') {
      if (--depth < 0) throw new Error('The URL traverses above the public site root.');
    } else if (segment && segment !== '.') depth++;
  }
  const pathname = decodeURIComponent(url.pathname);
  if (/[\u0000-\u001f\u007f\\:]/.test(pathname)) throw new Error('The local URL contains an unsafe path character.');
  return { url, pathname, fragment: decodeURIComponent(url.hash.slice(1)) };
}

export function containedFile(directory, pathname) {
  const file = path.resolve(directory, `.${pathname}`);
  const relative = path.relative(directory, file);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) return null;
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  if (process.platform === 'win32' || process.platform === 'darwin') {
    let parent = directory;
    for (const segment of relative.split(path.sep)) {
      if (!fs.readdirSync(parent).includes(segment)) return null;
      parent = path.join(parent, segment);
    }
  }
  const realRelative = path.relative(fs.realpathSync(directory), fs.realpathSync(file));
  return realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative) ? null : file;
}

export function validateSource(root = projectRoot, now = new Date()) {
  const errors = [];
  const report = (file, field, message) => errors.push(`${file}: ${field} - ${message}`);
  const posts = readPosts(root, report);
  const publicDirectory = path.join(root, 'public');
  const previews = readMediaPreviews(root, report);
  validatePreviewFiles(root, publicDirectory, previews, report);
  for (const file of walkFiles(publicDirectory)) {
    const pathname = `/${relativeName(publicDirectory, file)}`;
    if (mediaFilePattern.test(pathname) && !pathname.startsWith('/media/') && !pathname.startsWith('/_generated/media/') && !Object.hasOwn(publicBranding, pathname)) {
      report(relativeName(root, file), 'media', `Media outside the prepared-preview directory cannot be published. ${importInstruction}`);
    }
  }
  const text = (value, file, field, required = false) => {
    if (value === undefined && !required) return false;
    if (typeof value !== 'string' || (required && !value.trim())) {
      report(file, field, required ? 'Provide a nonempty text value.' : 'Use a text string (or leave it empty).');
      return false;
    }
    return value.trim().length > 0;
  };
  const url = (value, file, field, { media = false, kind, allowTrailer = false, base = `${siteOrigin}/`, required = false } = {}) => {
    if (!text(value, file, field, required)) return;
    try {
      const local = resolvePublicUrl(value, base, { media });
      if (media || (local && (local.pathname.startsWith('/media/') || mediaFilePattern.test(local.pathname)))) {
        const issue = previewReferenceIssue(value, local, previews, { kind, allowTrailer });
        if (issue) report(file, field, issue);
        else if (local && !containedFile(publicDirectory, local.pathname)) report(file, field, `Missing local preview ${JSON.stringify(local.pathname)}; filenames are case-sensitive when deployed. ${importInstruction}`);
      }
    } catch (error) {
      report(file, field, `${error.message} Value: ${JSON.stringify(value)}.`);
    }
  };
  const image = (src, alt, file, field, base) => {
    url(src, file, field, { media: true, kind: 'image', base });
    if (typeof src === 'string' && src.trim()) text(alt, file, `${field}Alt`, true);
    else if (alt !== undefined) text(alt, file, `${field}Alt`);
  };
  const links = (value, file, field) => {
    if (value === undefined) return;
    if (!Array.isArray(value)) return report(file, field, 'Use an array of {label, url} links.');
    value.forEach((link, index) => {
      const key = `${field}[${index}]`;
      if (!isObject(link)) return report(file, key, 'Use an object with label and url.');
      text(link.label, file, `${key}.label`, true);
      url(link.url, file, `${key}.url`, { required: true });
    });
  };
  const optionalStrings = (value, fields, file, prefix = '') => {
    for (const field of fields) text(value[field], file, `${prefix}${field}`);
  };
  const topics = (value, file, field) => {
    if (value === undefined) return;
    if (!Array.isArray(value)) return report(file, field, 'Use a list of topic names.');
    value.forEach((topic, index) => text(topic, file, `${field}[${index}]`, true));
  };
  const photos = (items, file, base) => {
    if (items === undefined || items === '') return;
    if (!Array.isArray(items)) return report(file, 'photos', 'Use a list of photo URLs.');
    items.forEach((src, index) => url(src, file, `photos[${index}]`, { media: true, kind: 'image', base, required: true }));
  };
  const mediaItems = (items, file, field, { gallery = false, base = `${siteOrigin}/` } = {}) => {
    if (items === undefined) return;
    if (!Array.isArray(items)) return report(file, field, 'Use an array of media objects.');
    const ids = new Set();
    items.forEach((item, index) => {
      const key = `${field}[${index}]`;
      if (!isObject(item)) return report(file, key, 'Use a media object.');
      if (gallery) {
        topics(item.topics, file, `${key}.topics`);
        if (text(item.id, file, `${key}.id`, true)) {
          if (ids.has(item.id)) report(file, `${key}.id`, `Duplicate ID ${JSON.stringify(item.id)}. Give each gallery entry a unique ID.`);
          ids.add(item.id);
        }
        text(item.title, file, `${key}.title`, true);
      }
      const types = gallery ? ['image', 'video'] : ['image', 'video', 'audio'];
      if (!types.includes(item.type)) report(file, `${key}.type`, `Choose one of: ${types.join(', ')}.`);
      url(item.src, file, `${key}.src`, { media: true, kind: item.type, base, required: true });
      text(item.alt, file, `${key}.alt`, item.type === 'image');
      text(item.caption, file, `${key}.caption`);
      url(item.poster, file, `${key}.poster`, { media: true, kind: 'image', base });
    });
  };
  const html = (source, file, field, base) => {
    const $ = load(source, {}, false);
    $('*').each((_, element) => {
      const node = $(element);
      for (const attribute of ['href', 'xlink:href', 'src', 'poster', 'action', 'formaction', 'data']) {
        if (attribute === 'data' && element.tagName !== 'object') continue;
        const value = node.attr(attribute);
        if (value !== undefined) url(value, file, `${field} <${element.tagName}>[${attribute}]`, {
          media: ['src', 'poster', 'data'].includes(attribute), base, required: attribute !== 'href' && attribute !== 'xlink:href',
          kind: attribute === 'poster' || element.tagName === 'img' ? 'image' : ['audio', 'video'].includes(element.tagName) ? element.tagName : undefined,
          allowTrailer: element.tagName === 'iframe',
        });
      }
      for (const attribute of ['srcset', 'imagesrcset']) {
        for (const value of srcsetUrls(node.attr(attribute) ?? '')) url(value, file, `${field} <${element.tagName}>[${attribute}]`, { media: true, kind: 'image', base });
      }
      if (element.tagName === 'img' && (node.attr('src') || node.attr('srcset'))) text(node.attr('alt'), file, `${field} <img>[alt]`, true);
    });
  };
  const markdown = (source, file, base, prefix = 'body') => {
    const tree = fromMarkdown(source);
    const definitions = new Map();
    const visit = (node, callback) => {
      callback(node);
      for (const child of node.children ?? []) visit(child, callback);
    };
    visit(tree, (node) => {
      if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node);
    });
    visit(tree, (node) => {
      const field = `${prefix}:${node.position?.start.line ?? 1}`;
      if (node.type === 'link' || node.type === 'image' || node.type === 'definition') {
        url(node.url, file, field, { media: node.type === 'image', kind: node.type === 'image' ? 'image' : undefined, base, required: true });
      }
      if (node.type === 'image' || node.type === 'imageReference') text(node.alt, file, `${field} image alt`, true);
      if (node.type === 'imageReference' || node.type === 'linkReference') {
        const definition = definitions.get(node.identifier);
        if (definition) url(definition.url, file, field, { media: node.type === 'imageReference', kind: node.type === 'imageReference' ? 'image' : undefined, base, required: true });
      }
      if (node.type === 'html') html(node.value, file, field, base);
    });
  };

  const slugs = new Map();
  for (const post of posts) {
    const { data, file } = post;
    if (typeof data.permalink === 'string' && data.permalink.trim()) {
      const key = data.permalink.trim().toLowerCase();
      if (slugs.has(key)) report(file, 'permalink', `Duplicate permalink ${JSON.stringify(data.permalink)} also appears in ${slugs.get(key)}. Give every post, including drafts and scheduled posts, a unique lowercase permalink.`);
      else slugs.set(key, file);
    }
    if (data.draft !== undefined && typeof data.draft !== 'boolean') report(file, 'draft', 'Use the YAML boolean true or false, not quoted text. Omitted draft defaults to true.');
    if (data.section !== undefined && !['devlog', 'life'].includes(data.section)) report(file, 'section', 'Choose devlog or life.');
    const date = isoDate(data.date);
    if (data.draft !== false || (date && date.getTime() > now.getTime())) continue;
    text(data.title, file, 'title', true);
    if (typeof data.permalink !== 'string' || !permalinkPattern.test(data.permalink)) report(file, 'permalink', 'Provide a lowercase slug containing letters, digits and single hyphens, for example my-post.');
    if (!date) report(file, 'date', 'Provide a real calendar date in YYYY-MM-DD format.');
    if (data.excerpt !== undefined && typeof data.excerpt !== 'string') report(file, 'excerpt', 'Provide a text string, or leave the excerpt empty.');
    if (data.tags !== undefined && (!Array.isArray(data.tags) || data.tags.some((tag) => typeof tag !== 'string'))) report(file, 'tags', 'Use an array of text strings.');
    if (data.featured !== undefined && typeof data.featured !== 'boolean') report(file, 'featured', 'Use the YAML boolean true or false.');
    const base = `${siteOrigin}/${data.section ?? 'devlog'}/${permalinkPattern.test(data.permalink ?? '') ? data.permalink : 'post'}/`;
    image(data.cover, data.coverAlt, file, 'cover', base);
    photos(data.photos, file, base);
    mediaItems(data.media, file, 'media', { base });
    markdown(post.body, file, base);
  }

  const json = (name) => {
    const file = `src/content/${name}.json`;
    try {
      const value = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
      if (!isObject(value)) throw new Error('The top level must be an object.');
      return { file, value };
    } catch (error) {
      report(file, 'JSON', `Cannot read content: ${error.message}`);
      return null;
    }
  };
  const settings = json('site');
  if (settings) {
    const { file, value } = settings;
    text(value.name, file, 'name', true);
    if (value.maintenanceEnabled !== undefined && typeof value.maintenanceEnabled !== 'boolean') report(file, 'maintenanceEnabled', 'Use a boolean maintenance toggle.');
    optionalStrings(value, ['maintenanceHeading', 'maintenanceMessage'], file);
    optionalStrings(value, ['description', 'intro', 'status', 'featuredPost', 'newsletterHeading', 'newsletterButtonLabel'], file);
    try { normalizeWatermarkCredit(value.watermarkText) || normalizeWatermarkCredit(`© ${typeof value.name === 'string' ? value.name.trim() : ''}`); }
    catch { report(file, 'watermarkText', watermarkCreditError); }
    url(value.githubUrl, file, 'githubUrl');
    if (text(value.newsletterUrl, file, 'newsletterUrl')) {
      try {
        const newsletter = new URL(value.newsletterUrl);
        if (newsletter.protocol !== 'https:' || newsletter.username || newsletter.password || /(^|\.)(example\.(com|net|org)|example|localhost|invalid|test)$/.test(newsletter.hostname)) throw new Error('placeholder or non-HTTPS URL');
      } catch {
        report(file, 'newsletterUrl', 'Use your real absolute HTTPS subscription-page URL, or leave this value empty until an account is configured.');
      }
    }
    if (text(value.newsletterFormAction, file, 'newsletterFormAction')) {
      try {
        const endpoint = new URL(value.newsletterFormAction);
        if (endpoint.protocol !== 'https:' || endpoint.hostname !== 'api.follow.it' || !endpoint.pathname.startsWith('/subscription-form/') || endpoint.username || endpoint.password) throw new Error('unsupported form endpoint');
      } catch {
        report(file, 'newsletterFormAction', 'Use the HTTPS subscription-form action supplied by follow.it, or leave it empty.');
      }
      text(value.newsletterButtonLabel, file, 'newsletterButtonLabel', true);
    }
    if (typeof value.featuredPost === 'string' && value.featuredPost.trim()) {
      if (!posts.some((post) => post.data.permalink === value.featuredPost && isPublishedPost(post.data, now))) report(file, 'featuredPost', 'Choose an existing published post permalink, or leave it empty. Draft and future posts cannot be featured publicly.');
    }
    if (value.game !== undefined) {
      if (!isObject(value.game)) report(file, 'game', 'Use an object for this section.');
      else {
        optionalStrings(value.game, ['title', 'description', 'status'], file, 'game.');
        links(value.game.links, file, 'game.links');
        image(value.game.cover, value.game.coverAlt, file, 'game.cover', `${siteOrigin}/devlog/`);
        url(value.game.trailerUrl, file, 'game.trailerUrl', { media: true, kind: 'video', allowTrailer: true, base: `${siteOrigin}/devlog/` });
      }
    }
  }
  for (const page of ['about', 'devlog', 'life', 'gallery', 'music', 'subscribe', 'not-found']) {
    const data = json(`pages/${page}`);
    if (!data) continue;
    const { file, value } = data;
    text(value.title, file, 'title', true);
    optionalStrings(value, ['eyebrow', 'intro'], file);
    if (page === 'about') {
      optionalStrings(value, ['body'], file);
      if (typeof value.body === 'string') markdown(value.body, file, `${siteOrigin}/about/`);
      photos(value.photos, file, `${siteOrigin}/about/`);
      mediaItems(value.media, file, 'media', { base: `${siteOrigin}/about/` });
      image(value.avatar, value.avatarAlt, file, 'avatar', `${siteOrigin}/about/`);
      links(value.links, file, 'links');
    }
    if (page === 'subscribe') text(value.rssDescription, file, 'rssDescription', true);
  }
  const art = json('gallery');
  if (art) {
    if (!Array.isArray(art.value.items)) report(art.file, 'items', 'Use an array (an empty array is valid).');
    else mediaItems(art.value.items, art.file, 'items', { gallery: true, base: `${siteOrigin}/gallery/` });
  }
  const music = json('music');
  if (music) {
    const { file, value } = music;
    if (!Array.isArray(value.tracks)) report(file, 'tracks', 'Use an array (an empty array is valid).');
    else {
      const ids = new Set();
      value.tracks.forEach((track, index) => {
        const field = `tracks[${index}]`;
        if (!isObject(track)) return report(file, field, 'Use a track object.');
        if (text(track.id, file, `${field}.id`, true)) {
          if (ids.has(track.id)) report(file, `${field}.id`, `Duplicate track ID ${JSON.stringify(track.id)}. Give each track a unique ID.`);
          ids.add(track.id);
        }
        text(track.title, file, `${field}.title`, true);
        topics(track.topics, file, `${field}.topics`);
        url(track.src, file, `${field}.src`, { media: true, kind: 'audio', base: `${siteOrigin}/music/`, required: true });
        image(track.cover, track.coverAlt, file, `${field}.cover`, `${siteOrigin}/music/`);
      });
    }
  }
  const windows = json('windows');
  if (windows) {
    const { file, value } = windows;
    if (!Array.isArray(value.windows)) report(file, 'windows', 'Use an array of window definitions. Keep the required system windows.');
    else {
      const ids = new Set();
      const selections = {
        life: new Set(posts.filter((post) => post.data.section === 'life' && isPublishedPost(post.data, now)).map((post) => post.data.permalink)),
        devlog: new Set(posts.filter((post) => (post.data.section ?? 'devlog') === 'devlog' && isPublishedPost(post.data, now)).map((post) => post.data.permalink)),
        gallery: new Set(Array.isArray(art?.value.items) ? art.value.items.filter(isObject).map((item) => item.id) : []),
        music: new Set(Array.isArray(music?.value.tracks) ? music.value.tracks.filter(isObject).map((track) => track.id) : []),
      };
      const stringFields = (object, fields, prefix) => {
        for (const key of fields) {
          if (typeof object[key] !== 'string') report(file, `${prefix}.${key}`, 'Provide a text string; use an empty string for unused text fields.');
        }
      };
      value.windows.forEach((window, index) => {
        const field = `windows[${index}]`;
        if (!isObject(window)) return report(file, field, 'Use a window object.');
        const builtin = typeof window.id === 'string' && Object.hasOwn(builtinWindowPages, window.id);
        const system = systemWindowIds.includes(window.id);
        if (typeof window.id !== 'string' || !permalinkPattern.test(window.id)) {
          report(file, `${field}.id`, 'Use a unique lowercase ID with letters, digits and single hyphens; new window IDs must start with custom-.');
        } else {
          if (ids.has(window.id)) report(file, `${field}.id`, `Duplicate window ID ${JSON.stringify(window.id)}. Give every window a unique ID.`);
          ids.add(window.id);
          if (!builtin && !window.id.startsWith('custom-')) report(file, `${field}.id`, 'New window IDs must start with custom-. Do not rename built-in windows.');
        }
        if (!windowPages.includes(window.page)) report(file, `${field}.page`, `Choose one of: ${windowPages.join(', ')}.`);
        if (builtin && window.page !== builtinWindowPages[window.id]) report(file, `${field}.page`, `Built-in window ${window.id} must stay on page ${builtinWindowPages[window.id]}. Add a custom window for another page.`);
        for (const key of ['enabled', 'floating', 'initiallyClosed']) {
          if (typeof window[key] !== 'boolean') report(file, `${field}.${key}`, 'Provide the JSON boolean true or false.');
        }
        stringFields(window, ['title', 'body'], field);
        if (window.enabled === true && typeof window.title === 'string') text(window.title, file, `${field}.title`, true);
        if (!windowTones.includes(window.tone)) report(file, `${field}.tone`, `Choose one of: ${windowTones.join(', ')}.`);
        for (const key of ['width', 'height', 'limit']) {
          if (!Number.isSafeInteger(window[key]) || window[key] < 0) report(file, `${field}.${key}`, `Provide a nonnegative whole number; 0 means ${key === 'limit' ? 'all items' : 'automatic size'}.`);
        }
        for (const key of ['x', 'y']) {
          if (window[key] !== undefined && (typeof window[key] !== 'number' || !Number.isFinite(window[key]))) report(file, `${field}.${key}`, 'Provide a finite pixel offset from the workspace origin, or omit for automatic placement.');
        }
        if (!windowContents.includes(window.content)) report(file, `${field}.content`, `Choose one of: ${windowContents.join(', ')}.`);
        if (!builtin && window.content === 'default') report(file, `${field}.content`, 'Custom windows have no built-in content. Choose text, media, links, devlog, life, gallery, music or subscribe.');
        if (system) {
          if (window.enabled !== true) report(file, `${field}.enabled`, `Keep ${window.id} enabled so site controls remain available.`);
          if (window.content !== 'default') report(file, `${field}.content`, `Keep default content for ${window.id}; its working controls cannot be replaced.`);
          if (window.floating !== true) report(file, `${field}.floating`, `Keep ${window.id} floating; system controls cannot be placed in the page layout.`);
          if (window.id === 'start-menu' && window.initiallyClosed !== true) report(file, `${field}.initiallyClosed`, 'Keep start-menu initially closed; visitors open it with the Start button.');
        }
        if (!Array.isArray(window.media)) report(file, `${field}.media`, 'Provide an array of media objects; use [] when unused.');
        else window.media.forEach((item, mediaIndex) => {
          const key = `${field}.media[${mediaIndex}]`;
          if (!isObject(item)) return report(file, key, 'Use a media object with type, src, alt, caption and poster fields.');
          if (!['image', 'video', 'audio'].includes(item.type)) report(file, `${key}.type`, 'Choose image, video or audio.');
          stringFields(item, ['src', 'alt', 'caption', 'poster'], key);
        });
        if (!Array.isArray(window.links)) report(file, `${field}.links`, 'Provide an array of {label, url} links; use [] when unused.');
        else window.links.forEach((link, linkIndex) => {
          const key = `${field}.links[${linkIndex}]`;
          if (!isObject(link)) return report(file, key, 'Use an object with label and url.');
          stringFields(link, ['label', 'url'], key);
        });
        if (!Array.isArray(window.items)) report(file, `${field}.items`, 'Provide an array of selected IDs; use [] for all available items or for content without item selections.');
        else {
          const selected = new Set();
          const available = typeof window.content === 'string' && Object.hasOwn(selections, window.content) ? selections[window.content] : undefined;
          window.items.forEach((id, itemIndex) => {
            const key = `${field}.items[${itemIndex}]`;
            if (typeof id !== 'string' || !id.trim()) return report(file, key, 'Provide a nonempty item ID.');
            if (selected.has(id)) report(file, key, `Duplicate selected ID ${JSON.stringify(id)}. Select each item only once.`);
            selected.add(id);
            if (window.enabled === true && available && !available.has(id)) {
              report(file, key, ['devlog', 'life'].includes(window.content)
                ? `No published post has permalink ${JSON.stringify(id)}. Draft and future posts cannot appear; choose a published permalink or disable this window while preparing it.`
                : `No ${window.content === 'gallery' ? 'gallery item' : 'music track'} has ID ${JSON.stringify(id)}. Choose an existing ID or disable this window while preparing it.`);
            }
          });
          if (window.enabled === true && window.items.length && !available) report(file, `${field}.items`, 'Item selections only apply to devlog, life, gallery or music content. Use [] for other content types.');
        }
        if (window.enabled !== true) return;
        const page = windowPages.includes(window.page) ? window.page : 'home';
        const base = `${siteOrigin}${page === 'home' || page === 'all' ? '/' : page === 'post' ? '/devlog/post/' : page === 'not-found' ? '/404/' : `/${page}/`}`;
        if (typeof window.body === 'string') markdown(window.body, file, base, `${field}.body`);
        if (Array.isArray(window.media)) mediaItems(window.media, file, `${field}.media`, { base });
        if (Array.isArray(window.links)) links(window.links, file, `${field}.links`);
      });
      for (const id of systemWindowIds) {
        if (!ids.has(id)) report(file, 'windows', `Missing required system window ${id}. Restore it with page all, enabled true, floating true and content default.`);
      }
    }
  }
  return { errors, posts: posts.length, published: posts.filter((post) => isPublishedPost(post.data, now)).length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = validateSource();
  if (result.errors.length) {
    console.error(`Source validation failed (${result.errors.length} issue${result.errors.length === 1 ? '' : 's'}):\n${result.errors.map((error) => `  ${error}`).join('\n')}`);
    process.exitCode = 1;
  } else console.log(`Source validation passed: ${result.published} published of ${result.posts} posts; site, gallery, music and windows checked.`);
}
