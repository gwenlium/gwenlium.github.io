import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * One Content-Security-Policy for every built page. GitHub Pages cannot send headers, so it is a
 * <meta> tag. It is identical on every page because in-site navigation keeps the first page's
 * policy: each page must allow every inline script of the site.
 */
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const executable = /^(?:|module|text\/javascript|application\/javascript)$/i;

async function htmlFiles(directory) {
  const found = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await htmlFiles(target));
    else if (entry.name.endsWith('.html')) found.push(target);
  }
  return found;
}

export function inlineScripts(html) {
  const scripts = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attributes = match[1];
    if (/\ssrc\s*=/i.test(attributes)) continue;
    const type = /\stype\s*=\s*["']?([^"'\s>]+)/i.exec(attributes)?.[1] ?? '';
    if (executable.test(type)) scripts.push(match[2]);
  }
  return scripts;
}

export function policy(hashes) {
  return [
    "default-src 'self'",
    // ffmpeg.wasm prepares video and audio in the editor; 'wasm-unsafe-eval' allows WebAssembly only, not JS eval.
    `script-src 'self' 'wasm-unsafe-eval' https://static.cloudflareinsights.com ${[...hashes].sort().map(hash => `'${hash}'`).join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    // raw.githubusercontent.com shows pictures published minutes ago, before the site rebuilds.
    "img-src 'self' data: blob: https://raw.githubusercontent.com",
    "media-src 'self' blob:",
    "font-src 'self'",
    // api.github.com: the owner's browser uploads prepared media there directly when publishing.
    "connect-src 'self' https://gwenlium-cms-auth.gwenlium.workers.dev https://api.github.com https://cloudflareinsights.com",
    'frame-src https://www.youtube-nocookie.com https://player.vimeo.com',
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self' https://api.follow.it",
  ].join('; ');
}

export async function applyCsp(directory) {
  const files = await htmlFiles(directory);
  const pages = await Promise.all(files.map(async file => ({ file, html: await fs.readFile(file, 'utf8') })));
  const hashes = new Set();
  for (const { html } of pages) {
    for (const script of inlineScripts(html)) hashes.add(`sha256-${createHash('sha256').update(script, 'utf8').digest('base64')}`);
  }
  const meta = `<meta http-equiv="Content-Security-Policy" content="${policy(hashes).replace(/"/g, '&quot;')}">`;
  for (const page of pages) {
    if (page.html.includes('http-equiv="Content-Security-Policy"')) throw new Error(`${path.relative(directory, page.file)} already has a Content-Security-Policy.`);
    // Right after the charset (or the doctype on Astro's bare redirect pages): before the first script it governs.
    const anchor = /<meta charset="utf-8"\s*\/?>/i.exec(page.html) ?? /<!doctype html>/i.exec(page.html);
    if (!anchor) throw new Error(`${path.relative(directory, page.file)} has no <meta charset> or doctype to place the policy after.`);
    if (page.html.slice(0, anchor.index).includes('<script')) throw new Error(`${path.relative(directory, page.file)} runs a script before the policy.`);
    const at = anchor.index + anchor[0].length;
    await fs.writeFile(page.file, page.html.slice(0, at) + meta + page.html.slice(at));
  }
  return { pages: pages.length, hashes: hashes.size };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await applyCsp(path.join(root, 'dist'));
  console.log(`Content-Security-Policy added to ${result.pages} pages (${result.hashes} inline scripts allowed by hash).`);
}
