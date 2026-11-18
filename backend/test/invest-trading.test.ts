import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { NodeApiClient } from '@ttech-pub/grpc-node-client';
import {
  OrderDirection, OrderExecutionReportStatus, OrderIdType, OrderType,
} from '@ttech-pub/grpc-node-client/compiled/orders.js';
import { InvestSandbox } from '../src/invest-sandbox.js';
import { hourMs, type MarketHistory, type MarketUpdate } from '../src/market-data.js';
import { connectToPostgres, migrateDatabase, PostgresTradingStore } from '../src/postgres.js';
import { Robot, type OrderIntent, type TradingConfig } from '../src/robot.js';

const intent: OrderIntent = {
  id: randomUUID(), accountId: 'test-account', instrumentUid: 'test-future', ticker: 'TEST',
  candleTime: Date.UTC(2026, 10, 18, 12), signalTime: Date.UTC(2026, 10, 18, 13),
  signalPrice: 101, ema: 100, direction: 'sell', lots: 1, fromPosition: 0, targetPosition: -1,
};

test('SDK posts a sandbox market order with the saved client ID and maps actual fill data', async t => {
  const fillTime = new Date(intent.signalTime + 3_000);
  const requestIds: string[] = [];
  t.mock.method(NodeApiClient, 'create', async ({ url }: { url: string }) => {
    assert.equal(url, 'https://sandbox-invest-public-api.tbank.ru:443');
    return {
      sandbox: {
        async postSandboxOrder(request: { orderId: string; instrumentId: string; accountId: string;
          direction: OrderDirection; orderType: OrderType; quantity: number; confirmMarginTrade: boolean }) {
          assert.equal(request.instrumentId, intent.instrumentUid);
          assert.equal(request.accountId, intent.accountId);
          assert.equal(request.orderId, intent.id);
          assert.equal(request.orderType, OrderType.ORDER_TYPE_MARKET);
          assert.equal(request.direction, OrderDirection.ORDER_DIRECTION_SELL);
          assert.equal(request.quantity, intent.lots);
          assert.equal(request.confirmMarginTrade, true);
          return { orderId: 'exchange-id', lotsExecuted: 1,
            executionReportStatus: OrderExecutionReportStatus.EXECUTION_REPORT_STATUS_FILL };
        },
        async getSandboxOrderState(request: { orderId: string; orderIdType: OrderIdType }) {
          requestIds.push(request.orderId);
          assert.equal(request.orderIdType, request.orderId === intent.id
            ? OrderIdType.ORDER_ID_TYPE_REQUEST : OrderIdType.ORDER_ID_TYPE_EXCHANGE);
          return { orderId: 'exchange-id', orderRequestId: intent.id, instrumentUid: intent.instrumentUid,
            direction: OrderDirection.ORDER_DIRECTION_SELL, lotsRequested: 1, lotsExecuted: 1,
            executionReportStatus: OrderExecutionReportStatus.EXECUTION_REPORT_STATUS_FILL,
            stages: [{ tradeId: 'fill', quantity: 1, price: { units: 98, nano: 500_000_000 }, executionTime: fillTime }] };
        },
      },
    } as unknown as NodeApiClient;
  });
  const broker = new InvestSandbox();
  const posted = await broker.submit('fake', intent);
  const state = await broker.orderState('fake', intent, posted.brokerOrderId);
  assert.deepEqual(await broker.orderState('fake', intent, null), state);
  assert.deepEqual(requestIds, ['exchange-id', intent.id]);
  assert.deepEqual(state.executions, [{ tradeId: 'fill', lots: 1, price: 98.5, time: fillTime.getTime() }]);
});

const { SERFING_TEST_DATABASE_URL: database, SERFING_TEST_SANDBOX_TOKEN: token,
  SERFING_TEST_FUTURE_UID: instrumentUid, SERFING_TEST_SANDBOX_ACCOUNT_ID: accountId,
  SERFING_TEST_PLACE_SANDBOX_ORDER: placeOrder } = process.env;

test('PostgreSQL preserves separate orders and executions and rejects duplicate reservations', { skip: !database }, async () => {
  assert.ok(database);
  const order = { ...intent, accountId: `test-${randomUUID()}` };
  const result = { status: 'confirmed', brokerOrderId: 'exchange-id', brokerStatus: 'filled', executedLots: 1, position: -1,
    executions: [{ tradeId: 'fill', lots: 1, price: 98.5, time: intent.signalTime + 3_000 }] } as const;
  const first = connectToPostgres(database);
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
  const second = connectToPostgres(database);
  try {
    const journal = await new PostgresTradingStore(second.db).history();
    assert.deepEqual(journal.find(entry => entry.id === order.id), { ...order, ...result });
  } finally {
    await second.close();
  }
});

test('explicit sandbox smoke: sends one virtual market order and saves broker fills in PostgreSQL', {
  skip: placeOrder !== 'yes', timeout: 60_000,
}, async () => {
  assert.ok(database && token && instrumentUid && accountId,
    'Set the test database, sandbox token, active future UID and dedicated sandbox account ID.');
  const { db, close } = connectToPostgres(database);
  const broker = new InvestSandbox();
  let listener: ((update: MarketUpdate) => void) | undefined;
  // Deterministic candle input isolates the SDK order/fill contract from the live EMA crossing.
  const opening = Math.floor(Date.now() / hourMs) * hourMs;
  let now = opening + hourMs / 2;
  const config: TradingConfig = { token, accountId, instrumentUid, ticker: 'SMOKE', emaPeriod: 5, lots: 1 };
  const store = new PostgresTradingStore(db);
  const robot = new Robot(broker, store, {
    async subscribe(callback) { listener = callback; return () => { listener = undefined; }; },
  }, async () => config, () => now);
  try {
    await migrateDatabase(db);
    const candle = (time: number, close: number): MarketHistory['candles'][number] => ({
      time, open: close, high: close, low: close, close, complete: true, confirmedEma: 100, previewEma: null,
    });
    await robot.start();
    const baseline = candle(opening - hourMs, 99);
    const selection = { instrumentUid, emaPeriod: config.emaPeriod };
    listener?.({ stream: 'live', history: { ...selection, candles: [baseline] } });
    now = opening + hourMs + 1;
    listener?.({ stream: 'live', history: { ...selection, candles: [baseline, candle(opening, 101)] } });
    for (let attempt = 0; attempt < 80; attempt++) {
      const row = (await store.history()).find(entry =>
        entry.accountId === accountId && entry.instrumentUid === instrumentUid && entry.candleTime === opening);
      if (row && row.status !== 'reserved') {
        assert.equal(row.status, 'confirmed', `Sandbox status: ${row.brokerStatus}, client ID: ${row.id}`);
        assert.equal(row.position, 1);
        assert.equal(row.executedLots, 1);
        assert.ok(row.executions.some(fill => fill.price !== null && fill.time !== null));
        return;
      }
      await delay(500);
    }
    assert.fail('Settlement not observed; inspect the journal and sandbox account before retrying.');
  } finally {
    await robot.shutdown();
    await close();
  }
});
