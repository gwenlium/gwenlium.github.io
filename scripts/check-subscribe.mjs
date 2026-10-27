import assert from 'node:assert/strict';
import fs from 'node:fs';
import { load } from 'cheerio';
import { brevoFormUrl, subscriptionsEnabled } from '../src/lib/newsletter.mjs';
import { policy } from './apply-csp.mjs';

const exampleForm = 'https://newsletter-check.sibforms.com/serve/MUIF-test-form';
assert.equal(brevoFormUrl(exampleForm), exampleForm);
assert.equal(brevoFormUrl(`${exampleForm}==`), `${exampleForm}==`);
assert.equal(brevoFormUrl(exampleForm.replace('/serve/', '/v2/serve/')), exampleForm.replace('/serve/', '/v2/serve/'));
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
assert(allowed.includes('frame-src https://www.youtube-nocookie.com https://player.vimeo.com;'));
assert(!policy(new Set()).includes('sibforms.com'));
assert(!allowed.includes('follow.it'));
assert(allowed.includes("form-action 'self' https://newsletter-check.sibforms.com"));
assert(allowed.split(';').find(part => part.trim().startsWith('connect-src ')).includes('https://newsletter-check.sibforms.com'));

const site = JSON.parse(fs.readFileSync('src/content/site.json', 'utf8'));
const windows = JSON.parse(fs.readFileSync('src/content/windows.json', 'utf8')).windows;
const emailWindow = windows.find(window => window.id === 'subscribe-email');
const enabled = subscriptionsEnabled(windows);
assert.equal(subscriptionsEnabled([{ page: 'subscribe', enabled: false }, { page: 'home', enabled: true }]), false);
assert.equal(subscriptionsEnabled([{ page: 'subscribe', enabled: true }]), true);
const $ = load(fs.readFileSync('dist/subscribe/index.html', 'utf8'));
assert.equal($('[data-followit-form], [name="follow.it-verification-code"]').length, 0);
const url = brevoFormUrl(site.newsletterUrl);
assert.equal($('iframe[data-brevo-form]').length, 0, 'Signup must use the site UI, not a provider iframe.');
const forms = $('form[data-brevo-form]');
if (url && enabled) {
  if (emailWindow?.enabled && emailWindow.content === 'default') assert(forms.length > 0);
  for (const element of forms.toArray()) {
    const form = $(element);
    assert.equal(form.attr('action'), url);
    assert.equal(form.attr('method'), 'post');
    assert.equal($(`[id="${form.attr('aria-describedby')}"]`).length, 1);
    const email = form.find('input[name="EMAIL"]');
    assert.equal(email.attr('type'), 'email');
    assert.equal(email.attr('autocomplete'), 'email');
    assert(email.is('[required]'));
    assert.equal(form.find(`label[for="${email.attr('id')}"]`).length, 1);
    assert(form.find('button.button[type="submit"]').text().includes('Subscribe'));
    assert.equal(form.find('[data-subscribe-status][role="status"][aria-live="polite"]').length, 1);
    assert.equal(form.find('input[name="email_address_check"][tabindex="-1"]').length, 1);
    assert.equal(form.find('input[name="locale"]').val(), 'en');
    assert(form.parent().find('a[data-astro-reload]').toArray().some(link => $(link).attr('href') === url));
  }
  const csp = $('meta[http-equiv="Content-Security-Policy"]').attr('content');
  for (const directive of ['form-action ', 'connect-src ']) {
    const origins = csp.split(';').find(part => part.trim().startsWith(directive)).trim().split(/\s+/).slice(1);
    assert(origins.includes(new URL(url).origin));
    assert(!origins.includes('*'));
  }
} else {
  assert.equal(forms.length, 0, 'Unconfigured signup must not show a broken form.');
  if (emailWindow?.enabled && emailWindow.content === 'default') {
    assert($('[data-newsletter]').text().includes('Email signup is currently unavailable'));
    assert($('[data-newsletter] a[href="/rss.xml"]').length);
  }
}
if (!enabled) {
  assert($('meta[http-equiv="refresh"]').attr('content')?.includes('url=/'), 'The disabled page must redirect home.');
  for (const path of fs.readdirSync('dist', { recursive: true }).filter(path => path.endsWith('.html'))) {
    const page = load(fs.readFileSync(`dist/${path}`, 'utf8'));
    assert.equal(page('form[data-brevo-form]').length, 0, `${path} must not expose email signup`);
    assert.equal(page('.footer-navigation a[href="/subscribe/"], .start-pages a[href="/subscribe/"]').length, 0);
    assert(!page('meta[http-equiv="Content-Security-Policy"]').attr('content').includes('sibforms.com'));
  }
  const search = JSON.parse(fs.readFileSync('dist/search-index.json', 'utf8'));
  assert(!search.entries.some(entry => entry.url === '/subscribe/' || entry.url.startsWith('/subscribe/#')));
  const sitemaps = fs.readdirSync('dist').filter(path => /^sitemap.*\.xml$/.test(path));
  for (const path of sitemaps) assert(!fs.readFileSync(`dist/${path}`, 'utf8').includes('https://gwenlium.dev/subscribe/'));
}
console.log('Site-styled Brevo form, accessible feedback, exact-origin CSP, safe URLs, direct fallback and disabled signup verified.');
