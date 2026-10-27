import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { brevoFormUrl } from '../src/lib/newsletter.mjs';

const source = ts.transpileModule(fs.readFileSync('src/scripts/subscribe.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replace(/^import .*;\n/m, '').replace(/^export \{\};?$/m, '');

function client(fetch) {
  const button = { disabled: false, textContent: 'Subscribe' };
  const status = { dataset: {}, textContent: '' };
  const events = {};
  const attributes = {};
  let resets = 0;
  let timeout;
  const form = {
    action: 'https://signup.sibforms.com/serve/public-token==', dataset: {},
    querySelector: (selector) => selector.startsWith('button') ? button : status,
    addEventListener: (name, handler) => { assert(!events[name], 'Must bind each form only once'); events[name] = handler; },
    reportValidity: () => true,
    setAttribute: (name, value) => { attributes[name] = value; },
    removeAttribute: (name) => { delete attributes[name]; },
    reset: () => { resets++; },
  };
  const documentEvents = {};
  vm.runInNewContext(source, {
    brevoFormUrl, fetch, URL, AbortController,
    FormData: class { constructor(value) { assert.equal(value, form); } },
    document: { querySelectorAll: () => [form], addEventListener: (name, handler) => { documentEvents[name] = handler; } },
    window: { setTimeout: (fn) => { timeout = fn; return 1; }, clearTimeout: () => { timeout = undefined; } },
  });
  documentEvents['astro:page-load']();
  return { button, status, attributes, resets: () => resets, expire: () => timeout(), submit: () => events.submit({ preventDefault() {} }) };
}

let calls = 0;
let finish;
const success = client((url, options) => {
  calls++;
  assert.equal(url.href, 'https://signup.sibforms.com/serve/public-token==?isAjax=1');
  assert.equal(options.method, 'POST');
  assert.equal(options.credentials, 'omit');
  assert.equal(options.referrerPolicy, 'no-referrer');
  return new Promise(resolve => { finish = () => resolve({ ok: true, json: async () => ({ success: true }) }); });
});
const pending = success.submit();
assert(success.button.disabled);
assert.equal(success.attributes['aria-busy'], 'true');
await success.submit();
assert.equal(calls, 1, 'Double clicks must not send duplicate requests');
finish();
await pending;
assert.equal(success.status.dataset.state, 'success');
assert.match(success.status.textContent, /Check your inbox.*confirmation/);
assert.equal(success.resets(), 1);

for (const result of [
  { ok: false, json: async () => ({ success: false, errors: { EMAIL: '<script>untrusted</script>' } }) },
  { ok: true, json: async () => ({ success: false }) },
  { ok: true, json: async () => ({}) },
  { ok: true, json: async () => { throw new Error('Invalid JSON'); } },
]) {
  const failed = client(async () => result);
  await failed.submit();
  assert.equal(failed.status.dataset.state, 'error');
  assert(!failed.status.textContent.includes('<script>'));
  assert.equal(failed.resets(), 0, 'Failures must preserve the entered address');
  assert.equal(failed.button.disabled, false);
  assert.equal(failed.attributes['aria-busy'], undefined);
}
for (const timeout of [false, true]) {
  const failed = client((_url, { signal }) => new Promise((_resolve, reject) => {
    if (!timeout) reject(new Error('Network unavailable'));
    else signal.addEventListener('abort', () => reject(new Error('Timed out')));
  }));
  const pending = failed.submit();
  if (timeout) failed.expire();
  await pending;
  assert.equal(failed.status.dataset.state, 'error');
  assert.match(failed.status.textContent, /direct signup link/);
  assert.equal(failed.button.disabled, false);
  assert.equal(failed.resets(), 0);
}
console.log('Signup success, rejected addresses, malformed replies, offline/timeout recovery and duplicate-submit protection verified.');
