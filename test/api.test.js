'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../server');

let server, base, dataDir;

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'appstore-test-'));
  server = createApp({ dataDir });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// Minimal client that remembers its session cookie.
function client() {
  let cookie = '';
  return async (method, url, body, extraHeaders = { 'X-Store-Client': '1' }) => {
    const headers = { ...extraHeaders };
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : await res.text() };
  };
}

const HTML = '<!doctype html><html><head><title>t</title></head><body><h1>Hi</h1></body></html>';

test('store is seeded with sample apps', async () => {
  const c = client();
  const r = await c('GET', '/api/apps');
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.apps.length >= 5);
  assert.ok(r.body.apps.some((a) => a.name === 'Star Catcher'));
});

test('full developer → user flow', async () => {
  const dev = client();
  const user = client();

  // Signing up works and publishing requires an account.
  assert.strictEqual((await dev('POST', '/api/apps', { name: 'X', html: HTML })).status, 401);
  const su = await dev('POST', '/api/auth/signup', { username: 'alice', password: 'secret1', displayName: 'Alice Apps' });
  assert.strictEqual(su.status, 200);
  assert.strictEqual(su.body.user.displayName, 'Alice Apps');
  assert.strictEqual((await dev('POST', '/api/auth/signup', { username: 'Alice', password: 'secret1' })).status, 409);

  // Publish.
  const pub = await dev('POST', '/api/apps', {
    name: 'Hello World', tagline: 'Says hi', description: 'A greeting app', category: 'Utilities',
    icon: { type: 'emoji', emoji: '👋', bg: '#123456' }, version: '1.0.0', html: HTML,
  });
  assert.strictEqual(pub.status, 200, JSON.stringify(pub.body));
  const id = pub.body.app.id;
  assert.strictEqual(pub.body.app.developer.name, 'Alice Apps');
  assert.strictEqual((await dev('POST', '/api/apps', { name: 'hello world', html: HTML })).status, 409);

  // Others find it by searching.
  const found = await user('GET', '/api/apps?q=greeting');
  assert.deepStrictEqual(found.body.apps.map((a) => a.id), [id]);
  const byCat = await user('GET', '/api/apps?category=Utilities');
  assert.ok(byCat.body.apps.some((a) => a.id === id));

  // Run it in the store: sandboxed so it can't touch the store's origin.
  const run = await user('GET', `/run/${id}`);
  assert.strictEqual(run.status, 200);
  assert.strictEqual(run.body, HTML);
  assert.match(run.headers.get('content-security-policy'), /^sandbox /);
  assert.doesNotMatch(run.headers.get('content-security-policy'), /allow-same-origin/);

  // Download.
  const dl = await user('GET', `/download/${id}`);
  assert.match(dl.headers.get('content-disposition'), /attachment; filename="hello-world-1\.0\.0\.html"/);

  // Install requires sign in, then shows up in library.
  assert.strictEqual((await user('POST', `/api/apps/${id}/install`)).status, 401);
  await user('POST', '/api/auth/signup', { username: 'bob', password: 'secret2' });
  const inst = await user('POST', `/api/apps/${id}/install`);
  assert.strictEqual(inst.body.app.installed, true);
  assert.strictEqual(inst.body.app.installs, 1);
  await user('POST', `/api/apps/${id}/install`); // idempotent
  const lib = await user('GET', '/api/library');
  assert.deepStrictEqual(lib.body.apps.map((a) => a.id), [id]);
  assert.strictEqual(lib.body.apps[0].installs, 1);

  // Reviews: one per user, owner can't review.
  assert.strictEqual((await dev('POST', `/api/apps/${id}/reviews`, { rating: 5 })).status, 400);
  assert.strictEqual((await user('POST', `/api/apps/${id}/reviews`, { rating: 9 })).status, 400);
  await user('POST', `/api/apps/${id}/reviews`, { rating: 4, text: 'Nice' });
  const rv = await user('POST', `/api/apps/${id}/reviews`, { rating: 5, text: 'Great' });
  assert.deepStrictEqual(rv.body.app.rating, { avg: 5, count: 1 });

  // Only the developer can update; new versions must be new numbers.
  assert.strictEqual((await user('PUT', `/api/apps/${id}`, { name: 'Hacked' })).status, 403);
  assert.strictEqual((await dev('PUT', `/api/apps/${id}`, { html: HTML, version: '1.0.0', notes: 'x' })).status, 409);
  const HTML2 = HTML.replace('Hi', 'Hello v2');
  const up = await dev('PUT', `/api/apps/${id}`, { html: HTML2, version: '1.1.0', notes: 'Bigger greeting' });
  assert.strictEqual(up.status, 200);
  assert.strictEqual(up.body.app.version, '1.1.0');
  assert.strictEqual((await user('GET', `/run/${id}`)).body, HTML2);
  assert.strictEqual((await user('GET', `/run/${id}?v=1.0.0`)).body, HTML);
  const code = await dev('GET', `/api/dev/apps/${id}/code`);
  assert.strictEqual(code.body.html, HTML2);
  assert.strictEqual((await user('GET', `/api/dev/apps/${id}/code`)).status, 403);

  // Uninstall then delete.
  const un = await user('DELETE', `/api/apps/${id}/install`);
  assert.strictEqual(un.body.app.installed, false);
  assert.strictEqual((await user('DELETE', `/api/apps/${id}`)).status, 403);
  assert.strictEqual((await dev('DELETE', `/api/apps/${id}`)).status, 200);
  assert.strictEqual((await user('GET', `/api/apps/${id}`)).status, 404);
});

