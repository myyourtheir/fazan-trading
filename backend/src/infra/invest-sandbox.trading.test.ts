import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { NodeApiClient } from '@ttech-pub/grpc-node-client';
import {
  OrderDirection,
  OrderExecutionReportStatus,
  OrderIdType,
  OrderType,
} from '@ttech-pub/grpc-node-client/compiled/orders.js';
import { ClientError, Status } from 'nice-grpc';
import type { MarketHistory, MarketUpdate } from '../core/market-data.js';
import { timeframeMs } from '../core/timeframe.js';
import { Robot, type OrderIntent, type TradingConfig } from '../core/robot.js';
import { InvestSandbox } from './invest-sandbox.js';
import { connectToPostgres, migrateDatabase, PostgresTradingStore } from './postgres.js';

const intent = {
  id: randomUUID(),
  accountId: 'test-account',
  instrumentUid: 'test-future',
  ticker: 'TEST',
  candleTime: Date.UTC(2026, 10, 18, 12),
  signalTime: Date.UTC(2026, 10, 18, 13),
  timeframe: '1h',
  action: 'ema-crossing',
  manualCloseTime: null,
  signalPrice: 101,
  ema: 100,
  direction: 'sell',
  lots: 1,
  fromPosition: 0,
  targetPosition: -1,
} satisfies OrderIntent;

test('SDK posts a sandbox market order with the saved client ID and maps actual fill data', async (t) => {
  const fillTime = new Date(intent.signalTime + 3_000);
  const requestIds: string[] = [];
  t.mock.method(NodeApiClient, 'create', async ({ url }: { url: string }) => {
    assert.equal(url, 'https://sandbox-invest-public-api.tbank.ru:443');
    return {
      sandbox: {
        async postSandboxOrder(request: {
          orderId: string;
          instrumentId: string;
          accountId: string;
          direction: OrderDirection;
          orderType: OrderType;
          quantity: number;
          confirmMarginTrade: boolean;
        }) {
          assert.equal(request.instrumentId, intent.instrumentUid);
          assert.equal(request.accountId, intent.accountId);
          assert.equal(request.orderId, intent.id);
          assert.equal(request.orderType, OrderType.ORDER_TYPE_MARKET);
          assert.equal(request.direction, OrderDirection.ORDER_DIRECTION_SELL);
          assert.equal(request.quantity, intent.lots);
          assert.equal(request.confirmMarginTrade, true);
          return {
            orderId: 'exchange-id',
            lotsExecuted: 1,
            executionReportStatus: OrderExecutionReportStatus.EXECUTION_REPORT_STATUS_FILL,
          };
        },
        async getSandboxOrderState(request: { orderId: string; orderIdType: OrderIdType }) {
          requestIds.push(request.orderId);
          assert.equal(
            request.orderIdType,
            request.orderId === intent.id
              ? OrderIdType.ORDER_ID_TYPE_REQUEST
              : OrderIdType.ORDER_ID_TYPE_EXCHANGE,
          );
          return {
            orderId: 'exchange-id',
            orderRequestId: intent.id,
            instrumentUid: intent.instrumentUid,
            direction: OrderDirection.ORDER_DIRECTION_SELL,
            lotsRequested: 1,
            lotsExecuted: 1,
            executionReportStatus: OrderExecutionReportStatus.EXECUTION_REPORT_STATUS_FILL,
            stages: [
              {
                tradeId: 'fill',
                quantity: 1,
                price: { units: 98, nano: 500_000_000 },
                executionTime: fillTime,
              },
            ],
          };
        },
      },
    } as unknown as NodeApiClient;
  });
  const broker = new InvestSandbox();
  const posted = await broker.submit('fake', intent);
  const state = await broker.orderState('fake', intent, posted.brokerOrderId);
  assert.deepEqual(await broker.orderState('fake', intent, null), state);
  assert.deepEqual(requestIds, ['exchange-id', intent.id]);
  assert.deepEqual(state.executions, [
    { tradeId: 'fill', lots: 1, price: 98.5, time: fillTime.getTime() },
  ]);
});

