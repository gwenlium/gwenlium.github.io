import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import test from 'node:test';
import { Miniflare } from 'miniflare';
import ts from 'typescript';

const configText = await readFile(new URL('./wrangler.jsonc', import.meta.url), 'utf8');
const configuration = ts.parseConfigFileTextToJson('wrangler.jsonc', configText).config;
const bundled = await build({
  entryPoints: [fileURLToPath(new URL('./src/worker.ts', import.meta.url))],
  bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022',
  conditions: ['workerd', 'worker'],
});
const script = bundled.outputFiles[0].text;
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
  CF_ANALYTICS_ACCOUNT_ID: 'a'.repeat(32),
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
      assert.equal(query.variables.site, undefined);
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

const editorHead = 'a'.repeat(40);
const editorTree = 'b'.repeat(40);
const publishedTree = 'c'.repeat(40);
const publishedCommit = 'd'.repeat(40);
const movedHead = 'e'.repeat(40);
const publishHeaders = { ...analyticsHeaders, 'Content-Type': 'application/json' };
const preparedImage = 'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA';
const preparedBytes = Buffer.from(preparedImage, 'base64');
const preparedDigest = createHash('sha256').update(preparedBytes).digest('hex');
const previousPreviewPath = `/media/existing-preview-${preparedDigest.slice(0, 32)}.webp`;
const previousPreviewEntry = { sha256: preparedDigest, kind: 'image', width: 1, height: 1 };

