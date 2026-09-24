import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const escape = (value) => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

export async function applyMaintenance(directory, settings) {
  if (settings.maintenanceEnabled !== true) return { enabled: false, pages: 0 };
  const name = escape(settings.name || 'Gwenlium');
  const heading = escape(settings.maintenanceHeading?.trim() || 'A little maintenance');
  const message = escape(settings.maintenanceMessage?.trim() || "I'm updating the website. Please check back soon!");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>Under maintenance - ${name}</title>
<link rel="icon" href="/favicon.png">
<style>
@font-face{font-family:Departure;src:url('/fonts/DepartureMono-Regular.woff2') format('woff2');font-display:swap}
*{box-sizing:border-box}
body{margin:0;min-height:100svh;display:grid;place-items:center;padding:1.5rem;background:#eeeae1;color:#30372f;font-family:Departure,monospace;background-image:radial-gradient(#aab2a5 1px,transparent 1px);background-size:20px 20px}
main{width:min(100%,36rem);padding:3px;border:1px solid #687462;background:#faf8f0;box-shadow:inset 1px 1px #fff,5px 5px 0 #30372f24}
.titlebar{padding:.6rem .8rem;border:1px solid #687462;background:#c6d2b9;font-size:.75rem;overflow-wrap:anywhere}
.content{padding:clamp(1.5rem,6vw,3rem)}
.status{font-size:.7rem;text-transform:uppercase;letter-spacing:.08em}
h1{font-size:clamp(1.4rem,5vw,2rem);line-height:1.4;overflow-wrap:anywhere}
.message{font-family:system-ui,sans-serif;font-size:1rem;line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere}
a{display:inline-block;margin-top:1rem;padding:.7rem 1rem;border:1px solid currentColor;background:#c6d2b9;color:inherit;font-size:.75rem;text-decoration:none}
a:focus-visible{outline:3px solid currentColor;outline-offset:4px}
@media(prefers-color-scheme:dark){body{background-color:#20261f;color:#e9eee5;background-image:radial-gradient(#414b3c 1px,transparent 1px)}main{background:#2b3228;box-shadow:inset 1px 1px #56614e,5px 5px 0 #0004}.titlebar,a{background:#414f37}}
</style>
</head>
<body><main data-maintenance-page><div class="titlebar">${name}</div><div class="content"><p class="status">Under maintenance</p><h1>${heading}</h1><p class="message">${message}</p><a href="/">Check again</a></div></main></body>
</html>
`;
  let pages = 0;
  async function replacePages(folder) {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const target = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        // The owner's editor stays reachable so maintenance can be switched off again.
        if (folder === directory && (entry.name === 'admin' || entry.name === 'write')) continue;
        await replacePages(target);
      } else if (entry.isFile() && entry.name.endsWith('.html')) {
        await fs.writeFile(target, html);
        pages++;
      }
    }
  }
  await replacePages(directory);
  if (!pages) throw new Error('Maintenance mode requires a built website with public HTML pages.');
  await fs.writeFile(path.join(directory, 'search-index.json'), JSON.stringify({ entries: [] }));
  await fs.writeFile(path.join(directory, 'rss.xml'), `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${name}</title><link>https://gwenlium.dev/</link><description>Under maintenance. Please check back soon.</description></channel></rss>`);
  for (const file of await fs.readdir(directory)) {
    if (/^sitemap(?:-.*)?\.xml$/.test(file)) {
      const xml = file === 'sitemap-index.xml'
        ? '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"/>'
        : '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"/>';
      await fs.writeFile(path.join(directory, file), `<?xml version="1.0" encoding="UTF-8"?>${xml}`);
    }
  }
  return { enabled: true, pages };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const settings = JSON.parse(await fs.readFile(path.join(root, 'src/content/site.json'), 'utf8'));
  const result = await applyMaintenance(path.join(root, 'dist'), settings);
  console.log(result.enabled ? `Maintenance enabled: replaced ${result.pages} public pages; the editor remains available.` : 'Maintenance disabled: publishing the full website.');
}
