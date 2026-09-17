import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Miniflare } from 'miniflare';
import ts from 'typescript';

const source = await readFile(new URL('./src/worker.ts', import.meta.url), 'utf8');
const configText = await readFile(new URL('./wrangler.jsonc', import.meta.url), 'utf8');
const configuration = ts.parseConfigFileTextToJson('wrangler.jsonc', configText).config;
const script = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const token = 'ghu_' + 'a'.repeat(40);

function runtime(handler) {
  const values = {
    SITE_ORIGIN: 'https://site.test', AUTH_ORIGIN: 'https://auth.test',
    ALLOWED_USER_ID: '1', GITHUB_REPOSITORY_ID: '2',
    GITHUB_CLIENT_ID: 'test-client', GITHUB_CLIENT_SECRET: 'test-secret',
    OAUTH_STATE_SECRET: 'test-state-secret-with-at-least-thirty-two-characters',
  };
  return new Miniflare({ workers: [{
    config: {
      name: 'auth', type: 'worker', compatibilityDate: configuration.compatibility_date,
      manifest: { mainModule: 'worker.js', modules: { 'worker.js': { type: 'esm', contents: script } } },
      env: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { type: 'text', value }])),
    },
    dev: { outboundService: { type: 'fetcher', handler } },
  }] });
}

async function authorize(worker) {
  const start = await worker.dispatchFetch('https://auth.test/auth?provider=github&site_id=site.test', { redirect: 'manual' });
  assert.equal(start.status, 302);
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  return worker.dispatchFetch('https://auth.test/callback?code=test-code&state=' + state, {
    headers: { Cookie: start.headers.get('set-cookie').split(';')[0] },
  });
}

test('completes a browser-bound GitHub authorization inside the Workers runtime', async t => {
  const worker = runtime(request => {
    const path = new URL(request.url).pathname;
    if (path === '/login/oauth/access_token') return Response.json({ access_token: token, token_type: 'bearer', scope: '', expires_in: 28800 });
    if (path === '/user') return Response.json({ id: 1 });
    if (path === '/user/installations') return Response.json({ total_count: 1, installations: [{
      id: 3, account: { id: 1 }, repository_selection: 'selected', suspended_at: null,
      permissions: { contents: 'write', metadata: 'read' },
    }] });
    if (path === '/user/installations/3/repositories') return Response.json({ total_count: 1, repositories: [{ id: 2 }] });
    throw new Error('Unexpected upstream request');
  });
  t.after(() => worker.dispose());
  const response = await authorize(worker);
  assert.equal(response.status, 200);
  assert.ok((await response.text()).includes('authorization:github:success:'));
});

test('rejects upstream redirects without forwarding OAuth credentials', async t => {
  let contactedRedirect = false;
  const worker = runtime(request => {
    if (new URL(request.url).hostname === 'redirect.test') contactedRedirect = true;
    return new Response(null, { status: 302, headers: { Location: 'https://redirect.test/collect' } });
  });
  t.after(() => worker.dispose());
  const response = await authorize(worker);
  assert.equal(response.status, 502);
  assert.ok((await response.text()).includes('authorization:github:error:'));
  assert.equal(contactedRedirect, false);
});