test('login, logout and wrong passwords', async () => {
  const c = client();
  await c('POST', '/api/auth/signup', { username: 'carol', password: 'pass123' });
  await c('POST', '/api/auth/logout');
  assert.strictEqual((await c('GET', '/api/me')).body.user, null);
  assert.strictEqual((await c('POST', '/api/auth/login', { username: 'carol', password: 'nope' })).status, 401);
  assert.strictEqual((await c('POST', '/api/auth/login', { username: 'storeteam', password: '' })).status, 401);
  const ok = await c('POST', '/api/auth/login', { username: 'CAROL', password: 'pass123' });
  assert.strictEqual(ok.body.user.username, 'carol');
});

test('mutating API calls require the store client header (CSRF guard)', async () => {
  const c = client();
  const r = await c('POST', '/api/auth/signup', { username: 'dave', password: 'pass123' }, {});
  assert.strictEqual(r.status, 403);
});

test('validation rejects bad input', async () => {
  const c = client();
  await c('POST', '/api/auth/signup', { username: 'erin', password: 'pass123' });
  assert.strictEqual((await c('POST', '/api/apps', { name: 'No code' })).status, 400);
  assert.strictEqual((await c('POST', '/api/apps', { name: 'Bad ver', html: HTML, version: '../x' })).status, 400);
  assert.strictEqual((await c('POST', '/api/apps', { name: 'Bad icon', html: HTML, icon: { type: 'image', data: 'data:image/svg+xml;base64,AAAA' } })).status, 400);
  assert.strictEqual((await c('POST', '/api/auth/signup', { username: 'x', password: 'pass123' })).status, 400);
});

test('data persists across restarts', async () => {
  server.db.flush();
  const again = createApp({ dataDir });
  await new Promise((r) => again.listen(0, r));
  try {
    const res = await fetch(`http://127.0.0.1:${again.address().port}/api/apps?q=star`);
    const { apps } = await res.json();
    assert.ok(apps.some((a) => a.name === 'Star Catcher'));
    assert.strictEqual(Object.values(again.db.data.users).filter((u) => u.username === 'storeteam').length, 1);
  } finally { again.close(); }
});

test('serves the store front end', async () => {
  const r = await fetch(base + '/');
  assert.match(await r.text(), /<title>App Store<\/title>/);
  assert.strictEqual((await fetch(base + '/missing.js')).status, 404);
});
