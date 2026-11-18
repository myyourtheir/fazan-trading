import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import { OwnerAuth, type SessionStore } from '../core/auth.js';
import { SandboxConnection, type SandboxStore } from '../core/sandbox.js';
import { fakeBroker, futures, token } from '../core/sandbox.test-support.js';
import { StrategySettings, type StrategyStore } from '../core/strategy-settings.js';
import { TokenCipher } from '../infra/token-cipher.js';
import { createApp } from './app.js';

const password = 'sandbox-test-owner-password';
const cipher = new TokenCipher('ab'.repeat(32));

async function serve(t: TestContext, sandbox: SandboxConnection, strategy?: StrategySettings) {
  const sessions = new Map<string, Date>();
  const sessionStore: SessionStore = {
    async create(digest, expiresAt) { sessions.set(digest, expiresAt); },
    async activeUntil(digest) { return sessions.get(digest) ?? null; },
    async revoke(digest) { sessions.delete(digest); },
  };
  const auth = await OwnerAuth.create(password, sessionStore);
  const server = createApp({ auth, secureCookies: false, sandbox, strategy }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  let cookie = '';
  return {
    async request(path: string, method = 'GET', body?: object, withSession = true) {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/${path}`, {
        method, headers: { 'X-Serfing-Request': '1', 'Content-Type': 'application/json', cookie: withSession ? cookie : '' },
        body: body && JSON.stringify(body),
      });
      if (path === 'auth/login') cookie = response.headers.get('set-cookie')?.split(';')[0] ?? '';
      const text = await response.text();
      assert.ok(!text.includes(token));
      return { status: response.status, body: text ? JSON.parse(text) : null };
    },
  };
}

test('the owner can connect, select, create, and fund sandbox accounts without exposing the token', async t => {
  let saved: Awaited<ReturnType<SandboxStore['load']>> = null;
  const store: SandboxStore = { async load() { return saved; }, async save(record) { saved = record; } };
  const { broker, funded, goOffline, loseFundingReply } = fakeBroker();
  const { request } = await serve(t, new SandboxConnection(store, cipher, broker));

  assert.equal((await request('sandbox')).status, 401);
  assert.equal((await request('sandbox/connection', 'PUT', { token })).status, 401);
  assert.equal((await request('auth/login', 'POST', { password })).status, 200);
  assert.deepEqual((await request('sandbox')).body, { status: 'unconfigured', accountId: null, accounts: [] });
  assert.deepEqual(await request('sandbox/connection', 'PUT', { token: 'wrong' }),
    { status: 422, body: { code: 'SANDBOX_TOKEN_REJECTED' } });
  assert.equal(await store.load(), null);
  assert.equal((await request('sandbox/connection', 'PUT', { token })).status, 204);
  const stored = await store.load();
  assert.ok(stored && !JSON.stringify(stored).includes(token));
  assert.equal((await request('sandbox/account', 'PUT', { accountId: 'foreign' })).status, 422);
  assert.equal((await request('sandbox/account', 'PUT', { accountId: 'existing' })).status, 204);
  assert.equal((await request('sandbox')).body.accountId, 'existing');
  assert.equal((await request('sandbox/connection', 'PUT', { token })).status, 204);
  assert.equal((await request('sandbox')).body.accountId, 'existing');
  assert.notEqual((await store.load())?.encryptedToken, stored.encryptedToken);

  assert.equal((await request('sandbox/accounts', 'POST')).status, 204);
  assert.deepEqual((await request('sandbox')).body, {
    status: 'connected', accountId: 'new', virtualFundingRubles: 100_000, accounts: [
      { id: 'existing', name: 'Existing sandbox account' }, { id: 'new', name: 'Сёрфинг' },
    ],
  });
  assert.equal((await request('sandbox/funding', 'POST', { accountId: 'existing' })).status, 422);
  assert.equal((await request('sandbox/funding', 'POST', { accountId: 'new' })).status, 204);
  assert.deepEqual(funded, ['new']);
  loseFundingReply();
  assert.deepEqual(await request('sandbox/funding', 'POST', { accountId: 'new' }),
    { status: 502, body: { code: 'SANDBOX_FUNDING_UNCERTAIN' } });
  assert.deepEqual(funded, ['new', 'new'], 'an ambiguous funding call is not retried automatically');

  goOffline();
  assert.deepEqual(await request('sandbox/connection', 'PUT', { token }),
    { status: 502, body: { code: 'SANDBOX_UNREACHABLE' } });
  assert.deepEqual((await request('sandbox')).body,
    { status: 'unavailable', accountId: 'new', accounts: [], code: 'SANDBOX_UNREACHABLE' });
});

test('unexpected broker details are not returned to the owner or logged', async t => {
  const logged = t.mock.method(console, 'error', () => {});
  const store: SandboxStore = { async load() { return null; }, async save() { assert.fail('Do not save an unverified token'); } };
  const { broker } = fakeBroker();
  broker.accounts = async () => { throw new Error(`SDK error: ${token}`); };
  const { request } = await serve(t, new SandboxConnection(store, cipher, broker));
  await request('auth/login', 'POST', { password });
  assert.deepEqual(await request('sandbox/connection', 'PUT', { token }),
    { status: 502, body: { code: 'SANDBOX_UNREACHABLE' } });
  assert.equal(logged.mock.callCount(), 0);
});

test('strategy search keeps ambiguous tickers separate and saving validates the account, UID and integers', async t => {
  let connection: Awaited<ReturnType<SandboxStore['load']>> = null;
  const store: SandboxStore = { async load() { return connection; }, async save(record) { connection = record; } };
  let settings: Awaited<ReturnType<StrategyStore['load']>> = null;
  const strategyStore: StrategyStore = { async load() { return settings; }, async save(record) { settings = record; } };
  const { broker } = fakeBroker();
  const sandbox = new SandboxConnection(store, cipher, broker);
  const strategy = new StrategySettings(strategyStore, sandbox);
  const { request } = await serve(t, sandbox, strategy);
  const config = { accountId: 'existing', instrumentUid: 'contract-b', emaPeriod: 55, lots: 3 };
  const put = (body: object) => request('strategy', 'PUT', body);
  assert.equal((await request('strategy')).status, 401);
  assert.equal((await request('strategy/futures?q=IMOEXF')).status, 401);
  assert.equal((await put(config)).status, 401);
  await request('auth/login', 'POST', { password });
  assert.deepEqual((await request('strategy')).body, {
    defaults: { ticker: 'IMOEXF', emaPeriod: 55 }, settings: null,
  });
  await request('sandbox/connection', 'PUT', { token });
  assert.equal((await put(config)).status, 422);
  await request('sandbox/account', 'PUT', { accountId: 'existing' });
  const matches = (await request('strategy/futures?q=imoexf')).body;
  assert.deepEqual(matches.map(({ uid }: { uid: string }) => uid), ['contract-a', 'contract-b']);
  assert.equal(matches[1].expirationDate, futures[1].expirationDate);
  assert.deepEqual((await request(`strategy/futures?q=${encodeURIComponent('мосбиржи')}`)).body, [matches[0]]);
  for (const invalid of [0, -1, 1.5, '3', 2 ** 31]) {
    assert.equal((await put({ ...config, emaPeriod: invalid })).status, 400);
    assert.equal((await put({ ...config, lots: invalid })).status, 400);
  }
  for (const instrumentUid of ['IMOEXF', 'unknown', 'unavailable']) {
    assert.equal((await put({ ...config, instrumentUid })).status, 422);
  }
  assert.equal((await put({ ...config, accountId: 'other' })).status, 422);
  assert.equal(settings, null);
  assert.equal((await put(config)).status, 204);
  assert.equal((await put({ ...config, lots: 0 })).status, 400);
  await request('sandbox/accounts', 'POST');
  assert.equal((await put({ ...config, lots: 9 })).status, 422, 'A stale account cannot save over the settings');
  assert.deepEqual((await request('strategy')).body.settings, { instrument: matches[1], emaPeriod: 55, lots: 3 });
});
