import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import { NodeApiClient } from '@ttech-pub/grpc-node-client';
import { Status } from 'nice-grpc';
import { createApp } from '../src/app.js';
import { OwnerAuth, type SessionStore } from '../src/auth.js';
import { InvestSandbox } from '../src/invest-sandbox.js';
import { connectToPostgres, migrateDatabase, PostgresSandboxConnection } from '../src/postgres.js';
import { SandboxConnection, SandboxError, type SandboxBroker, type SandboxStore } from '../src/sandbox.js';
import { TokenCipher } from '../src/token-cipher.js';

const token = 'sandbox-secret-not-for-the-browser';
const password = 'sandbox-test-owner-password';
const cipher = new TokenCipher('ab'.repeat(32));

function fakeBroker() {
  const accounts = [{ id: 'existing', name: 'Existing sandbox account' }];
  const funded: string[] = [];
  let offline = false;
  let fundingUncertain = false;
  const broker: SandboxBroker = {
    async accounts(candidate) {
      if (offline) throw new SandboxError('SANDBOX_UNREACHABLE');
      if (candidate !== token) throw new SandboxError('SANDBOX_TOKEN_REJECTED');
      return [...accounts];
    },
    async openAccount() {
      accounts.push({ id: 'new', name: 'Сёрфинг' });
      return 'new';
    },
    async fundAccount(_token, accountId) {
      funded.push(accountId);
      if (fundingUncertain) throw new SandboxError('SANDBOX_UNREACHABLE');
    },
  };
  return { broker, funded, goOffline: () => { offline = true; }, loseFundingReply: () => { fundingUncertain = true; } };
}

async function serve(t: TestContext, sandbox: SandboxConnection) {
  const sessions = new Map<string, Date>();
  const sessionStore: SessionStore = {
    async create(digest, expiresAt) { sessions.set(digest, expiresAt); },
    async activeUntil(digest) { return sessions.get(digest) ?? null; },
    async revoke(digest) { sessions.delete(digest); },
  };
  const auth = await OwnerAuth.create(password, sessionStore);
  const server = createApp({ auth, secureCookies: false, sandbox }).listen(0, '127.0.0.1');
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

test('the token cannot be decrypted with a different key', () => {
  const encrypted = cipher.encrypt(token);
  assert.throws(() => new TokenCipher('cd'.repeat(32)).decrypt(encrypted));
  assert.equal(cipher.decrypt(encrypted), token);
});

test('the SDK adapter distinguishes definite rejection from transport failure', async t => {
  let code = Status.INVALID_ARGUMENT;
  const create = t.mock.method(NodeApiClient, 'create', async () => ({
    sandbox: {
      async sandboxPayIn() { throw Object.assign(new Error(`broker details: ${token}`), { code }); },
    },
  } as unknown as NodeApiClient));
  const adapter = new InvestSandbox();
  await assert.rejects(adapter.fundAccount(token, 'new'), { message: 'SANDBOX_OPERATION_REJECTED' });
  code = Status.UNAVAILABLE;
  await assert.rejects(adapter.fundAccount(token, 'new'), { message: 'SANDBOX_UNREACHABLE' });
  assert.deepEqual(create.mock.calls[0].arguments[0], {
    token, url: 'https://sandbox-invest-public-api.tbank.ru:443', telemetry: 'disabled', useMincifryCertificate: true,
  });
});

const testDatabase = process.env.SERFING_TEST_DATABASE_URL;
test('PostgreSQL restores the encrypted connection and selected account after restart',
  { skip: !testDatabase && 'Requires a disposable PostgreSQL database' }, async () => {
    const first = connectToPostgres(testDatabase);
    const { broker } = fakeBroker();
    try {
      await migrateDatabase(first.db);
      const service = new SandboxConnection(new PostgresSandboxConnection(first.db), cipher, broker);
      await service.connect(token);
      await service.selectAccount('existing');
      const { rows } = await first.db.$client.query('SELECT * FROM sandbox_connection');
      assert.equal(rows.length, 1);
      assert.ok(!JSON.stringify(rows).includes(token));
    } finally {
      await first.close();
    }
    const restarted = connectToPostgres(testDatabase);
    try {
      const service = new SandboxConnection(new PostgresSandboxConnection(restarted.db), new TokenCipher('ab'.repeat(32)), broker);
      assert.deepEqual(await service.status(), {
        status: 'connected', accountId: 'existing', virtualFundingRubles: 100_000,
        accounts: [{ id: 'existing', name: 'Existing sandbox account' }],
      });
    } finally {
      await restarted.close();
    }
  });
