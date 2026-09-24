import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * `npm run dev` only: a stand-in for the editor worker that reads and writes this checkout.
 * It runs the worker's own validation, so what saves here would also publish.
 */
const prefix = '/__owner-editor/editor';
const repository = 'gwenlium/gwenlium.github.io';
const siteOrigin = 'https://gwenlium.dev';
const blobSha = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

async function contentFiles(root, contentPath) {
  const found = [];
  const walk = async directory => {
    for (const entry of await fs.readdir(path.join(root, directory), { withFileTypes: true })) {
      const relative = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await walk(relative);
      else if (contentPath(relative, true)) found.push(relative);
    }
  };
  await walk('src/content');
  return found.sort();
}

async function snapshot(root, contentPath) {
  const files = [];
  for (const file of await contentFiles(root, contentPath)) {
    const bytes = await fs.readFile(path.join(root, file));
    files.push({ path: file, sha: blobSha(bytes), size: bytes.length });
  }
  const head = createHash('sha1').update(files.map(file => `${file.path}:${file.sha}`).join('\n')).digest('hex');
  return { head, branch: 'main', repository, owner: { id: 47855927, login: 'local' }, files };
}

const mediaReference = /\/?media\/[a-z0-9]+(?:-[a-z0-9]+)*-preview-[a-f0-9]{32}\.(?:webp|gif|mp4|mp3)/g;

/** Media the local checkout still uses: content plus site code, like the worker checks. */
async function mediaInUse(root, texts) {
  const used = new Set();
  const walk = async directory => {
    for (const entry of await fs.readdir(path.join(root, directory), { withFileTypes: true })) {
      const relative = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!['node_modules', 'dist', '.git', '.astro', 'media', 'content', 'generated'].includes(entry.name)) await walk(relative);
      } else if (/\.(?:astro|ts|mts|js|mjs|cjs|css|json|html|md|svg|xml|ya?ml)$/.test(entry.name) && entry.name !== 'package-lock.json') {
        texts.push(await fs.readFile(path.join(root, relative), 'utf8'));
      }
    }
  };
  for (const directory of ['src', 'public', 'scripts']) await walk(directory);
  for (const text of texts) for (const match of text.matchAll(mediaReference)) used.add(`/${match[0].replace(/^\//, '')}`);
  return used;
}

function send(response, status, value) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(value));
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export default function devEditor() {
  return {
    name: 'gwenlium-dev-editor',
    hooks: {
      'astro:server:setup': ({ server }) => {
        const root = server.config.root;
        server.middlewares.use(async (request, response, next) => {
          const url = new URL(request.url ?? '/', 'http://localhost');
          if (!url.pathname.startsWith(prefix)) return next();
          const host = request.headers.host ?? '';
          if (!/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(host)) return send(response, 403, { error: 'The local editor only answers on localhost.' });
          try {
            const content = await server.ssrLoadModule('/admin-auth/src/editor-content.ts');
            const current = await snapshot(root, content.contentPath);
            if (url.pathname === prefix && request.method === 'GET') return send(response, 200, current);
            if (url.pathname === `${prefix}/file` && request.method === 'GET') {
              const file = url.searchParams.get('path');
              if (!content.contentPath(file, true)) return send(response, 400, { error: 'Not an editable content file.' });
              if (url.searchParams.get('ref') !== current.head) return send(response, 409, { error: 'The local files changed. Reload the editor.' });
              const bytes = await fs.readFile(path.join(root, file));
              return send(response, 200, { path: file, sha: blobSha(bytes), content: bytes.toString('utf8') });
            }
            if (url.pathname === `${prefix}/files` && request.method === 'POST') {
              const { ref, paths } = await body(request);
              if (ref !== current.head) return send(response, 409, { error: 'The local files changed. Reload the editor.' });
              if (!Array.isArray(paths) || paths.some(file => !content.contentPath(file, true))) return send(response, 400, { error: 'Not editable content files.' });
              const files = [];
              for (const file of paths) { const bytes = await fs.readFile(path.join(root, file)); files.push({ path: file, sha: blobSha(bytes), content: bytes.toString('utf8') }); }
              return send(response, 200, { files });
            }
            if (url.pathname === `${prefix}/unused-media` && request.method === 'GET') {
              const previews = content.previewRegistry(await fs.readFile(path.join(root, content.registryPath), 'utf8'));
              const texts = [];
              for (const file of current.files) if (file.path !== content.registryPath) texts.push(await fs.readFile(path.join(root, file.path), 'utf8'));
              const used = await mediaInUse(root, texts);
              return send(response, 200, { head: current.head, media: Object.entries(previews).filter(([mediaUrl]) => !used.has(mediaUrl)).map(([mediaUrl, entry]) => ({ url: mediaUrl, entry })) });
            }
            if (url.pathname === `${prefix}/publish` && request.method === 'POST') {
              const payload = await content.publishPayload(await body(request));
              if (payload.baseCommit !== current.head) return send(response, 409, { error: 'The local files changed since this draft was loaded. Update and review your draft.' });
              const registryFile = path.join(root, content.registryPath);
              const previews = content.previewRegistry(await fs.readFile(registryFile, 'utf8'));
              for (const upload of payload.media) previews[upload.path.slice(6)] = upload.entry;
              const files = new Map();
              const deletions = new Set(payload.deletions ?? []);
              const removedMedia = [...deletions].filter(file => file.startsWith('public/media/'));
              for (const file of removedMedia) delete previews[file.slice(6)];
              for (const file of current.files) {
                if (file.path === content.registryPath || deletions.has(file.path)) continue;
                files.set(file.path, await fs.readFile(path.join(root, file.path), 'utf8'));
              }
              for (const change of payload.changes) files.set(change.path, change.content);
              if (removedMedia.length) {
                const used = await mediaInUse(root, [...files.values()]);
                const blocked = removedMedia.find(file => used.has(file.slice(6)));
                if (blocked) return send(response, 400, { error: `${blocked.slice(13)} is still used, so it cannot be deleted.` });
              }
              const uploads = new Set(payload.media.map(upload => upload.path));
              const exists = async candidate => uploads.has(candidate) || (!deletions.has(candidate) && await fs.access(path.join(root, candidate)).then(() => true, () => false));
              const known = new Set();
              for (const candidate of [...Object.keys(previews).map(url => `public${url}`), 'public/avatar.webp', 'public/favicon.png', 'public/social-card.png', 'public/followit-logo.svg']) {
                if (await exists(candidate)) known.add(candidate);
              }
              content.validateContent(files, previews, candidate => known.has(candidate), siteOrigin);
              for (const upload of payload.media) await fs.writeFile(path.join(root, upload.path), Buffer.from(upload.content, 'base64'));
              if (payload.media.length || removedMedia.length) {
                const sorted = Object.fromEntries(Object.entries(previews).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
                await fs.writeFile(registryFile, `${JSON.stringify({ files: sorted }, null, 2)}\n`);
              }
              for (const change of payload.changes) {
                await fs.mkdir(path.dirname(path.join(root, change.path)), { recursive: true });
                await fs.writeFile(path.join(root, change.path), change.content);
              }
              for (const file of deletions) await fs.rm(path.join(root, file));
              const next = await snapshot(root, content.contentPath);
              return send(response, 200, { commit: next.head, htmlUrl: `https://github.com/${repository}/commit/${next.head}` });
            }
            return send(response, 404, { error: 'Unknown local editor endpoint.' });
          } catch (error) {
            return send(response, error?.status ?? 400, { error: error instanceof Error ? error.message : 'The local editor request failed.' });
          }
        });
      },
    },
  };
}
