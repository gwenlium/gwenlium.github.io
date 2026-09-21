import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { load } from 'cheerio';
import { normalizeTopics, topicOptions, matchesTopics } from '../src/lib/topics.mjs';
assert.deepEqual(normalizeTopics([' Portraits ', 'portraits', '', 'Nature']), ['portraits', 'Nature']);
assert.deepEqual(normalizeTopics(undefined), []);
assert.equal(matchesTopics(['Portraits'], 'portraits', 'image', 'all'), true);
assert.equal(matchesTopics(['Portraits'], 'portraits', 'video', 'image'), false);
assert.equal(matchesTopics([], '', 'audio', 'all'), true);
assert.equal(matchesTopics([], 'piano', 'audio', 'all'), false);
assert.deepEqual(topicOptions([{ topics: ['Piano', 'Ambient'] }, { topics: ['Piano'] }]), ['Ambient', 'Piano']);
const paths = ['src/content/gallery.json', 'src/content/music.json', 'src/content/windows.json'];
const original = new Map(paths.map(path => [path, fs.readFileSync(path, 'utf8')]));
try {
  const files = Object.entries(JSON.parse(fs.readFileSync('src/content/media-previews.json')).files);
  const image = files.find(([, value]) => value.kind === 'image')?.[0];
  const audio = files.find(([, value]) => value.kind === 'audio')?.[0];
  assert(image && audio, 'Media fixtures need one registered image and audio file.');
  const gallery = JSON.parse(original.get(paths[0]));
  const description = 'A quiet portrait study.\n\nDrawn by a close friend.';
  gallery.items.push({ id: `topic-test-${process.pid}`, title: 'Topic test picture', type: 'image', src: image, alt: 'Test picture', caption: description, poster: '', topics: ['Portraits', 'Nature'] });
  const music = JSON.parse(original.get(paths[1]));
  music.tracks.push({ id: `topic-test-${process.pid}`, title: 'Topic test track', src: audio, cover: '', coverAlt: '', topics: ['Piano', 'Ambient'] });
  const windows = JSON.parse(original.get(paths[2]));
  for (const window of windows.windows) if (['gallery-content', 'music-catalogue'].includes(window.id)) { window.enabled = true; window.content = 'default'; }
  for (const [i, data] of [gallery, music, windows].entries()) fs.writeFileSync(paths[i], JSON.stringify(data));
  execFileSync('npm', ['run', 'build'], { stdio: 'pipe' });
  for (const [page, topic] of [['gallery', 'Portraits'], ['music', 'Piano']]) {
    const $ = load(fs.readFileSync(`dist/${page}/index.html`, 'utf8'));
    assert($(`[data-topic-select] option[value="${topic.toLowerCase()}"]`).length);
    assert($(`[data-topic-pick="${topic}"]`).length);
    assert($('[data-item-topics]').toArray().some(element => JSON.parse($(element).attr('data-item-topics')).includes(topic)));
  }
  const galleryPage = load(fs.readFileSync('dist/gallery/index.html', 'utf8'));
  assert.equal(galleryPage(`#work-topic-test-${process.pid} figcaption`).text(), description);
  assert.equal(galleryPage(`#work-topic-test-${process.pid} img`).attr('alt'), 'Test picture');
  const search = fs.readFileSync('dist/search-index.json', 'utf8');
  assert(search.includes('Portraits') && search.includes('Piano'));
  console.log('Gallery and music topics verified in filters, item labels, search, and combined type matching.');
} finally {
  for (const [path, content] of original) fs.writeFileSync(path, content);
}
