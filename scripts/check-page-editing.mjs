import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { load } from 'cheerio';
import { entrySectionIds } from '../src/lib/entry-sections.mjs';

// Exercise every page's editable fields through a real build, restoring content afterwards.
const pages = [
  { name: 'site', file: 'src/content/site.json' },
  ...fs.readdirSync('src/content/pages').filter(name => name.endsWith('.json')).map(name => ({ name: name.slice(0, -5), file: `src/content/pages/${name}` })),
];
const expected = ['site', 'about', 'devlog', 'life', 'gallery', 'music', 'subscribe', 'not-found'];
assert.deepEqual(pages.map(page => page.name).sort(), expected.sort());
const originals = new Map();
const fixtureSlug = `cms-photo-check-${process.pid}`;
const fixturePost = `src/content/posts/${fixtureSlug}.md`;
const entryFixtures = entrySectionIds.map(section => ({ section, slug: `cms-entry-${section}-${process.pid}`, date: '2020-01-01', draft: false, publishAt: '' }));
entryFixtures.push({ section: 'music', slug: `cms-music-newer-${process.pid}`, date: '2020-02-01', draft: false, publishAt: '' });
const excludedFixtures = [
  { section: 'music', slug: `cms-hidden-${process.pid}`, date: '2020-01-01', draft: true, publishAt: '' },
  { section: 'about', slug: `cms-future-${process.pid}`, date: '2099-01-01', draft: false, publishAt: '' },
  { section: 'subscribe', slug: `cms-scheduled-${process.pid}`, date: '2020-01-01', draft: false, publishAt: '2099-01-01T00:00:00Z' },
];
const createdEntries = [];
const registry = JSON.parse(fs.readFileSync('src/content/media-previews.json', 'utf8'));
const photo = Object.entries(registry.files).find(([, entry]) => entry.kind === 'image')?.[0];
const audio = Object.entries(registry.files).find(([, entry]) => entry.kind === 'audio')?.[0];
try {
  const windowsFile = 'src/content/windows.json';
  const windowsRaw = fs.readFileSync(windowsFile, 'utf8');
  originals.set(windowsFile, windowsRaw);
  const windows = JSON.parse(windowsRaw);
  for (const window of windows.windows) {
    if (['home-intro', 'about-bio', 'post-entry', 'post-media', 'subscribe-rss', 'not-found'].includes(window.id)
      || entrySectionIds.some(section => window.id === `${section}-entries` || window.id === `${section}-search`)) {
      window.enabled = true;
      window.content = 'default';
    }
  }
  fs.writeFileSync(windowsFile, `${JSON.stringify(windows, null, 2)}\n`);
  for (const page of pages) {
    const raw = fs.readFileSync(page.file, 'utf8');
    originals.set(page.file, raw);
    const data = JSON.parse(raw);
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
    assert(!fs.existsSync(fixturePost));
    fs.writeFileSync(fixturePost, `---\ntitle: CMS photo test\npermalink: ${fixtureSlug}\nsection: devlog\ndraft: false\ndate: 2020-01-01\nphotos:\n  - ${photo}\n  - ${photo}\n---\nGallery test.\n`);
  }
  for (const fixture of [...entryFixtures, ...excludedFixtures]) {
    const filename = `src/content/posts/${fixture.slug}.md`;
    assert(!fs.existsSync(filename));
    const media = fixture.section === 'music' && audio ? `media:\n  - type: audio\n    src: ${audio}\n    alt: CMS audio entry\n` : '';
    fs.writeFileSync(filename, `---\ntitle: CMS ${fixture.section} entry\npermalink: ${fixture.slug}\nsection: ${fixture.section}\ndraft: ${fixture.draft}\ndate: ${fixture.date}\n${fixture.publishAt ? `publishAt: ${fixture.publishAt}\n` : ''}${media}---\nCMS shared entry ${fixture.slug}.\n`);
    createdEntries.push(filename);
  }
  // Node cannot execute Windows' npm.cmd directly; reuse the invoking npm CLI.
  const npmCli = process.env.npm_execpath;
  execFileSync(npmCli ? process.execPath : 'npm', npmCli ? [npmCli, 'run', 'build'] : ['run', 'build'], { stdio: 'pipe' });
  if (photo) {
    const post = load(fs.readFileSync(`dist/devlog/${fixtureSlug}/index.html`, 'utf8'));
    assert.equal(post('#post-media img').length, 2);
    assert.equal(post('#post-entry img').length, 0, 'Entry gallery pictures belong in the companion window, not the text window');
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
  const search = JSON.parse(fs.readFileSync('dist/search-index.json', 'utf8')).entries;
  const feed = load(fs.readFileSync('dist/rss.xml', 'utf8'), { xmlMode: true });
  for (const fixture of entryFixtures) {
    // Home has a dedicated detail namespace; journal URLs remain unchanged.
    const url = `/${fixture.section === 'home' ? 'entries' : fixture.section}/${fixture.slug}/`;
    const index = fixture.section === 'home' ? 'dist/index.html' : `dist/${fixture.section}/index.html`;
    const listing = load(fs.readFileSync(index, 'utf8'));
    assert(listing(`a[href="${url}"]`).length, `${fixture.section} must show its published entry`);
    const entry = load(fs.readFileSync(`dist${url}index.html`, 'utf8'));
    assert.equal(new URL(entry('link[rel=canonical]').attr('href')).pathname, url);
    assert(entry('.entry-body').text().includes(`CMS shared entry ${fixture.slug}.`));
    assert.equal(entry('[data-preview-back-link]').attr('href'), fixture.section === 'home' ? '/' : `/${fixture.section}/`);
    assert(search.some(item => item.kind === 'post' && item.url === url), `${fixture.section} entry must be searchable`);
    assert(feed('item > link').toArray().some(element => new URL(feed(element).text()).pathname === url), `${fixture.section} entry must be in RSS`);
    if (fixture.section === 'music' && audio) assert.equal(entry('#post-media audio').attr('src'), audio);
  }
  const music = entryFixtures.find(fixture => fixture.section === 'music');
  const newerMusic = entryFixtures.at(-1);
  const musicPage = load(fs.readFileSync(`dist/music/${music.slug}/index.html`, 'utf8'));
  assert.equal(musicPage('a[rel=next]').attr('href'), `/music/${newerMusic.slug}/`);
  assert.equal(musicPage('a[rel=prev]').length, 0, 'Another destination must not become an older Music entry');
  for (const fixture of excludedFixtures) {
    assert(!fs.existsSync(`dist/${fixture.section}/${fixture.slug}/index.html`));
    assert(!search.some(item => item.url.includes(fixture.slug)));
    assert(!feed('item').toArray().some(element => feed(element).text().includes(fixture.slug)));
    assert(!fs.readFileSync(`dist/${fixture.section}/index.html`, 'utf8').includes(fixture.slug));
  }
  console.log('All seven entry destinations verified: index/detail routes, same-section navigation, RSS/search, and hidden/scheduled exclusion.');
  console.log('Page editing verified for all 8 page entries, including rich About content, photo galleries and links.');
} finally {
  for (const filename of createdEntries) if (fs.existsSync(filename)) fs.unlinkSync(filename);
  if (photo && fs.existsSync(fixturePost)) fs.unlinkSync(fixturePost);
  for (const [file, raw] of originals) fs.writeFileSync(file, raw);
}
