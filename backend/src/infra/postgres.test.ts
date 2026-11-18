import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { hourMs, type MarketUpdate } from '../core/market-data.js';
import { Robot, type Broker, type OrderIntent } from '../core/robot.js';
import { SandboxConnection } from '../core/sandbox.js';
import { fakeBroker, token } from '../core/sandbox.test-support.js';
import { StrategySettings } from '../core/strategy-settings.js';
import { connectToPostgres, migrateDatabase, PostgresSandboxConnection, PostgresStrategySettings, PostgresTradingStore } from './postgres.js';
import { TokenCipher } from './token-cipher.js';

const testDatabase = process.env.SERFING_TEST_DATABASE_URL;
const cipher = new TokenCipher('ab'.repeat(32));

test('PostgreSQL restores one active strategy, including the exact contract, without the broker',
  { skip: !testDatabase && 'Requires a disposable PostgreSQL database' }, async () => {
    const first = connectToPostgres(testDatabase);
    const { broker, goOffline } = fakeBroker();
    const encryptedToken = cipher.encrypt(token);
    const sandbox = new SandboxConnection({
      async load() { return { encryptedToken, accountId: 'existing' }; },
      async save() { assert.fail('Unexpected account change'); },
    }, cipher, broker);
    let expected;
    try {
      await migrateDatabase(first.db);
      const service = new StrategySettings(new PostgresStrategySettings(first.db), sandbox);
      await service.search('IMOEXF');
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

test('PostgreSQL preserves separate orders and executions and rejects duplicate reservations', { skip: !testDatabase }, async () => {
  assert.ok(testDatabase);
  const order = {
    id: randomUUID(), accountId: `test-${randomUUID()}`, instrumentUid: 'test-future', ticker: 'TEST',
    candleTime: Date.UTC(2026, 10, 18, 12), signalTime: Date.UTC(2026, 10, 18, 13),
    action: 'ema-crossing', manualCloseTime: null, signalPrice: 101, ema: 100,
    direction: 'sell', lots: 1, fromPosition: 0, targetPosition: -1,
  } satisfies OrderIntent;
  const close = {
    ...order, id: randomUUID(), direction: 'buy', fromPosition: -1, targetPosition: 0,
    action: 'manual-close', candleTime: null, signalTime: null, signalPrice: null, ema: null,
    manualCloseTime: order.signalTime + 4_000,
  } satisfies OrderIntent;
  const result = { status: 'confirmed', brokerOrderId: 'exchange-id', brokerStatus: 'filled', executedLots: 1, position: -1,
    executions: [{ tradeId: 'fill', lots: 1, price: 98.5, time: order.signalTime + 3_000 }] } as const;
  const first = connectToPostgres(testDatabase);
  try {
    await migrateDatabase(first.db);
    const store = new PostgresTradingStore(first.db);
    assert.equal(await store.reserve(order), true);
    assert.equal(await store.hasUnresolved(), true);
    assert.equal(await store.reserve({ ...order, id: randomUUID(), candleTime: order.candleTime + hourMs }), false);
    await store.record(order.id, { ...result, executions: [...result.executions] });
    assert.equal(await store.hasUnresolved(), false);
    assert.equal(await store.reserve({ ...order, id: randomUUID() }), false);
    assert.equal(await store.reserve(close), true);
    await store.record(close.id, { ...result, position: 0, executions: [] });
    const repeat = { ...close, id: randomUUID() };
    assert.equal(await store.reserve(repeat), true, 'manual orders do not share a candle key');
    await store.record(repeat.id, { ...result, position: 0, executions: [] });
  } finally {
    await first.close();
  }
  const second = connectToPostgres(testDatabase);
  try {
    const store = new PostgresTradingStore(second.db);
    const journal = await store.history(order.accountId);
    assert.equal(journal.length, 3);
    assert.deepEqual(journal[2], { ...order, ...result });
    assert.deepEqual(journal.find(row => row.id === close.id), { ...close, ...result, position: 0, executions: [] });
    assert.deepEqual(await store.history(`test-${randomUUID()}`), []);
  } finally {
    await second.close();
  }
});

test('a restarted robot restores persisted settings and the reserved client ID without resending a replay', { skip: !testDatabase }, async () => {
  const { broker: sandboxBroker } = fakeBroker();
  const candleTime = Date.UTC(2026, 10, 18, 12);
  const signalTime = candleTime + hourMs;
  const first = connectToPostgres(testDatabase);
  let original!: OrderIntent;
  try {
    await migrateDatabase(first.db);
    const sandbox = new SandboxConnection(new PostgresSandboxConnection(first.db), cipher, sandboxBroker);
    await sandbox.connect(token);
    await sandbox.selectAccount('existing');
    const strategy = new StrategySettings(new PostgresStrategySettings(first.db), sandbox);
    await strategy.search('IMOEXF');
    await strategy.save({ accountId: 'existing', instrumentUid: 'contract-a', emaPeriod: 34, lots: 2 });
    original = {
      id: randomUUID(), accountId: 'existing', instrumentUid: 'contract-a', ticker: 'IMOEXF',
      action: 'ema-crossing', candleTime, signalTime, signalPrice: 99, ema: 100, manualCloseTime: null,
      direction: 'sell', fromPosition: 0, targetPosition: -2, lots: 2,
    };
    assert.equal(await new PostgresTradingStore(first.db).reserve(original), true);
  } finally {
    await first.close();
  }

  const second = connectToPostgres(testDatabase);
  const sandbox = new SandboxConnection(new PostgresSandboxConnection(second.db), cipher, sandboxBroker);
  const strategy = new StrategySettings(new PostgresStrategySettings(second.db), sandbox);
  const store = new PostgresTradingStore(second.db);
  let listener: ((update: MarketUpdate) => void) | undefined;
  let position = -2;
  let now = signalTime - 1; // Exercise the database guard even if a clock correction makes a replay look fresh.
  const submissions: OrderIntent[] = [];
  const lookups: [string, string | null][] = [];
  const broker: Broker = {
    async verifySelection() {},
    async accountState() { return { position, activeOrders: false }; },
    async submit(_token, order) {
      submissions.push(order);
      position = order.targetPosition;
      return { brokerOrderId: 'new-exchange-id', brokerStatus: 'filled', executedLots: order.lots };
    },
    async orderState(_token, order, id) {
      lookups.push([order.id, id]);
      return { brokerOrderId: id ?? 'recovered-exchange-id', brokerStatus: 'filled', executedLots: order.lots,
        executions: [{ tradeId: 'fill', lots: order.lots, price: 98.5, time: signalTime + 3_000 }] };
    },
  };
  const robot = new Robot(broker, store, {
    async subscribe(callback, config) {
      assert.equal(config?.emaPeriod, 34);
      listener = callback;
      listener({ stream: 'live' });
      return () => { listener = undefined; };
    },
  }, async () => {
    const { settings } = await strategy.get();
    assert.ok(settings);
    return { ...await sandbox.tradingCredentials(), instrumentUid: settings.instrument.uid,
      ticker: settings.instrument.ticker, emaPeriod: settings.emaPeriod, lots: settings.lots };
  }, () => now);
  const replay = (...closes: number[]) => listener?.({ stream: 'live', history: {
    instrumentUid: original.instrumentUid, emaPeriod: 34,
    candles: closes.map((close, index) => ({ time: candleTime + (index - 1) * hourMs,
      close, open: close, high: close, low: close, complete: true, confirmedEma: 100, previewEma: null })),
  } });
  try {
    await robot.restore();
    assert.deepEqual(robot.status(), { mode: 'stopped', reason: null, position: -2,
      recovery: { orderId: original.id, ready: true } });
    assert.equal(listener, undefined);
    assert.equal(submissions.length, 0);
    assert.deepEqual(lookups, [[original.id, null]]);
    const [restored] = await robot.history(original.accountId);
    assert.equal(restored.id, original.id);
    assert.equal(restored.status, 'confirmed');
    assert.equal(restored.executions[0].price, 98.5);
    assert.equal((await strategy.get()).settings?.lots, 2);
    assert.equal(await store.reserve({ ...original, id: randomUUID() }), false);

    await robot.resume();
    now = signalTime;
    replay(99, 101); // A corrected replay would reverse the position if its reservation were not deduplicated.
    await setImmediate();
    await robot.shutdown();
    assert.equal(submissions.length, 0);
    assert.deepEqual(lookups, [[original.id, null]]);
    assert.equal((await robot.history(original.accountId)).length, 1);
  } finally {
    await robot.shutdown();
    await second.close();
  }
});
