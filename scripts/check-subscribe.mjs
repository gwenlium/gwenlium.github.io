import assert from 'node:assert/strict';
import fs from 'node:fs';
import { load } from 'cheerio';
import { brevoFormUrl, brevoEmbedUrl } from '../src/lib/newsletter.mjs';
import { policy } from './apply-csp.mjs';

const exampleForm = 'https://newsletter-check.sibforms.com/serve/MUIF-test-form';
assert.equal(brevoFormUrl(exampleForm), exampleForm);
assert.equal(brevoFormUrl(`${exampleForm}==`), `${exampleForm}==`);
assert.equal(brevoEmbedUrl(`${exampleForm}==`), exampleForm.replace('/serve/', '/v2/serve/') + '==');
assert.equal(brevoEmbedUrl(brevoEmbedUrl(exampleForm)), brevoEmbedUrl(exampleForm));
assert.equal(brevoFormUrl(''), '');
assert.equal(brevoFormUrl(undefined), '');
for (const value of [
  null, 42, '/subscribe/', 'javascript:alert(1)',
  'http://newsletter-check.sibforms.com/serve/MUIF-test-form',
  'https://newsletter-check.sibforms.com.attacker.test/serve/MUIF-test-form',
  'https://attacker.test/sibforms.com/serve/MUIF-test-form',
  'https://name:password@newsletter-check.sibforms.com/serve/MUIF-test-form',
  'https://newsletter-check.sibforms.com:8443/serve/MUIF-test-form',
  'https://newsletter-check.sibforms.com/forms/end-form/build/main.js',
  `${exampleForm}?redirect=https://attacker.test`, `${exampleForm}#fragment`,
]) assert.throws(() => brevoFormUrl(value));
const allowed = policy(new Set(), exampleForm);
assert(allowed.includes('frame-src https://www.youtube-nocookie.com https://player.vimeo.com https://newsletter-check.sibforms.com;'));
assert(!policy(new Set()).includes('sibforms.com'));
assert(!allowed.includes('follow.it'));
assert(allowed.includes("form-action 'self'"));

const site = JSON.parse(fs.readFileSync('src/content/site.json', 'utf8'));
const windows = JSON.parse(fs.readFileSync('src/content/windows.json', 'utf8')).windows;
const emailWindow = windows.find(window => window.id === 'subscribe-email');
const $ = load(fs.readFileSync('dist/subscribe/index.html', 'utf8'));
assert.equal($('[data-followit-form], [name="follow.it-verification-code"]').length, 0);
const url = brevoFormUrl(site.newsletterUrl);
const frames = $('iframe[data-brevo-form]');
if (url) {
  if (emailWindow?.enabled && emailWindow.content === 'default') assert(frames.length > 0);
  for (const element of frames.toArray()) {
    const frame = $(element);
    assert.equal(frame.attr('src'), brevoEmbedUrl(url));
    assert(frame.attr('title'));
    assert.equal(frame.attr('loading'), 'lazy');
    assert.equal(frame.attr('referrerpolicy'), 'no-referrer');
    assert.equal($(`[id="${frame.attr('aria-describedby')}"]`).length, 1);
    assert(frame.parent().find('a[data-astro-reload]').toArray().some(link => $(link).attr('href') === url));
  }
  const csp = $('meta[http-equiv="Content-Security-Policy"]').attr('content');
  const origins = csp.split(';').find(part => part.trim().startsWith('frame-src ')).trim().split(/\s+/).slice(1);
  assert(origins.includes(new URL(url).origin));
  assert(!origins.includes('*'));
} else {
  assert.equal(frames.length, 0, 'Unconfigured signup must not show a broken form.');
  if (emailWindow?.enabled && emailWindow.content === 'default') {
    assert($('[data-newsletter]').text().includes('Email signup is currently unavailable'));
    assert($('[data-newsletter] a[href="/rss.xml"]').length);
  }
}
console.log('Brevo embed, exact-origin CSP, safe URL validation, direct signup fallback and disabled signup verified.');
