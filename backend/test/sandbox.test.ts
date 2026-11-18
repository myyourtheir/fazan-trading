import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import { NodeApiClient } from '@ttech-pub/grpc-node-client';
import { InstrumentStatus } from '@ttech-pub/grpc-node-client/compiled/common.js';
import { Status } from 'nice-grpc';
import { createApp } from '../src/app.js';
import { OwnerAuth, type SessionStore } from '../src/core/auth.js';
import { InvestSandbox } from '../src/infra/invest-sandbox.js';
import { connectToPostgres, migrateDatabase, PostgresSandboxConnection, PostgresStrategySettings } from '../src/infra/postgres.js';
import { SandboxConnection, SandboxError, type SandboxBroker, type SandboxStore } from '../src/core/sandbox.js';
import { StrategySettings, type StrategyStore } from '../src/core/strategy-settings.js';
import { TokenCipher } from '../src/infra/token-cipher.js';

const token = 'sandbox-secret-not-for-the-browser';
const password = 'sandbox-test-owner-password';
const cipher = new TokenCipher('ab'.repeat(32));
const futures = [
  { uid: 'contract-a', ticker: 'IMOEXF', name: 'Индекс Мосбиржи', classCode: 'SPBFUT', exchange: 'MOEX',
    expirationDate: null, apiTradeAvailableFlag: true },
  { uid: 'contract-b', ticker: 'IMOEXF', name: 'Другой контракт', classCode: 'SPBFUT', exchange: 'MOEX',
    expirationDate: '2027-03-18T00:00:00.000Z', apiTradeAvailableFlag: true },
  { uid: 'unavailable', ticker: 'IMOEXF', name: 'Недоступный контракт', classCode: 'SPBFUT', exchange: 'MOEX',
    expirationDate: null, apiTradeAvailableFlag: false },
];

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
    async futures(candidate) {
      if (offline) throw new SandboxError('SANDBOX_UNREACHABLE');
      assert.equal(candidate, token);
      return futures;
    },
  };
  return { broker, funded, goOffline: () => { offline = true; }, loseFundingReply: () => { fundingUncertain = true; } };
}

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

test('the SDK requests the futures catalogue through the sandbox channel', async t => {
  const instruments = {
    async futures(_request: { instrumentStatus: InstrumentStatus }) {
      return { instruments: [{ ...futures[1], expirationDate: new Date(futures[1].expirationDate!) }] };
    },
  };
  const list = t.mock.method(instruments, 'futures');
  const create = t.mock.method(NodeApiClient, 'create', async () => ({ instruments }) as unknown as NodeApiClient);
  assert.deepEqual(await new InvestSandbox().futures(token), [futures[1]]);
  assert.equal(create.mock.calls[0].arguments[0]?.url, 'https://sandbox-invest-public-api.tbank.ru:443');
  assert.deepEqual(list.mock.calls[0].arguments[0], { instrumentStatus: InstrumentStatus.INSTRUMENT_STATUS_ALL });
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

const testDatabase = process.env.SERFING_TEST_DATABASE_URL;
test('PostgreSQL restores one active strategy, including the exact contract, without the broker',
  { skip: !testDatabase && 'Requires a disposable PostgreSQL database' }, async () => {
    const first = connectToPostgres(testDatabase);
    const { broker, goOffline } = fakeBroker();
    const sandbox = new SandboxConnection({
      async load() { return { encryptedToken: cipher.encrypt(token), accountId: 'existing' }; },
      async save() { assert.fail('Unexpected account change'); },
    }, cipher, broker);
    let expected;
    try {
      await migrateDatabase(first.db);
      const service = new StrategySettings(new PostgresStrategySettings(first.db), sandbox);
      await service.save({ accountId: 'existing', instrumentUid: 'contract-a', emaPeriod: 55, lots: 1 });
      await service.save({ accountId: 'existing', instrumentUid: 'contract-b', emaPeriod: 34, lots: 7 });
      expected = await service.get();
      assert.equal(expected.settings?.instrument.uid, 'contract-b');
      assert.equal(expected.settings?.emaPeriod, 34);
      assert.equal(expected.settings?.lots, 7);
      assert.equal((await first.db.$client.query('SELECT * FROM strategy_settings')).rowCount, 1);
    } finally {
      await first.close();
    }
    goOffline();
    const restarted = connectToPostgres(testDatabase);
    try {
      const service = new StrategySettings(new PostgresStrategySettings(restarted.db), sandbox);
      assert.deepEqual(await service.get(), expected);
    } finally {
      await restarted.close();
    }
  });

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
