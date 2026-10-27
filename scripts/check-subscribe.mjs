import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { load } from 'cheerio';

const site = JSON.parse(fs.readFileSync('src/content/site.json', 'utf8'));
const $ = load(fs.readFileSync('dist/subscribe/index.html', 'utf8'));
const form = $('form[data-followit-form]');
assert.equal(form.length, 1);
assert.equal(form.attr('action'), site.newsletterFormAction);
assert.equal(form.attr('method'), 'post');
assert(form.is('[data-astro-reload]'), 'Provider POST must use browser navigation.');
assert.equal(form.find('input[name="email"][type="email"][required]').length, 1);
for (const id of form.find('input').attr('aria-describedby').split(' ')) assert.equal($(`[id="${id}"]`).length, 1);
assert.equal(form.find('[data-followit-status][role="status"][aria-live="polite"]').length, 1);
assert($('a[data-astro-reload]').toArray().some(link => $(link).attr('href') === site.newsletterUrl));
const directives = $('meta[http-equiv="Content-Security-Policy"]').attr('content').split(';').map(value => value.trim().split(/\s+/));
const destinations = directives.find(([name]) => name === 'form-action').slice(1);
// Both the initial POST and follow.it's real confirmation/validation redirect must be allowed.
assert(destinations.includes(new URL(site.newsletterFormAction).origin));
assert(destinations.includes('https://follow.it'));
assert(!destinations.includes('*'));

const documentListeners = new Map();
const windowListeners = new Map();
const status = { textContent: '' };
class Form {
  matches(selector) { return selector === '[data-followit-form]'; }
  querySelector() { return status; }
}
const sandbox = {
  HTMLFormElement: Form,
  document: { addEventListener: (name, listener) => documentListeners.set(name, listener), querySelectorAll: () => [status] },
  window: { addEventListener: (name, listener) => windowListeners.set(name, listener) },
};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/scripts/subscribe.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText, sandbox);
documentListeners.get('submit')({ target: new Form(), defaultPrevented: false });
assert(status.textContent.includes('Opening follow.it'));
assert(status.textContent.includes('confirmation email'));
windowListeners.get('pageshow')();
assert.equal(status.textContent, '');
documentListeners.get('submit')({ target: new Form(), defaultPrevented: true });
assert.equal(status.textContent, '');
documentListeners.get('submit')({ target: {}, defaultPrevented: false });
assert.equal(status.textContent, '');
documentListeners.get('submit')({ target: new Form(), defaultPrevented: false });
documentListeners.get('astro:page-load')();
assert.equal(status.textContent, '');
console.log('Subscription POST, provider redirects, email validation, accessible feedback, direct signup link and Back/navigation reset verified.');
