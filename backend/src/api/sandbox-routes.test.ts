import { surfingStrategy } from '../core/surfing-strategy.js';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import { OwnerAuth, type SessionStore } from '../core/auth.js';
import { Robot, type RobotService } from '../core/robot.js';
import type { JournalEntry } from '../core/journal.js';
import { SandboxConnection, type SandboxStore } from '../core/sandbox.js';
import { fakeBroker, futures, token } from '../core/sandbox.test-support.js';
import { StrategySettings, type StrategyStore } from '../core/strategy-settings.js';
import { TokenCipher } from '../infra/token-cipher.js';
import { createApp } from './app.js';

const password = 'sandbox-test-owner-password';
const cipher = new TokenCipher('ab'.repeat(32));

async function serve(
  t: TestContext,
  sandbox: SandboxConnection,
  strategy?: StrategySettings,
  robot?: RobotService,
) {
  const sessions = new Map<string, Date>();
  const sessionStore: SessionStore = {
    async create(digest, expiresAt) {
      sessions.set(digest, expiresAt);
    },
    async activeUntil(digest) {
      return sessions.get(digest) ?? null;
    },
    async revoke(digest) {
      sessions.delete(digest);
    },
  };
  const auth = await OwnerAuth.create(password, sessionStore);
  const server = createApp({
    auth,
    secureCookies: false,
    robot,
    settings: {
      sandbox,
      strategy,
      change: (action) => (robot ? robot.changeSettings(action) : action()),
    },
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  let cookie = '';
  return {
    async request(
      path: string,
      method = 'GET',
      body?: object,
      withSession = true,
      withCsrf = true,
    ) {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/${path}`, {
        method,
        headers: {
          ...(withCsrf && { 'X-Serfing-Request': '1' }),
          'Content-Type': 'application/json',
          cookie: withSession ? cookie : '',
        },
        body: body && JSON.stringify(body),
      });
      if (path === 'auth/login') cookie = response.headers.get('set-cookie')?.split(';')[0] ?? '';
      const text = await response.text();
      assert.ok(!text.includes(token));
      return { status: response.status, body: text ? JSON.parse(text) : null };
    },
  };
}

test('legacy claim requires an authenticated owner and explicit confirmation', async (t) => {
  const { broker } = fakeBroker();
  const sandbox = new SandboxConnection(
    {
      async load() {
        return null;
      },
      async save() {},
    },
    cipher,
    broker,
  );
  let claims = 0;
  const strategy = new StrategySettings(
    {
      async load() {
        return null;
      },
      async save() {},
      async loadImproved() {
        return null;
      },
      async saveImproved() {},
      async selected() {
        return 'surfing' as const;
      },
      async select() {},
      async legacyClaimAvailable() {
        return false;
      },
      async claimLegacy() {
        claims++;
      },
    },
    sandbox,
  );
  const { request } = await serve(t, sandbox, strategy);
  assert.equal((await request('strategy/legacy-claim', 'POST', { confirmed: true })).status, 401);
  await request('auth/login', 'POST', { password });
  assert.equal(
    (await request('strategy/legacy-claim', 'POST', { confirmed: true }, true, false)).status,
    403,
  );
  assert.equal((await request('strategy/legacy-claim', 'POST', {})).status, 400);
  assert.equal((await request('strategy/legacy-claim', 'POST', { confirmed: 'true' })).status, 400);
  assert.equal(claims, 0);
  assert.equal((await request('strategy/legacy-claim', 'POST', { confirmed: true })).status, 204);
  assert.equal(claims, 1);
});

test('the owner can connect, select, create, and fund sandbox accounts without exposing the token', async (t) => {
  let saved: Awaited<ReturnType<SandboxStore['load']>> = null;
  const store: SandboxStore = {
    async load() {
      return saved;
    },
    async save(record) {
      saved = record;
    },
  };
  const { broker, funded, goOffline, loseFundingReply } = fakeBroker();
  const { request } = await serve(t, new SandboxConnection(store, cipher, broker));

  assert.equal((await request('sandbox')).status, 401);
  assert.equal((await request('sandbox/balance?accountId=existing')).status, 401);
  assert.equal((await request('sandbox/connection', 'PUT', { token })).status, 401);
  assert.equal((await request('auth/login', 'POST', { password })).status, 200);
  assert.deepEqual((await request('sandbox')).body, {
    status: 'unconfigured',
    accountId: null,
    accounts: [],
  });
  assert.deepEqual(await request('sandbox/connection', 'PUT', { token: 'wrong' }), {
    status: 422,
    body: { code: 'SANDBOX_TOKEN_REJECTED' },
  });
  assert.equal(await store.load(), null);
  assert.equal((await request('sandbox/connection', 'PUT', { token })).status, 204);
  const stored = await store.load();
  assert.ok(stored && !JSON.stringify(stored).includes(token));
  assert.equal((await request('sandbox/account', 'PUT', { accountId: 'foreign' })).status, 422);
  assert.equal((await request('sandbox/account', 'PUT', { accountId: 'existing' })).status, 204);
  assert.equal((await request('sandbox')).body.accountId, 'existing');
  assert.deepEqual(await request('sandbox/balance?accountId=existing'), {
    status: 200,
    body: { accountId: 'existing', rubles: 100_000.25 },
  });
  assert.equal((await request('sandbox/balance')).status, 400);
  assert.equal((await request('sandbox/balance?accountId=foreign')).status, 422);
  assert.equal((await request('sandbox/connection', 'PUT', { token })).status, 204);
  assert.equal((await request('sandbox')).body.accountId, 'existing');
  assert.notEqual((await store.load())?.encryptedToken, stored.encryptedToken);

  assert.equal((await request('sandbox/accounts', 'POST')).status, 204);
  assert.equal((await request('sandbox/balance?accountId=existing')).status, 422);
  assert.deepEqual((await request('sandbox')).body, {
    status: 'connected',
    accountId: 'new',
    virtualFundingRubles: 100_000,
    accounts: [
      { id: 'existing', name: 'Existing sandbox account' },
      { id: 'new', name: 'fazan-trading' },
    ],
  });
  assert.equal((await request('sandbox/funding', 'POST', { accountId: 'existing' })).status, 422);
  assert.equal((await request('sandbox/funding', 'POST', { accountId: 'new' })).status, 204);
  assert.deepEqual(funded, ['new']);
  loseFundingReply();
  assert.deepEqual(await request('sandbox/funding', 'POST', { accountId: 'new' }), {
    status: 502,
    body: { code: 'SANDBOX_FUNDING_UNCERTAIN' },
  });
  assert.deepEqual(
    funded,
    ['new', 'new'],
    'an ambiguous funding call is not retried automatically',
  );

  goOffline();
  assert.equal((await request('sandbox/balance?accountId=new')).status, 502);
  assert.deepEqual(await request('sandbox/connection', 'PUT', { token }), {
    status: 502,
    body: { code: 'SANDBOX_UNREACHABLE' },
  });
  assert.deepEqual((await request('sandbox')).body, {
    status: 'unavailable',
    accountId: 'new',
    accounts: [],
    code: 'SANDBOX_UNREACHABLE',
  });
});

test('the server rejects trading settings changes until stopped and broker-confirmed flat', async (t) => {
  let connection: Awaited<ReturnType<SandboxStore['load']>> = {
    accountId: 'existing',
    encryptedToken: cipher.encrypt(token),
  };
  let settings: Awaited<ReturnType<StrategyStore['load']>> = null;
  const { broker } = fakeBroker();
  let position: number | null = 0;
  broker.accountIsFlat = async () => (position === null ? null : position === 0);
  const sandbox = new SandboxConnection(
    {
      async load() {
        return connection;
      },
      async save(value) {
        connection = value;
      },
    },
    cipher,
    broker,
  );
  const strategy = new StrategySettings(
    {
      async load() {
        return settings;
      },
      async save(value) {
        settings = value;
      },
      async loadImproved() {
        return null;
      },
      async saveImproved() {},
      async selected() {
        return 'surfing' as const;
      },
      async select() {},
      async legacyClaimAvailable() {
        return false;
      },
      async claimLegacy() {},
    },
    sandbox,
  );
  let unresolved = false;
  const robot = new Robot(
    {
      async verifySelection() {},
      async accountState() {
        return { position, activeOrders: false };
      },
      async submit() {
        assert.fail('No order expected');
      },
      async orderState() {
        assert.fail('No order expected');
      },
    },
    {
      async hasUnresolved() {
        return unresolved;
      },
      async unresolved() {
        return null;
      },
      async history() {
        return [];
      },
      async reserve() {
        assert.fail('No reservation expected');
      },
      async record() {
        assert.fail('No order expected');
      },
    },
    {
      async subscribe() {
        return () => {};
      },
    },
    async () => ({
      ...(await sandbox.tradingCredentials()),
      instrumentUid: 'contract-a',
      ticker: 'IMOEXF',
      emaPeriod: 55,
      lots: 1,
      timeframe: '1h',
    }),
    Date.now,
    (history, options, config) => surfingStrategy.live(history, options, config),
  );
  const { request } = await serve(t, sandbox, strategy, robot);
  const selection = { accountId: 'existing', instrumentUid: 'contract-a' };
  const close = (body: object, withSession = true) =>
    request('robot/close', 'POST', body, withSession);
  assert.equal((await close({ ...selection, confirmed: true }, false)).status, 401);
  for (const action of ['reconcile', 'resume']) {
    assert.equal((await request(`robot/${action}`, 'POST', undefined, false)).status, 401);
  }
  await request('auth/login', 'POST', { password });
  for (const action of ['reconcile', 'resume']) {
    assert.deepEqual(await request(`robot/${action}`, 'POST'), {
      status: 409,
      body: { code: 'ROBOT_NO_ORDER_TO_RECONCILE' },
    });
  }
  assert.equal((await close(selection)).status, 400);
  assert.equal((await close({ ...selection, confirmed: 'true' })).status, 400);
  await request('strategy/futures?q=IMOEXF');
  const save = () =>
    request('strategy', 'PUT', {
      ...selection,
      instrumentUid: 'contract-b',
      emaPeriod: 34,
      lots: 2,
      timeframe: '15m',
    });
  const create = () => request('sandbox/accounts', 'POST');
  const select = () =>
    request('strategy/selection', 'PUT', { accountId: 'existing', kind: 'improved-surfing' });
  const beforeSelection = (await request('strategy/profiles')).body;
  assert.equal((await request('robot/start', 'POST')).status, 204);
  for (const attempt of [save, create, select, () => close({ ...selection, confirmed: true })]) {
    assert.deepEqual(await attempt(), { status: 409, body: { code: 'ROBOT_BUSY' } });
  }
  assert.deepEqual((await request('strategy/profiles')).body, beforeSelection);
  await request('robot/stop', 'POST');
  unresolved = true;
  assert.deepEqual(await select(), { status: 409, body: { code: 'ROBOT_ORDER_UNRESOLVED' } });
  assert.deepEqual((await request('strategy/profiles')).body, beforeSelection);
  unresolved = false;
  for (const [actual, code] of [
    [2, 'SANDBOX_ACCOUNT_NOT_FLAT'],
    [null, 'SANDBOX_ACCOUNT_FLAT_UNVERIFIED'],
  ] as const) {
    position = actual;
    for (const attempt of [save, create])
      assert.deepEqual(await attempt(), { status: 409, body: { code } });
  }
  assert.equal(settings, null);
  assert.equal((await request('sandbox')).body.accountId, 'existing');
  position = 0;
  assert.equal((await close({ ...selection, confirmed: true })).status, 204);
  assert.equal((await save()).status, 204);
  assert.equal((await create()).status, 204);
});

test('replacing unusable credentials for a restarted order is allowed only for its original account', async (t) => {
  let saved = { encryptedToken: 'unreadable', accountId: 'existing' };
  const { broker } = fakeBroker();
  broker.accounts = async (candidate) =>
    candidate === token ? [{ id: 'existing', name: 'Existing' }] : [{ id: 'other', name: 'Other' }];
  const sandbox = new SandboxConnection(
    {
      async load() {
        return saved;
      },
      async save(connection) {
        assert.ok(connection.accountId);
        saved = { ...connection, accountId: connection.accountId };
      },
    },
    cipher,
    broker,
  );
  const order: JournalEntry = {
    id: 'original',
    accountId: 'existing',
    instrumentUid: 'contract-a',
    ticker: 'IMOEXF',
    action: 'manual-close',
    manualCloseTime: 1,
    candleTime: null,
    signalTime: null,
    signalPrice: null,
    ema: null,
    timeframe: '1h',
    direction: 'sell',
    lots: 1,
    fromPosition: 1,
    targetPosition: 0,
    status: 'reserved',
    brokerOrderId: null,
    brokerStatus: 'unknown',
    executedLots: null,
    executions: [],
    position: null,
  };
  let lookups = 0;
  const robot = new Robot(
    {
      async verifySelection() {},
      async accountState() {
        return { position: 0, activeOrders: false };
      },
      async submit() {
        assert.fail('No submission expected');
      },
      async orderState(candidate, intent, brokerId) {
        assert.equal(candidate, token);
        assert.equal(intent.id, order.id);
        assert.equal(brokerId, null);
        lookups++;
        return {
          brokerOrderId: 'broker-id',
          brokerStatus: 'filled',
          executedLots: 1,
          executions: [{ tradeId: 'fill', lots: 1, price: 100, time: 2 }],
        };
      },
    },
    {
      async hasUnresolved() {
        return order.status === 'reserved';
      },
      async unresolved() {
        return { ...order, context: { type: 'manual-close', time: 1 } };
      },
      async history() {
        return [order];
      },
      async reserve() {
        assert.fail('No reservation expected');
      },
      async record(_id, result) {
        Object.assign(order, result);
      },
    },
    {
      async subscribe() {
        assert.fail('Must stay stopped');
      },
    },
    async () => ({
      ...(await sandbox.tradingCredentials()),
      instrumentUid: 'contract-a',
      ticker: 'IMOEXF',
      emaPeriod: 55,
      lots: 1,
      timeframe: '1h',
    }),
    Date.now,
    (history, options, config) => surfingStrategy.live(history, options, config),
  );
  await robot.restore();
  assert.equal(lookups, 0);
  const { request } = await serve(t, sandbox, undefined, robot);
  await request('auth/login', 'POST', { password });
  assert.equal(
    (await request('sandbox/connection', 'PUT', { token: 'wrong-account' })).status,
    422,
  );
  assert.equal(saved.encryptedToken, 'unreadable');
  assert.equal((await request('sandbox/connection', 'PUT', { token })).status, 204);
  assert.equal(saved.accountId, 'existing');
  assert.equal((await request('robot/start', 'POST')).body.code, 'ROBOT_ORDER_UNRESOLVED');
  assert.equal((await request('sandbox/account', 'PUT', { accountId: 'other' })).status, 409);
  assert.equal((await request('robot/reconcile', 'POST')).status, 204);
  assert.deepEqual(robot.status().recovery, { orderId: order.id, ready: true });
  assert.equal(lookups, 1);
});

test('changing the selected account requires a flat broker account, even when creating an account or replacing a token', async (t) => {
  let saved: Awaited<ReturnType<SandboxStore['load']>> = {
    encryptedToken: cipher.encrypt(token),
    accountId: 'current',
  };
  const store: SandboxStore = {
    async load() {
      return saved;
    },
    async save(record) {
      saved = record;
    },
  };
  const { broker } = fakeBroker();
  const other = { id: 'other', name: 'Other' };
  const replacementToken = 'replacement-token';
  const accounts = [other, { id: 'current', name: 'Current' }];
  broker.accounts = async (candidate) => (candidate === replacementToken ? [other] : accounts);
  let flat: boolean | null = false;
  const flatCheck = t.mock.method(
    broker,
    'accountIsFlat',
    async (candidate: string, accountId: string) => {
      assert.equal(candidate, token, 'flatness must be checked using the existing credentials');
      assert.ok(accountId === saved?.accountId || accountId === 'other');
      return flat;
    },
  );
  const openAccount = t.mock.method(broker, 'openAccount');
  const { request } = await serve(t, new SandboxConnection(store, cipher, broker));
  await request('auth/login', 'POST', { password });

  const select = () => request('sandbox/account', 'PUT', { accountId: 'other' });
  const create = () => request('sandbox/accounts', 'POST');
  const replace = () => request('sandbox/connection', 'PUT', { token: replacementToken });
  const original = saved;
  for (const operation of [select, create]) {
    assert.deepEqual(await operation(), {
      status: 409,
      body: { code: 'SANDBOX_ACCOUNT_NOT_FLAT' },
    });
  }
  assert.deepEqual(await replace(), {
    status: 422,
    body: { code: 'SANDBOX_ACCOUNT_UNAVAILABLE' },
  });
  assert.equal(flatCheck.mock.callCount(), 2);
  assert.equal(openAccount.mock.callCount(), 0);
  assert.deepEqual(saved, original);

  flat = null;
  assert.deepEqual(await select(), {
    status: 409,
    body: { code: 'SANDBOX_ACCOUNT_FLAT_UNVERIFIED' },
  });
  assert.deepEqual(saved, original);
  flat = true;
  assert.equal((await select()).status, 204);
  assert.equal((await store.load())?.accountId, 'other');
  flat = null;
  assert.equal(
    (await replace()).status,
    204,
    'same-account credentials can be restored without the old token',
  );
  assert.equal(cipher.decrypt((await store.load())!.encryptedToken), replacementToken);
});

test('unexpected broker details are not returned to the owner or logged', async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const store: SandboxStore = {
    async load() {
      return null;
    },
    async save() {
      assert.fail('Do not save an unverified token');
    },
  };
  const { broker } = fakeBroker();
  broker.accounts = async () => {
    throw new Error(`SDK error: ${token}`);
  };
  const { request } = await serve(t, new SandboxConnection(store, cipher, broker));
  await request('auth/login', 'POST', { password });
  assert.deepEqual(await request('sandbox/connection', 'PUT', { token }), {
    status: 502,
    body: { code: 'SANDBOX_UNREACHABLE' },
  });
  assert.equal(logged.mock.callCount(), 0);
});

test('strategy saving uses offered contracts without fetching the broker catalogue again', async (t) => {
  let connection: Awaited<ReturnType<SandboxStore['load']>> = null;
  const store: SandboxStore = {
    async load() {
      return connection;
    },
    async save(record) {
      connection = record;
    },
  };
  let settings: Awaited<ReturnType<StrategyStore['load']>> = null;
  let improved: Awaited<ReturnType<StrategyStore['loadImproved']>> = null;
  let selected: 'surfing' | 'improved-surfing' = 'surfing';
  const strategyStore: StrategyStore = {
    async load() {
      return settings;
    },
    async save(record) {
      settings = record;
    },
    async loadImproved() {
      return improved;
    },
    async saveImproved(value) {
      improved = value;
    },
    async selected() {
      return selected;
    },
    async select(value) {
      selected = value;
    },
    async legacyClaimAvailable() {
      return false;
    },
    async claimLegacy() {},
  };
  const { broker } = fakeBroker();
  let flat: boolean | null = true;
  broker.accountIsFlat = async () => flat;
  const listFutures = broker.futures;
  let catalogueAvailable = true;
  const catalogue = t.mock.method(broker, 'futures', async (candidate: string) => {
    if (!catalogueAvailable) throw new Error('The catalogue is unavailable');
    return listFutures(candidate);
  });
  const sandbox = new SandboxConnection(store, cipher, broker);
  const strategy = new StrategySettings(strategyStore, sandbox);
  const { request } = await serve(t, sandbox, strategy);
  const config = {
    accountId: 'existing',
    instrumentUid: 'contract-b',
    emaPeriod: 55,
    lots: 3,
    timeframe: '15m',
  };
  const put = (body: object) => request('strategy', 'PUT', body);
  assert.equal((await request('strategy')).status, 401);
  assert.equal((await request('strategy/futures?q=IMOEXF')).status, 401);
  assert.equal((await put(config)).status, 401);
  await request('auth/login', 'POST', { password });
  assert.deepEqual((await request('strategy')).body, {
    defaults: { ticker: 'IMOEXF', emaPeriod: 55, timeframe: '1h' },
    settings: null,
  });
  await request('sandbox/connection', 'PUT', { token });
  assert.equal((await put(config)).status, 422);
  await request('sandbox/account', 'PUT', { accountId: 'existing' });
  assert.deepEqual(await put(config), { status: 409, body: { code: 'FUTURE_SELECTION_EXPIRED' } });
  const narrowSearch = `strategy/futures?q=${encodeURIComponent('мосбиржи')}`;
  assert.equal((await request(narrowSearch)).body.length, 1);
  assert.deepEqual(await put(config), { status: 422, body: { code: 'FUTURE_UNAVAILABLE' } });
  assert.equal(catalogue.mock.callCount(), 1);
  const matches = (await request('strategy/futures?q=imoexf')).body;
  assert.deepEqual(
    matches.map(({ uid }: { uid: string }) => uid),
    ['contract-a', 'contract-b'],
  );
  assert.equal(matches[1].expirationDate, futures[1].expirationDate);
  assert.deepEqual((await request(narrowSearch)).body, [matches[0]]);
  for (const invalid of [0, -1, 1.5, '3', 2 ** 31]) {
    assert.equal((await put({ ...config, emaPeriod: invalid })).status, 400);
    assert.equal((await put({ ...config, lots: invalid })).status, 400);
  }
  for (const timeframe of [undefined, null, 15, '1d', 'constructor']) {
    assert.equal((await put({ ...config, timeframe })).status, 400);
  }
  assert.equal((await put({ ...config, kind: 'unknown' })).status, 400);
  assert.equal((await put({ ...config, kind: 'surfing', parameters: { lots: 3 } })).status, 400);
  assert.equal(
    (await put({ ...config, kind: 'surfing', parameters: { emaPeriod: 55, lots: 3, extra: 1 } }))
      .status,
    400,
  );
  for (const instrumentUid of ['IMOEXF', 'unknown', 'unavailable']) {
    assert.equal((await put({ ...config, instrumentUid })).status, 422);
  }
  assert.equal((await put({ ...config, accountId: 'other' })).status, 422);
  assert.equal(settings, null);
  catalogueAvailable = false;
  assert.equal((await put(config)).status, 204);
  assert.equal(
    (await put({ ...config, parameters: { emaPeriod: 0, lots: 0 } })).status,
    204,
    'Legacy requests use flat values even when an unrelated parameters field is present',
  );
  assert.equal(
    (await put({ ...config, kind: 'surfing', parameters: { emaPeriod: 55, lots: 3 } })).status,
    204,
  );
  assert.equal(catalogue.mock.callCount(), 3);
  const parameters = {
    emaPeriod: 55,
    atrPeriod: 20,
    stopAtrMultiplier: 2,
    addStepAtr: 1,
    maxAddOns: 0,
    tradeWeekends: false,
  };
  const improvedRequest = {
    accountId: 'existing',
    instrumentUid: 'contract-b',
    timeframe: '1h',
    kind: 'improved-surfing',
    parameters,
  };
  for (const [field, value] of Object.entries({
    emaPeriod: 0,
    atrPeriod: 0,
    stopAtrMultiplier: 0,
    addStepAtr: -1,
    maxAddOns: -1,
    tradeWeekends: 'false',
  })) {
    assert.equal(
      (await put({ ...improvedRequest, parameters: { ...parameters, [field]: value } })).status,
      400,
    );
  }
  assert.equal((await put({ ...improvedRequest, instrumentUid: 'unknown' })).status, 422);
  assert.equal((await put(improvedRequest)).status, 204);
  assert.equal((await request('strategy/profiles')).body.selected, 'surfing');
  assert.deepEqual(
    (await request('strategy/profiles')).body.profiles['improved-surfing'].settings.parameters,
    parameters,
  );
  flat = false;
  const select = (accountId: string) =>
    request('strategy/selection', 'PUT', { accountId, kind: 'improved-surfing' });
  const before = (await request('strategy/profiles')).body;
  assert.deepEqual(await select('existing'), {
    status: 409,
    body: { code: 'SANDBOX_ACCOUNT_NOT_FLAT' },
  });
  assert.deepEqual((await request('strategy/profiles')).body, before);
  flat = null;
  assert.deepEqual(await select('existing'), {
    status: 409,
    body: { code: 'SANDBOX_ACCOUNT_FLAT_UNVERIFIED' },
  });
  assert.deepEqual((await request('strategy/profiles')).body, before);
  assert.deepEqual(await select('stale'), {
    status: 422,
    body: { code: 'SANDBOX_ACCOUNT_UNAVAILABLE' },
  });
  assert.deepEqual((await request('strategy/profiles')).body, before);
  flat = true;
  assert.equal(
    (
      await request('strategy/selection', 'PUT', {
        accountId: 'existing',
        kind: 'improved-surfing',
      })
    ).status,
    204,
  );
  assert.equal((await request('strategy/profiles')).body.selected, 'improved-surfing');
  assert.deepEqual((await strategy.selectedProfile())?.parameters, parameters);
  improved = null;
  assert.equal(
    await strategy.selectedProfile(),
    null,
    'Missing selected profile must not fall back',
  );
  improved = { instrument: matches[1], kind: 'improved-surfing', parameters, timeframe: '1h' };
  assert.equal((await request('strategy')).body.settings.lots, 3);
  assert.equal(catalogue.mock.callCount(), 3);

  assert.equal((await put({ ...config, lots: 0 })).status, 400);
  assert.equal((await request('sandbox/connection', 'PUT', { token })).status, 204);
  assert.deepEqual(await put(config), { status: 409, body: { code: 'FUTURE_SELECTION_EXPIRED' } });
  await request('sandbox/accounts', 'POST');
  assert.equal(
    (await put({ ...config, lots: 9 })).status,
    422,
    'A stale account cannot save over the settings',
  );
  assert.deepEqual((await request('strategy')).body.settings, {
    instrument: matches[1],
    emaPeriod: 55,
    lots: 3,
    timeframe: '15m',
  });
  const stored = await strategyStore.load();
  assert.ok(stored);
  assert.deepEqual(stored.parameters, { emaPeriod: 55, lots: 3 });
  assert.equal('emaPeriod' in stored, false);
  assert.equal('lots' in stored, false);
  settings = { ...stored, parameters: { emaPeriod: 0, lots: 3 } };
  await assert.rejects(strategy.get(), /Invalid saved strategy settings/);
});