function editorFixture(options = {}) {
  const sources = new Map([
    ['src/content/site.json', JSON.stringify({ name: 'Before' })],
    ['src/content/gallery.json', JSON.stringify({ items: [] })],
    ['src/content/media-previews.json', JSON.stringify({ files: { [previousPreviewPath]: previousPreviewEntry } })],
    ['src/secret.ts', 'private source'],
  ]);
  const blobs = new Map();
  const entries = [];
  for (const [path, content] of sources) {
    const bytes = Buffer.from(content);
    const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    blobs.set(sha, { sha, size: bytes.length, encoding: 'base64', content: bytes.toString('base64') });
    entries.push({ path, sha, size: bytes.length, mode: '100644', type: 'blob' });
  }
  entries.push({ path: `public${previousPreviewPath}`, sha: createHash('sha1').update(`blob ${preparedBytes.length}\0`).update(preparedBytes).digest('hex'), size: preparedBytes.length, mode: '100644', type: 'blob' });
  if (options.symlink) entries.push({ path: options.symlink, sha: 'f'.repeat(40), size: 8, mode: '120000', type: 'blob' });
  const writes = []; const reads = []; let headReads = 0; let head = editorHead;
  const handler = async request => {
    const url = new URL(request.url);
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(request.headers.get('authorization'), `Bearer ${token}`);
    const path = url.pathname;
    if (request.method === 'GET') reads.push(path);
    if (path === '/user') return options.expired ? Response.json({ message: 'bad credentials' }, { status: 401 }) : Response.json({ id: options.userId ?? 1, login: 'owner' });
    if (path === '/user/installations') return Response.json({ total_count: 1, installations: [{
      id: 3, account: { id: 1 }, repository_selection: 'selected', suspended_at: null,
      permissions: { contents: 'write', metadata: 'read' },
    }] });
    if (path === '/user/installations/3/repositories') return Response.json({ total_count: 1, repositories: [{ id: options.installationRepositoryId ?? 2 }] });
    if (path === '/repositories/2') return Response.json({ id: 2, full_name: 'owner/website', default_branch: 'main', owner: { id: 1 } });
    if (path === '/repos/owner/website/git/ref/heads/main') {
      headReads++;
      if (options.moveAtHeadRead === headReads) head = movedHead;
      return Response.json({ object: { type: 'commit', sha: head } });
    }
    if (path === `/repos/owner/website/git/commits/${editorHead}`) return Response.json({ sha: editorHead, tree: { sha: editorTree } });
    if (path === `/repos/owner/website/git/trees/${editorTree}`) {
      assert.equal(url.searchParams.get('recursive'), '1');
      return Response.json({ sha: editorTree, truncated: false, tree: entries });
    }
    if (request.method === 'GET' && path.startsWith('/repos/owner/website/git/blobs/')) {
      const blob = blobs.get(path.split('/').at(-1));
      assert.ok(blob, 'Only a tree-approved blob may be read');
      return Response.json(blob);
    }
    const body = await request.json();
    writes.push({ path, method: request.method, body });
    if (path === '/repos/owner/website/git/blobs' && request.method === 'POST') {
      const bytes = Buffer.from(body.content, body.encoding);
      return Response.json({ sha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') });
    }
    if (path === '/repos/owner/website/git/trees' && request.method === 'POST') return Response.json({ sha: publishedTree });
    if (path === '/repos/owner/website/git/commits' && request.method === 'POST') return Response.json({ sha: publishedCommit });
    if (path === '/repos/owner/website/git/refs/heads/main' && request.method === 'PATCH') {
      if (options.rejectRef) return Response.json({ message: 'Update is not a fast forward' }, { status: 422 });
      assert.equal(body.force, false);
      head = body.sha;
      return Response.json({ object: { type: 'commit', sha: head } });
    }
    throw new Error(`Unexpected GitHub operation: ${request.method} ${path}`);
  };
  return { handler, writes, reads, sources, get head() { return head; } };
}

function publishBody(overrides = {}) {
  return JSON.stringify({ baseCommit: editorHead, changes: [{ path: 'src/content/site.json', content: JSON.stringify({ name: 'After' }) }], media: [], ...overrides });
}

test('editor denies missing, forged, expired and non-owner credentials before reading content or writing', async t => {
  const fixture = editorFixture(); const worker = runtime(fixture.handler); t.after(() => worker.dispose());
  for (const [path, method] of [['/editor', 'GET'], ['/editor/file', 'GET'], ['/editor/publish', 'POST']]) {
    const denied = await worker.dispatchFetch(`https://auth.test${path}`, { method, headers: { Origin: 'https://site.test' } });
    assert.equal(denied.status, 401);
    const forged = await worker.dispatchFetch(`https://auth.test${path}`, { method, headers: { Origin: 'https://site.test', Authorization: 'Bearer ghp_broadtoken' } });
    assert.equal(forged.status, 401);
  }
  const foreign = await worker.dispatchFetch('https://auth.test/editor/publish', { method: 'POST', headers: { ...publishHeaders, Origin: 'https://attacker.test' }, body: publishBody() });
  assert.equal(foreign.status, 403); assert.equal(foreign.headers.get('access-control-allow-origin'), null);
  assert.deepEqual(fixture.reads, []); assert.deepEqual(fixture.writes, []);
  for (const options of [{ expired: true }, { userId: 999 }]) {
    const isolated = editorFixture(options); const deniedWorker = runtime(isolated.handler); t.after(() => deniedWorker.dispose());
    for (const [path, method] of [['/editor', 'GET'], ['/editor/file', 'GET'], ['/editor/publish', 'POST']]) {
      const response = await deniedWorker.dispatchFetch(`https://auth.test${path}`, { method, headers: publishHeaders, ...(method === 'POST' ? { body: publishBody() } : {}) });
      assert.equal(response.status, options.expired ? 401 : 403);
    }
    assert.deepEqual(isolated.reads, ['/user', '/user', '/user']); assert.deepEqual(isolated.writes, []);
  }
});

test('editor verifies the selected installation before exposing its snapshot', async t => {
  const fixture = editorFixture({ installationRepositoryId: 999 }); const worker = runtime(fixture.handler); t.after(() => worker.dispose());
  const response = await worker.dispatchFetch('https://auth.test/editor', { headers: analyticsHeaders });
  assert.equal(response.status, 403);
  assert.deepEqual(fixture.reads, ['/user', '/user/installations', '/user/installations/3/repositories']);
  assert.deepEqual(fixture.writes, []);
});

test('editor snapshot and pinned file reads never expose arbitrary paths or stale blobs', async t => {
  const fixture = editorFixture({ symlink: 'src/content/pages/linked.json' }); const worker = runtime(fixture.handler); t.after(() => worker.dispose());
  const snapshot = await worker.dispatchFetch('https://auth.test/editor', { headers: analyticsHeaders });
  assert.equal(snapshot.status, 200); assert.match(snapshot.headers.get('cache-control'), /no-store/);
  const value = await snapshot.json();
  assert.equal(value.repository, 'owner/website'); assert.equal(value.owner.id, 1);
  assert.deepEqual(value.files.map(file => file.path).sort(), ['src/content/gallery.json', 'src/content/media-previews.json', 'src/content/site.json']);
  const file = await worker.dispatchFetch(`https://auth.test/editor/file?path=src%2Fcontent%2Fsite.json&ref=${editorHead}`, { headers: analyticsHeaders });
  assert.equal(file.status, 200); assert.equal((await file.json()).content, fixture.sources.get('src/content/site.json'));
  const readsBefore = fixture.reads.filter(path => path.includes('/git/blobs/')).length;
  for (const [path, ref, expected] of [['src/secret.ts', editorHead, 400], ['src/content/../secret.ts', editorHead, 400], ['src/content/pages/linked.json', editorHead, 404], ['src/content/site.json', movedHead, 409], ['src/content/site.json', 'main/../../secret', 400]]) {
    const response = await worker.dispatchFetch(`https://auth.test/editor/file?${new URLSearchParams({ path, ref })}`, { headers: analyticsHeaders });
    assert.equal(response.status, expected);
  }
  assert.equal(fixture.reads.filter(path => path.includes('/git/blobs/')).length, readsBefore);
  const overwrite = await worker.dispatchFetch('https://auth.test/editor/publish', { method: 'POST', headers: publishHeaders, body: publishBody({ changes: [{ path: 'src/content/pages/linked.json', content: '{"title":"A valid page"}' }] }) });
  assert.equal(overwrite.status, 400);
  assert.deepEqual(fixture.writes, []);
});

test('editor preflights disallowed paths, duplicates, broken content and malformed media without Git writes', async t => {
  const fixture = editorFixture(); const worker = runtime(fixture.handler); t.after(() => worker.dispose());
  const source = { path: 'src/content/site.json', content: '{"name":"After"}' };
  const invalid = [
    { changes: [{ ...source, path: 'src/content/../../astro.config.mjs' }] },
    { changes: [{ ...source, path: '.github/workflows/deploy.yml' }] },
    { changes: [{ ...source, path: 'src/content/media-previews.json' }] },
    { changes: [source, source] },
    { changes: [{ ...source, content: '{broken' }] },
    { changes: [{ ...source, content: '{"name":"After","githubUrl":"javascript:alert(1)"}' }] },
    { changes: [{ ...source, content: '{"name":"After","githubUrl":"mailto:owner@example.com"}' }] },
    { changes: [{ ...source, content: '{"name":"After","githubUrl":"tel:+123456789"}' }] },
    { changes: [{ ...source, content: '{"name":"After","newsletterUrl":"/subscribe"}' }] },
    { changes: [{ ...source, content: '{"name":"After","newsletterUrl":"http://follow.it/website"}' }] },
    { changes: [{ ...source, content: '{"name":"After","newsletterUrl":"https://example.com/subscribe"}' }] },
    { changes: [{ path: 'src/content/posts/new.md', content: '---\ntitle: Bad\ndraft: false\npermalink: invalid\ndate: 2026-02-30\n---\nText' }] },
    { changes: [{ path: 'src/content/posts/new.md', content: '---\ntitle: Bad section\nsection: [devlog]\n---\nText' }] },
    { changes: [{ path: 'src/content/gallery.json', content: JSON.stringify({ items: [{ id: 'bad-type', title: 'Bad type', type: ['image'], alt: 'Image', src: previousPreviewPath }] }) }] },
    { changes: [{ path: 'src/content/gallery.json', content: JSON.stringify({ items: [{ id: 'missing', title: 'Missing media', type: 'image', alt: 'Missing image', src: `/media/missing-preview-${'0'.repeat(32)}.webp` }] }) }] },
    { media: [{ path: `public/media/original-preview-${'0'.repeat(32)}.webp`, content: 'aW52YWxpZA==', entry: { sha256: '0'.repeat(64), kind: 'image', width: 1, height: 1 } }] },
    { repository: 'attacker/elsewhere' },
  ];
  const fake = Buffer.from('not an actual image'); const sha256 = createHash('sha256').update(fake).digest('hex');
  invalid.push({ media: [{ path: `public/media/fake-preview-${sha256.slice(0, 32)}.webp`, content: fake.toString('base64'), entry: { sha256, kind: 'image', width: 1, height: 1 } }] });
  for (const body of invalid) {
    const response = await worker.dispatchFetch('https://auth.test/editor/publish', { method: 'POST', headers: publishHeaders, body: publishBody(body) });
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  assert.deepEqual(fixture.writes, []); assert.equal(fixture.head, editorHead);
});

test('editor rejects known stale and preflight-racing publishes before creating draft blobs', async t => {
  for (const options of [{}, { moveAtHeadRead: 2 }]) {
    const fixture = editorFixture(options); const worker = runtime(fixture.handler); t.after(() => worker.dispose());
    const response = await worker.dispatchFetch('https://auth.test/editor/publish', { method: 'POST', headers: publishHeaders, body: publishBody(options.moveAtHeadRead ? {} : { baseCommit: movedHead }) });
    assert.equal(response.status, 409); assert.deepEqual(fixture.writes, []);
  }
});

test('editor never force-updates a racing publication or reports a rejected ref as success', async t => {
  for (const options of [{ moveAtHeadRead: 3 }, { moveAtHeadRead: 4 }, { rejectRef: true }]) {
    const fixture = editorFixture(options); const worker = runtime(fixture.handler); t.after(() => worker.dispose());
    const response = await worker.dispatchFetch('https://auth.test/editor/publish', { method: 'POST', headers: publishHeaders, body: publishBody() });
    assert.equal(response.status, 409);
    const updates = fixture.writes.filter(write => write.method === 'PATCH');
    if (options.rejectRef) { assert.equal(updates.length, 1); assert.equal(updates[0].body.force, false); }
    else assert.deepEqual(updates, []);
    assert.notEqual(fixture.head, publishedCommit);
  }
});

test('editor publishes text, prepared media and server-merged registry in one atomic commit', async t => {
  const fixture = editorFixture(); const worker = runtime(fixture.handler); t.after(() => worker.dispose());
  const content = preparedImage;
  const sha256 = createHash('sha256').update(Buffer.from(content, 'base64')).digest('hex');
  const path = `public/media/pixel-preview-${sha256.slice(0, 32)}.webp`;
  const entry = { sha256, kind: 'image', width: 1, height: 1 };
  const response = await worker.dispatchFetch('https://auth.test/editor/publish', { method: 'POST', headers: publishHeaders, body: publishBody({
    changes: [{ path: 'src/content/gallery.json', content: JSON.stringify({ items: [{ id: 'pixel', title: 'Pixel', type: 'image', src: path.slice(6), alt: 'One pixel', caption: 'A test image', poster: '' }] }) }],
    media: [{ path, content, entry }],
  }) });
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), { commit: publishedCommit, htmlUrl: `https://github.com/owner/website/commit/${publishedCommit}` });
  assert.equal(fixture.head, publishedCommit);
  const treeWrites = fixture.writes.filter(write => write.path.endsWith('/git/trees'));
  assert.equal(treeWrites.length, 1); assert.equal(treeWrites[0].body.base_tree, editorTree);
  assert.deepEqual(treeWrites[0].body.tree.map(item => item.path).sort(), [path, 'src/content/gallery.json', 'src/content/media-previews.json'].sort());
  const registry = treeWrites[0].body.tree.find(item => item.path === 'src/content/media-previews.json');
  assert.deepEqual(JSON.parse(registry.content), { files: { [previousPreviewPath]: previousPreviewEntry, [path.slice(6)]: entry } });
  const commits = fixture.writes.filter(write => write.path.endsWith('/git/commits'));
  assert.equal(commits.length, 1); assert.deepEqual(commits[0].body.parents, [editorHead]); assert.equal(commits[0].body.tree, publishedTree);
  assert.deepEqual(fixture.writes.at(-1).body, { sha: publishedCommit, force: false });
});

test('editor preflight allows only exact-origin endpoint methods and needed headers', async t => {
  const fixture = editorFixture(); const worker = runtime(fixture.handler); t.after(() => worker.dispose());
  const response = await worker.dispatchFetch('https://auth.test/editor/publish', { method: 'OPTIONS', headers: { Origin: 'https://site.test', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
  assert.equal(response.status, 204); assert.equal(response.headers.get('access-control-allow-origin'), 'https://site.test');
  const denied = await worker.dispatchFetch('https://auth.test/editor/file', { method: 'OPTIONS', headers: { Origin: 'https://site.test', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization' } });
  assert.equal(denied.status, 403); assert.deepEqual(fixture.reads, []); assert.deepEqual(fixture.writes, []);
});

function mp4ContainerFixture({ width = 640, metadata = 'generated', creationDate = 0 } = {}) {
  const box = (type, ...parts) => {
    const body = Buffer.concat(parts); const header = Buffer.alloc(8);
    header.writeUInt32BE(body.length + 8); header.write(type, 4, 4, 'latin1');
    return Buffer.concat([header, body]);
  };
  const mvhd = Buffer.alloc(100); mvhd.writeUInt32BE(creationDate, 4); mvhd.writeUInt32BE(1000, 12); mvhd.writeUInt32BE(2000, 16);
  const tkhd = Buffer.alloc(84); tkhd.writeUInt32BE(width * 65536, 76); tkhd.writeUInt32BE(480 * 65536, 80);
  const sample = Buffer.alloc(78); sample.writeUInt16BE(width, 24); sample.writeUInt16BE(480, 26);
  const description = Buffer.alloc(8); description.writeUInt32BE(1, 4);
  const sampleTable = box('stbl', box('stsd', description, box('avc1', sample, box('avcC', Buffer.from([1, 66, 0, 30])))));
  const mdia = box('mdia', box('minf', sampleTable), ...(metadata === 'nested-uuid' ? [box('uuid', Buffer.from('private camera GPS coordinates'))] : []));
  const dataHeader = Buffer.alloc(8); dataHeader.writeUInt32BE(1);
  const udta = metadata === 'location'
    ? box('udta', box('©xyz', Buffer.from('+40.0000-074.0000/')))
    : box('udta', box('meta', Buffer.alloc(4), box('ilst', box('©too', box('data', dataHeader, Buffer.from('Lavf59.27.100'))))));
  // These isolated box fixtures exercise publication's metadata boundary, not decoding.
  return Buffer.concat([box('ftyp', Buffer.from('isom0000isom')), box('moov', box('mvhd', mvhd), box('trak', box('tkhd', tkhd), mdia), udta), box('mdat', Buffer.from([0]))]);
}

test('editor rejects original MP4 metadata, nested private boxes and oversized video before writes', async t => {
  for (const options of [{ metadata: 'generated' }, { metadata: 'location' }, { metadata: 'nested-uuid' }, { width: 1920 }, { creationDate: 123456 }]) {
    const fixture = editorFixture(); const worker = runtime(fixture.handler); t.after(() => worker.dispose());
    const bytes = mp4ContainerFixture(options); const sha256 = createHash('sha256').update(bytes).digest('hex');
    const path = `public/media/video-preview-${sha256.slice(0, 32)}.mp4`;
    const response = await worker.dispatchFetch('https://auth.test/editor/publish', { method: 'POST', headers: publishHeaders, body: publishBody({ media: [{ path, content: bytes.toString('base64'), entry: { sha256, kind: 'video', width: options.width ?? 640, height: 480, duration: 2 } }] }) });
    const allowed = options.metadata === 'generated';
    assert.equal(response.status, allowed ? 200 : 400, await response.clone().text());
    if (!allowed) { assert.deepEqual(fixture.writes, []); assert.equal(fixture.head, editorHead); }
  }
});
