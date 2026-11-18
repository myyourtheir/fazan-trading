import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { hourMs } from '../core/market-data.js';
import type { OrderIntent } from '../core/robot.js';
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

test('PostgreSQL preserves separate orders and executions and rejects duplicate reservations', { skip: !testDatabase }, async () => {
  assert.ok(testDatabase);
  const order: OrderIntent = {
    id: randomUUID(), accountId: `test-${randomUUID()}`, instrumentUid: 'test-future', ticker: 'TEST',
    candleTime: Date.UTC(2026, 10, 18, 12), signalTime: Date.UTC(2026, 10, 18, 13),
    signalPrice: 101, ema: 100, direction: 'sell', lots: 1, fromPosition: 0, targetPosition: -1,
  };
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
  } finally {
    await first.close();
  }
  const second = connectToPostgres(testDatabase);
  try {
    const store = new PostgresTradingStore(second.db);
    assert.deepEqual(await store.history(order.accountId), [{ ...order, ...result }]);
    assert.deepEqual(await store.history(`test-${randomUUID()}`), []);
  } finally {
    await second.close();
  }
});
