import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import { createApp } from '../src/api/app.js';
import { OwnerAuth, type SessionStore } from '../src/core/auth.js';

const password = 'test-owner-password';

async function setup(t: TestContext, secureCookies = false) {
  let now = Date.now();
  const store = new Map<string, Date>();
  const sessions: SessionStore = {
    async create(digest, expiresAt) { store.set(digest, expiresAt); },
    async activeUntil(digest, at) {
      const expiresAt = store.get(digest);
      return expiresAt !== undefined && expiresAt > at ? expiresAt : null;
    },
    async revoke(digest) { store.delete(digest); },
  };
  const auth = await OwnerAuth.create(password, sessions, { now: () => now, ttlMs: 10_000 });
  const server = createApp({ auth, secureCookies }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const request = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${address.port}/api${path}`, init);
  const mutation = { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Serfing-Request': '1' } };
  const login = (value = password) => request('/auth/login', { ...mutation, body: JSON.stringify({ password: value }) });
  return { request, mutation, login, store, advance: (ms: number) => { now += ms; } };
}

test('the owner can sign in, load the protected dashboard and revoke the session', async t => {
  const { request, mutation, login, store } = await setup(t);
  assert.equal((await request('/dashboard')).status, 401);
  assert.equal((await request('/auth/session')).status, 401);
  const signedIn = await login();
  assert.equal(signedIn.status, 200);
  assert.deepEqual(await signedIn.json(), { authenticated: true });
  const header = signedIn.headers.get('set-cookie');
  assert.match(header ?? '', /HttpOnly/i);
  assert.match(header ?? '', /SameSite=Strict/i);
  const cookie = header!.split(';')[0];
  assert.equal(store.has(cookie.split('=')[1]), false, 'only a digest is stored');
  const session = await request('/auth/session', { headers: { cookie } });
  assert.equal(session.status, 200);
  assert.deepEqual(await session.json(), { authenticated: true, remainingMs: 10_000 });
  const dashboard = await request('/dashboard', { headers: { cookie } });
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.headers.get('cache-control') ?? '', /no-store/);
  assert.equal((await request('/auth/logout', { ...mutation, headers: { ...mutation.headers, cookie } })).status, 204);
  assert.equal((await request('/dashboard', { headers: { cookie } })).status, 401);
});

test('a wrong password and unsafe cross-origin-style mutations never create a session', async t => {
  const { request, login, store } = await setup(t);
  const rejected = await login('wrong');
  assert.equal(rejected.status, 401);
  assert.equal(rejected.headers.get('set-cookie'), null);
  const noCustomHeader = await request('/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
  });
  assert.equal(noCustomHeader.status, 403);
  assert.equal(store.size, 0);
});

test('a session expires server-side and the cookie can require HTTPS', async t => {
  const { request, login, advance } = await setup(t, true);
  const response = await login();
  const header = response.headers.get('set-cookie')!;
  assert.match(header, /;\s*Secure\b/i);
  advance(10_001);
  assert.equal((await request('/dashboard', { headers: { cookie: header.split(';')[0] } })).status, 401);
});

test('repeated incorrect passwords are rate limited', async t => {
  const { login, advance } = await setup(t);
  for (let i = 0; i < 5; i++) assert.equal((await login('wrong')).status, 401);
  const throttled = await login();
  assert.equal(throttled.status, 429);
  assert.ok(Number(throttled.headers.get('retry-after')) > 0);
  advance(60_001);
  assert.equal((await login()).status, 200);
});
