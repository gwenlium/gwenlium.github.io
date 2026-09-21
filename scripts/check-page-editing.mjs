import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import YAML from 'yaml';
import { load } from 'cheerio';

// Exercise the CMS file fields through a real build, restoring content afterwards.
const config = YAML.parse(fs.readFileSync('public/admin/config.yml', 'utf8'));
const pages = config.collections.find(collection => collection.name === 'pages').files;
const expected = ['site', 'about', 'devlog', 'life', 'gallery', 'music', 'subscribe', 'not-found'];
assert.deepEqual(pages.map(page => page.name).sort(), expected.sort());
const originals = new Map();
const registry = JSON.parse(fs.readFileSync('src/content/media-previews.json', 'utf8'));
const photo = Object.entries(registry.files).find(([, entry]) => entry.kind === 'image')?.[0];
try {
  for (const page of pages) {
    const raw = fs.readFileSync(page.file, 'utf8');
    originals.set(page.file, raw);
    const data = JSON.parse(raw);
    for (const key of Object.keys(data)) assert(page.fields.some(field => field.name === key), `${page.name}.${key} must be editable`);
    if (page.name === 'site') data.intro = 'CMS home introduction';
    else {
      data.title = `CMS ${page.name} heading`;
      data.eyebrow = `CMS ${page.name} eyebrow`;
      data.intro = `CMS ${page.name} introduction`;
    }
    if (page.name === 'about') {
      data.body = '**CMS biography first paragraph**\n\nCMS biography second paragraph';
      if (photo) {
        data.photos = [photo, photo];
        data.media = [{ type: 'image', src: photo, alt: 'CMS photo description', caption: 'CMS photo caption' }];
      }
      data.links = [{ label: 'CMS profile link', url: 'https://github.com/gwenlium' }];
    }
    if (page.name === 'subscribe') data.rssDescription = 'CMS RSS description';
    fs.writeFileSync(page.file, `${JSON.stringify(data, null, 2)}\n`);
  }
  if (photo) {
    const postFile = 'src/content/posts/opening.md';
    const raw = fs.readFileSync(postFile, 'utf8');
    originals.set(postFile, raw);
    fs.writeFileSync(postFile, raw.replace(/^---\n/, `---\nphotos:\n  - ${photo}\n  - ${photo}\n`));
  }
  execFileSync('npm', ['run', 'build'], { stdio: 'pipe' });
  if (photo) {
    const post = load(fs.readFileSync('dist/devlog/opening/index.html', 'utf8'));
    assert.equal(post('.entry-media img').length, 2);
    assert(fs.readFileSync('dist/rss.xml', 'utf8').includes(photo));
  }
  for (const page of pages) {
    const target = page.name === 'site' ? 'index.html' : page.name === 'not-found' ? '404.html' : `${page.name}/index.html`;
    const $ = load(fs.readFileSync(`dist/${target}`, 'utf8'));
    if (page.name === 'site') assert($('body').text().includes('CMS home introduction'));
    else {
      assert.equal($('h1').first().text(), `CMS ${page.name} heading`);
      assert($('body').text().includes(`CMS ${page.name} introduction`));
      assert($('body').text().includes(`CMS ${page.name} eyebrow`));
    }
    if (page.name === 'about') {
      assert.equal($('.about-body p').length, 2);
      assert.equal($('.about-body strong').text(), 'CMS biography first paragraph');
      if (photo) {
        assert.equal($('.about-media img').length, 3);
        assert.equal($('.about-media figcaption').text(), 'CMS photo caption');
      }
      assert.equal($('nav[aria-label="Profile links"] a').text(), 'CMS profile link');
    }
    if (page.name === 'subscribe') assert($('.option-description').text().includes('CMS RSS description'));
  }
  console.log('CMS editing verified for all 8 page entries, including rich About content, photo galleries and links.');
} finally {
  for (const [file, raw] of originals) fs.writeFileSync(file, raw);
}