test('SDK reports a post validation rejection without treating ambiguous RPC failures as rejection', async (t) => {
  let code = Status.INVALID_ARGUMENT;
  t.mock.method(
    NodeApiClient,
    'create',
    async () =>
      ({
        sandbox: {
          async postSandboxOrder() {
            throw new ClientError('/SandboxService/PostSandboxOrder', code, 'broker error');
          },
        },
      }) as unknown as NodeApiClient,
  );
  const broker = new InvestSandbox();
  assert.deepEqual(await broker.submit('fake', intent), {
    brokerOrderId: null,
    brokerStatus: 'rejected',
    executedLots: 0,
  });
  code = Status.DEADLINE_EXCEEDED;
  await assert.rejects(broker.submit('fake', intent), { message: 'SANDBOX_UNREACHABLE' });
  code = Status.ALREADY_EXISTS;
  await assert.rejects(broker.submit('fake', intent), { message: 'SANDBOX_OPERATION_REJECTED' });
});

test('SDK position check does not mistake a blocked or unidentified balance for a flat position', async (t) => {
  let futures = [{ instrumentUid: intent.instrumentUid, balance: 0, blocked: 1 }];
  t.mock.method(
    NodeApiClient,
    'create',
    async () =>
      ({
        sandbox: {
          async getSandboxOrders() {
            return { orders: [] };
          },
          async getSandboxPositions() {
            return { limitsLoadingInProgress: false, futures };
          },
        },
      }) as unknown as NodeApiClient,
  );
  const broker = new InvestSandbox();
  const { accountId, instrumentUid, ticker, lots } = intent;
  const config: TradingConfig = {
    accountId,
    instrumentUid,
    ticker,
    lots,
    token: 'fake',
    emaPeriod: 55,
    timeframe: '1h',
  };
  assert.deepEqual(await broker.accountState(config), { position: null, activeOrders: true });
  futures = [{ instrumentUid: '', balance: 1, blocked: 0 }];
  assert.deepEqual(await broker.accountState(config), { position: null, activeOrders: false });
  futures = [{ instrumentUid: intent.instrumentUid, balance: -2, blocked: 0 }];
  assert.deepEqual(await broker.accountState(config), { position: -2, activeOrders: false });
});

test('SDK reads RUB cash without adding blocked balances or treating missing data as zero', async (t) => {
  const dollars = { currency: 'usd', units: 5, nano: 0 };
  let money = [dollars, { currency: 'RUB', units: 123, nano: 250_000_000 }];
  let limitsLoadingInProgress = false;
  t.mock.method(
    NodeApiClient,
    'create',
    async () =>
      ({
        sandbox: {
          async getSandboxPositions({ accountId }: { accountId: string }) {
            assert.equal(accountId, intent.accountId);
            return {
              limitsLoadingInProgress,
              money,
              blocked: [{ currency: 'rub', units: 100, nano: 0 }],
            };
          },
        },
      }) as unknown as NodeApiClient,
  );
  const broker = new InvestSandbox();
  const balance = () => broker.balanceRubles('fake', intent.accountId);
  assert.equal(await balance(), 123.25);
  money = [dollars, { currency: 'rub', units: 0, nano: 0 }];
  assert.equal(await balance(), 0);
  limitsLoadingInProgress = true;
  assert.equal(await balance(), null);
  limitsLoadingInProgress = false;
  money = [dollars];
  assert.equal(await balance(), null);
});

