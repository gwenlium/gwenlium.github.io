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

function runtime(handler, extra = {}) {
  const values = {
    SITE_ORIGIN: 'https://site.test', AUTH_ORIGIN: 'https://auth.test',
    ALLOWED_USER_ID: '1', GITHUB_REPOSITORY_ID: '2',
    GITHUB_CLIENT_ID: 'test-client', GITHUB_CLIENT_SECRET: 'test-secret',
    OAUTH_STATE_SECRET: 'test-state-secret-with-at-least-thirty-two-characters',
    ...extra,
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

function analyticsUpstream(request) {
  const url = new URL(request.url);
  if (url.hostname === 'api.cloudflare.com') return Response.json({ data: { viewer: { accounts: [{
    totals: [{ count: 12, sum: { visits: 5 } }],
    daily: [{ count: 12, dimensions: { date: new Date().toISOString().slice(0, 10) } }],
    pages: [{ count: 12, dimensions: { requestPath: '/life/example/' } }],
    referrers: [{ count: 12, dimensions: { refererHost: '' } }],
  }] } } });
  if (url.pathname === '/user') return Response.json({ id: 1 });
  if (url.pathname === '/user/installations') return Response.json({ total_count: 1, installations: [{
    id: 3, account: { id: 1 }, repository_selection: 'selected', suspended_at: null,
    permissions: { contents: 'write', metadata: 'read' },
  }] });
  if (url.pathname === '/user/installations/3/repositories') return Response.json({ total_count: 1, repositories: [{ id: 2 }] });
  throw new Error('Unexpected upstream request');
}
const analyticsSettings = {
  CF_ANALYTICS_ACCOUNT_ID: 'a'.repeat(32), CF_ANALYTICS_SITE_TAG: 'b'.repeat(32),
  CF_ANALYTICS_API_TOKEN: 'server-only-test-secret',
};
const analyticsHeaders = { Origin: 'https://site.test', Authorization: `Bearer ${token}` };

test('analytics rejects unauthenticated and foreign-origin requests before contacting providers', async t => {
  let calls = 0;
  const worker = runtime(() => { calls++; throw new Error('No upstream requests expected'); }, analyticsSettings);
  t.after(() => worker.dispose());
  const noToken = await worker.dispatchFetch('https://auth.test/analytics', { headers: { Origin: 'https://site.test' } });
  assert.equal(noToken.status, 401);
  const otherOrigin = await worker.dispatchFetch('https://auth.test/analytics', { headers: { ...analyticsHeaders, Origin: 'https://other.test' } });
  assert.equal(otherOrigin.status, 403);
  assert.equal(otherOrigin.headers.get('access-control-allow-origin'), null);
  const badRange = await worker.dispatchFetch('https://auth.test/analytics?days=999', { headers: analyticsHeaders });
  assert.equal(badRange.status, 400);
  assert.equal(calls, 0);
});

test('analytics CORS only allows the editor GET with Authorization', async t => {
  const worker = runtime(() => { throw new Error('No upstream requests expected'); });
  t.after(() => worker.dispose());
  const response = await worker.dispatchFetch('https://auth.test/analytics', { method: 'OPTIONS', headers: {
    Origin: 'https://site.test', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization',
  } });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://site.test');
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
  const denied = await worker.dispatchFetch('https://auth.test/analytics', { method: 'OPTIONS', headers: {
    Origin: 'https://site.test', 'Access-Control-Request-Method': 'POST',
  } });
  assert.equal(denied.status, 403);
});

test('analytics denies another GitHub account without contacting Cloudflare', async t => {
  const worker = runtime(request => {
    assert.equal(new URL(request.url).hostname, 'api.github.com');
    return Response.json({ id: 999 });
  }, analyticsSettings);
  t.after(() => worker.dispose());
  const response = await worker.dispatchFetch('https://auth.test/analytics', { headers: analyticsHeaders });
  assert.equal(response.status, 403);
});

test('analytics distinguishes an unconnected service from genuine zero traffic', async t => {
  const worker = runtime(analyticsUpstream);
  t.after(() => worker.dispose());
  const response = await worker.dispatchFetch('https://auth.test/analytics', { headers: analyticsHeaders });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /not connected/);
});

test('analytics authenticates ownership, scopes the provider query and returns only aggregates', async t => {
  const hosts = [];
  const worker = runtime(async request => {
    hosts.push(new URL(request.url).hostname);
    if (new URL(request.url).hostname === 'api.cloudflare.com') {
      assert.equal(request.headers.get('authorization'), 'Bearer server-only-test-secret');
      const query = await request.json();
      assert.equal(query.variables.account, analyticsSettings.CF_ANALYTICS_ACCOUNT_ID);
      assert.equal(query.variables.site, analyticsSettings.CF_ANALYTICS_SITE_TAG);
      assert.equal(query.variables.host, 'site.test');
      assert.match(query.query, /requestHost: \$host/);
    } else assert.equal(request.headers.get('authorization'), `Bearer ${token}`);
    return analyticsUpstream(request);
  }, analyticsSettings);
  t.after(() => worker.dispose());
  const response = await worker.dispatchFetch('https://auth.test/analytics?days=7&account=attacker', { headers: analyticsHeaders });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://site.test');
  assert.match(response.headers.get('cache-control'), /no-store/);
  const raw = await response.text();
  assert.ok(!raw.includes(token));
  assert.ok(!raw.includes('server-only-test-secret'));
  const report = JSON.parse(raw);
  assert.equal(report.pageViews, 12);
  assert.equal(report.visits, 5);
  assert.equal(report.daily.length, 7);
  assert.deepEqual(report.pages, [{ label: '/life/example/', views: 12 }]);
  assert.deepEqual(report.referrers, [{ label: 'Direct / unknown', views: 12 }]);
  assert.equal(hosts.filter(host => host === 'api.github.com').length, 3);
});

test('analytics provider errors and redirects never become zero counts or leak credentials', async t => {
  let redirected = false;
  const worker = runtime(request => {
    const host = new URL(request.url).hostname;
    if (host === 'redirect.test') redirected = true;
    if (host === 'api.cloudflare.com') return new Response(null, { status: 302, headers: { Location: 'https://redirect.test/' } });
    return analyticsUpstream(request);
  }, analyticsSettings);
  t.after(() => worker.dispose());
  const response = await worker.dispatchFetch('https://auth.test/analytics', { headers: analyticsHeaders });
  assert.equal(response.status, 502);
  assert.equal(redirected, false);
  assert.equal((await response.json()).pageViews, undefined);
});
