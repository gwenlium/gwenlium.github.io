import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { load } from 'cheerio';
import { applyMaintenance } from './apply-maintenance.mjs';

async function fixture(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gwenlium-maintenance-'));
  const files = {
    'index.html': '<main>Homepage draft</main>',
    'gallery/index.html': '<main>Gallery draft</main>',
    'devlog/post/index.html': '<main>Post draft</main>',
    '404.html': '<main>Old error page</main>',
    'admin/index.html': '<main>Editor and login</main>',
    'write/index.html': '<main>Writing desk</main>',
    '_astro/client.js': 'client script',
    'media/photo.webp': 'uploaded media',
    'rss.xml': '<rss><channel><item>Post draft</item></channel></rss>',
    'search-index.json': '{"entries":[{"text":"Post draft"}]}',
    'sitemap-0.xml': '<urlset><url>Post draft URL</url></urlset>',
    'sitemap-index.xml': '<sitemapindex><sitemap>Post draft URL</sitemap></sitemapindex>',
  };
  try {
    for (const [name, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(directory, name)), { recursive: true });
      await fs.writeFile(path.join(directory, name), content);
    }
    await run(directory, files);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('disabled maintenance leaves the generated website unchanged', async () => {
  await fixture(async (directory, files) => {
    assert.deepEqual(await applyMaintenance(directory, { maintenanceEnabled: false }), { enabled: false, pages: 0 });
    for (const [name, content] of Object.entries(files)) {
      assert.equal(await fs.readFile(path.join(directory, name), 'utf8'), content);
    }
  });
});

test('maintenance replaces deep links and feeds without blocking the editor or assets', async () => {
  await fixture(async (directory, files) => {
    const message = 'Back soon <script>alert("test")</script> & thank you.';
    assert.deepEqual(await applyMaintenance(directory, {
      maintenanceEnabled: true,
      name: 'Gwenlium & friends',
      maintenanceHeading: '<Work in progress>',
      maintenanceMessage: message,
    }), { enabled: true, pages: 4 });
    for (const name of ['index.html', 'gallery/index.html', 'devlog/post/index.html', '404.html']) {
      const html = await fs.readFile(path.join(directory, name), 'utf8');
      const $ = load(html);
      assert.equal($('[data-maintenance-page]').length, 1);
      assert.equal($('h1').text(), '<Work in progress>');
      assert.equal($('.message').text(), message);
      assert.equal($('script').length, 0);
      assert.equal($('meta[name="robots"]').attr('content'), 'noindex, nofollow');
      assert(!html.includes('draft'));
    }
    for (const name of ['admin/index.html', 'write/index.html', '_astro/client.js', 'media/photo.webp']) {
      assert.equal(await fs.readFile(path.join(directory, name), 'utf8'), files[name]);
    }
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'search-index.json'), 'utf8')), { entries: [] });
    const rss = load(await fs.readFile(path.join(directory, 'rss.xml'), 'utf8'), { xmlMode: true });
    assert.equal(rss('channel').length, 1);
    assert.equal(rss('item').length, 0);
    assert.equal(rss('title').text(), 'Gwenlium & friends');
    for (const name of ['sitemap-index.xml', 'sitemap-0.xml']) {
      assert(!(await fs.readFile(path.join(directory, name), 'utf8')).includes('draft'));
    }
  });
});

test('blank notice settings use readable defaults', async () => {
  await fixture(async directory => {
    await applyMaintenance(directory, { maintenanceEnabled: true, maintenanceHeading: ' ', maintenanceMessage: '' });
    const $ = load(await fs.readFile(path.join(directory, 'index.html'), 'utf8'));
    assert.equal($('h1').text(), 'A little maintenance');
    assert($('.message').text().includes('check back soon'));
  });
});