test('SDK checks the entire current account for positions and active orders before switching', async (t) => {
  let orders: object[] = [];
  let futures: { balance: number; blocked: number }[] = [];
  let limitsLoadingInProgress = false;
  t.mock.method(
    NodeApiClient,
    'create',
    async () =>
      ({
        sandbox: {
          async getSandboxOrders() {
            return { orders };
          },
          async getSandboxPositions() {
            return { limitsLoadingInProgress, futures, securities: [], options: [] };
          },
        },
      }) as unknown as NodeApiClient,
  );
  const broker = new InvestSandbox();
  const flat = () => broker.accountIsFlat('fake', intent.accountId);
  assert.equal(await flat(), true);
  orders = [{}];
  assert.equal(await flat(), false);
  orders = [];
  limitsLoadingInProgress = true;
  assert.equal(await flat(), null);
  limitsLoadingInProgress = false;
  futures = [{ balance: 0, blocked: 1 }];
  assert.equal(await flat(), false);
  futures = [
    { balance: -1, blocked: 0 },
    { balance: 1, blocked: 0 },
  ];
  assert.equal(await flat(), false, 'positions do not cancel across instruments');
});

const {
  SERFING_TEST_DATABASE_URL: database,
  SERFING_TEST_SANDBOX_TOKEN: token,
  SERFING_TEST_FUTURE_UID: instrumentUid,
  SERFING_TEST_SANDBOX_ACCOUNT_ID: accountId,
  SERFING_TEST_PLACE_SANDBOX_ORDER: placeOrder,
} = process.env;

test(
  'explicit sandbox smoke: sends one virtual market order and saves broker fills in PostgreSQL',
  {
    skip: placeOrder !== 'yes',
    timeout: 60_000,
  },
  async () => {
    assert.ok(
      database && token && instrumentUid && accountId,
      'Set the test database, sandbox token, active future UID and dedicated sandbox account ID.',
    );
    const { db, close } = connectToPostgres(database);
    const broker = new InvestSandbox();
    let listener: ((update: MarketUpdate) => void) | undefined;
    // Deterministic candle input isolates the SDK order/fill contract from the live EMA crossing.
    const hourMs = timeframeMs['1h'];
    const opening = Math.floor(Date.now() / hourMs) * hourMs;
    let now = opening + hourMs / 2;
    const config: TradingConfig = {
      token,
      accountId,
      instrumentUid,
      ticker: 'SMOKE',
      emaPeriod: 5,
      lots: 1,
      timeframe: '1h',
    };
    const store = new PostgresTradingStore(db);
    const robot = new Robot(
      broker,
      store,
      {
        async subscribe(callback) {
          listener = callback;
          return () => {
            listener = undefined;
          };
        },
      },
      async () => config,
      () => now,
    );
    try {
      await migrateDatabase(db);
      const candle = (time: number, close: number): MarketHistory['candles'][number] => ({
        time,
        open: close,
        high: close,
        low: close,
        close,
        complete: true,
        confirmedEma: 100,
        previewEma: null,
      });
      await robot.start();
      const baseline = candle(opening - hourMs, 99);
      const selection = { instrumentUid, emaPeriod: config.emaPeriod, timeframe: config.timeframe };
      listener?.({ stream: 'live', history: { ...selection, candles: [baseline] } });
      now = opening + hourMs + 1;
      listener?.({
        stream: 'live',
        history: { ...selection, candles: [baseline, candle(opening, 101)] },
      });
      for (let attempt = 0; attempt < 80; attempt++) {
        const row = (await store.history()).find(
          (entry) =>
            entry.accountId === accountId &&
            entry.instrumentUid === instrumentUid &&
            entry.candleTime === opening,
        );
        if (row && row.status !== 'reserved') {
          assert.equal(
            row.status,
            'confirmed',
            `Sandbox status: ${row.brokerStatus}, client ID: ${row.id}`,
          );
          assert.equal(row.position, 1);
          assert.equal(row.executedLots, 1);
          assert.ok(row.executions.some((fill) => fill.price !== null && fill.time !== null));
          return;
        }
        await delay(500);
      }
      assert.fail(
        'Settlement not observed; inspect the journal and sandbox account before retrying.',
      );
    } finally {
      await robot.shutdown();
      await close();
    }
  },
);
