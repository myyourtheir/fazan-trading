import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import type { MarketHistory, MarketUpdate } from './market-data.js';
import {
  Robot,
  type Broker,
  type RecoveredOrder,
  type FindSignal,
  type TradingConfig,
  type TradingStore,
} from './robot.js';
import type { JournalEntry } from './journal.js';
import { timeframeMs, type Timeframe } from './timeframe.js';
import { runSurfingBacktest } from './surfing-backtest.js';
import { canTradeSurfing, surfingStrategy } from './surfing-strategy.js';

test('unsafe automated reversal size does not prevent manual close', async () => {
  const largeConfig = { ...config, lots: 1_073_741_824 };
  let position = 1;
  let reserved = false;
  const robot = new Robot(
    {
      async verifySelection() {},
      async accountState() {
        return { position, activeOrders: false };
      },
      async submit(_token, order) {
        assert.equal(reserved, true);
        assert.equal(order.lots, 1);
        position = 0;
        return { brokerOrderId: 'close', brokerStatus: 'filled', executedLots: 1 };
      },
      async orderState() {
        return {
          brokerOrderId: 'close',
          brokerStatus: 'filled',
          executedLots: 1,
          executions: [{ tradeId: 'fill', lots: 1, price: 100, time: 1 }],
        };
      },
    },
    {
      async reserve() {
        reserved = true;
        return true;
      },
      async record() {},
      async hasUnresolved() {
        return false;
      },
      async unresolved() {
        return null;
      },
      async history() {
        return [];
      },
    },
    {
      async subscribe() {
        return () => {};
      },
    },
    async () => largeConfig,
    Date.now,
    (history, options, config) => surfingStrategy.live(history, options, config),
    async () => largeConfig,
    (value) => {
      if (!canTradeSurfing(value)) throw new Error('ROBOT_SETTINGS_INVALID');
    },
  );
  await assert.rejects(robot.start(), /ROBOT_SETTINGS_INVALID/);
  await robot.closePosition({
    accountId: largeConfig.accountId,
    instrumentUid: largeConfig.instrumentUid,
  });
  assert.equal(position, 0);
});

const hourMs = timeframeMs['1h'];
type Candle = MarketHistory['candles'][number];
const config: TradingConfig & { lots: number; emaPeriod: number } = {
  token: 'fake',
  accountId: 'account',
  instrumentUid: 'future',
  ticker: 'FUT',
  emaPeriod: 55,
  lots: 3,
  timeframe: '1h',
};
const opening = Date.UTC(2026, 10, 18, 12);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function candle(
  offset: number,
  close: number,
  confirmedEma: number | null = 100,
  complete = true,
): Candle {
  return {
    time: opening + offset * hourMs,
    open: close,
    high: close,
    low: close,
    close,
    complete,
    confirmedEma,
    previewEma: complete ? null : 100,
  };
}

function setup({
  autoConnect = true,
  timeframe = config.timeframe,
  findSignal = (history, options, config) => surfingStrategy.live(history, options, config),
  lots = config.lots,
}: {
  autoConnect?: boolean;
  timeframe?: Timeframe;
  findSignal?: FindSignal<TradingConfig & { lots: number; emaPeriod: number }>;
  lots?: number;
} = {}) {
  const tradingConfig = { ...config, timeframe, lots };
  const selection = { instrumentUid: config.instrumentUid, emaPeriod: config.emaPeriod, timeframe };
  const interval = timeframeMs[timeframe];
  const entries: (JournalEntry & RecoveredOrder)[] = [];
  const submitted: JournalEntry[] = [];
  const lookups: [string, string | null][] = [];
  let listener: ((update: MarketUpdate) => void) | undefined;
  let reconnecting = false;
  let now = opening + interval / 2;
  let position = 0;
  let activeOrders = false;
  let settingsValid = true;
  const store: TradingStore<JournalEntry> = {
    async reserve(order) {
      if (await store.hasUnresolved()) return false;
      if (
        order.context.type === 'signal' &&
        entries.some(
          (row) =>
            row.candleTime ===
              (order.context.type === 'signal' ? order.context.candleTime : null) &&
            row.timeframe === order.timeframe,
        )
      )
        return false;
      entries.push({
        ...order,
        ...(order.context.type === 'signal'
          ? {
              action: 'ema-crossing' as const,
              candleTime: order.context.candleTime,
              signalTime: order.context.signalTime,
              signalPrice: order.context.strategy.signalPrice as number,
              ema: order.context.strategy.ema as number,
              manualCloseTime: null,
            }
          : {
              action: 'manual-close' as const,
              candleTime: null,
              signalTime: null,
              signalPrice: null,
              ema: null,
              manualCloseTime: order.context.time,
            }),
        status: 'reserved',
        brokerStatus: 'unknown',
        brokerOrderId: null,
        position: null,
        executedLots: null,
        executions: [],
      });
      return true;
    },
    async record(id, result) {
      Object.assign(entries.find((row) => row.id === id)!, result);
    },
    async history() {
      return entries;
    },
    async hasUnresolved() {
      return entries.some((row) => row.status === 'reserved' || row.status === 'unconfirmed');
    },
    async unresolved() {
      return (
        entries.find((row) => row.status === 'reserved' || row.status === 'unconfirmed') ?? null
      );
    },
  };
  const broker: Broker = {
    async verifySelection(selection) {
      assert.deepEqual(selection, tradingConfig);
    },
    async accountState() {
      return { position, activeOrders };
    },
    async submit(token, order) {
      const saved = entries.find((row) => row.id === order.id);
      assert.equal(token, config.token);
      assert.equal(saved?.status, 'reserved', 'The intent must be saved before posting');
      submitted.push({ ...saved! });
      position = order.targetPosition;
      return { brokerOrderId: 'broker-order', brokerStatus: 'filled', executedLots: order.lots };
    },
    async orderState(_token, order, brokerId) {
      lookups.push([order.id, brokerId]);
      return {
        brokerOrderId: 'broker-order',
        brokerStatus: 'filled',
        executedLots: order.lots,
        executions: [{ lots: order.lots, price: 103.25, time: now + 50, tradeId: 'execution-id' }],
      };
    },
  };
  const robot = new Robot(
    broker,
    store,
    {
      async subscribe(callback, pinned) {
        assert.deepEqual(pinned, tradingConfig);
        listener = callback;
        if (autoConnect) listener({ stream: 'live' });
        return () => {
          listener = undefined;
        };
      },
    },
    async () => {
      if (!settingsValid) throw new Error('Invalid saved strategy settings');
      return tradingConfig;
    },
    () => now,
    findSignal,
    async () => tradingConfig,
    (value) => {
      if (!canTradeSurfing(value)) throw new Error('ROBOT_SETTINGS_INVALID');
    },
  );
  async function historyFor(timeframe: Timeframe, ...candles: Candle[]) {
    const recoveredAt = reconnecting ? now : undefined;
    reconnecting = false;
    listener?.({ stream: 'live', recoveredAt, history: { ...selection, timeframe, candles } });
    await setImmediate();
  }
  return {
    robot,
    broker,
    store,
    submitted,
    lookups,
    invalidateSettings: () => {
      settingsValid = false;
    },
    isSubscribed: () => listener !== undefined,
    setNow: (offset: number) => {
      now = opening + offset * interval;
    },
    setAccount: (lots: number, active = false) => {
      position = lots;
      activeOrders = active;
    },
    disconnect: () => {
      reconnecting = true;
      listener?.({ stream: 'disconnected' });
    },
    backfill: (...candles: Candle[]) =>
      listener?.({
        stream: 'connecting',
        history: { ...selection, candles },
      }),
    history: (...candles: Candle[]) => historyFor(timeframe, ...candles),
    historyFor,
  };
}

test('configured live and backtest adapters agree on signal candles and targets', async () => {
  const { robot, submitted, history, setNow } = setup();
  const bars = [candle(-2, 100), candle(-1, 99), candle(0, 101), candle(1, 100), candle(2, 99)];
  const run = (count: number) =>
    runSurfingBacktest({
      parameters: {
        instrumentUid: config.instrumentUid,
        timeframe: '1h',
        emaPeriod: 55,
        lots: 3,
        from: '2026-11-18',
        to: '2026-11-18',
        timeZone: 'UTC',
        commission: 0,
        slippage: 0,
      },
      candles: bars.slice(0, count).map((bar) => ({ ...bar, ema: 100 })),
      contract: { currency: 'rub', priceStep: 1, priceStepAmount: 1, lot: 1 },
      initialState: null,
      cutoff: null,
    });
  await robot.start();
  await history(...bars.slice(0, 2));
  setNow(1);
  await history(...bars.slice(0, 3));
  assert.deepEqual(
    { candleTime: submitted[0].candleTime, targetPosition: submitted[0].targetPosition },
    {
      candleTime: run(3).finalSignal?.candleTime,
      targetPosition: run(3).finalSignal?.targetPosition,
    },
  );
  setNow(3);
  await history(...bars);
  assert.deepEqual(
    { candleTime: submitted[1].candleTime, targetPosition: submitted[1].targetPosition },
    {
      candleTime: run(5).finalSignal?.candleTime,
      targetPosition: run(5).finalSignal?.targetPosition,
    },
  );
  assert.deepEqual(
    submitted.map(({ targetPosition }) => targetPosition),
    [3, -3],
  );
  await robot.shutdown();
});

test('a 15-minute strategy trades at its own close, never on a different timeframe or without confirmed EMA', async () => {
  const { robot, submitted, history, historyFor, setNow } = setup({ timeframe: '15m' });
  const baseline = { ...candle(-1, 99), time: opening - timeframeMs['15m'] };
  const signal = candle(0, 101);
  await robot.start();
  await history(baseline, signal);
  assert.equal(submitted.length, 0, 'The selected interval has not closed');
  setNow(1);
  await historyFor(
    '5m',
    { ...baseline, time: opening },
    { ...signal, time: opening + timeframeMs['5m'] },
  );
  await history(baseline, { ...signal, confirmedEma: null });
  assert.equal(submitted.length, 0, 'Only matching, confirmed EMA can trigger a trade');
  await history(baseline, signal);
  await history(baseline, signal);
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].signalTime, opening + timeframeMs['15m']);
  assert.equal(submitted[0].timeframe, '15m');
});

for (const direction of [1, -1] as const) {
  test(`first crossing opens ${direction > 0 ? 'long' : 'short'} at N lots and records actual execution`, async () => {
    const { robot, submitted, history, setNow } = setup();
    const baseline = candle(-1, 100 - direction);
    const signal = candle(0, 100 + direction);
    await robot.start();
    await history(candle(-2, 100 + direction), baseline);
    assert.equal(submitted.length, 0, 'Backfill cannot trade even if it crosses');
    setNow(1);
    await history(baseline, signal);
    assert.equal(submitted.length, 1);
    const [row] = await robot.history();
    assert.equal(row.status, 'confirmed');
    assert.equal(row.direction, direction > 0 ? 'buy' : 'sell');
    assert.equal(row.lots, 3);
    assert.equal(row.targetPosition, direction * 3);
    assert.equal(row.signalPrice, signal.close);
    assert.equal(row.signalTime, opening + hourMs);
    assert.equal(row.executions[0].price, 103.25);
    assert.equal(row.executions[0].time, opening + hourMs + 50);
    assert.equal(robot.status().position, direction * 3);
    setNow(2);
    await history(baseline, candle(0, 100 + 2 * direction), candle(1, 100 + direction));
    assert.equal(
      submitted.length,
      1,
      'A correction or another close on the same side cannot send an order',
    );
  });

  test(`reverses ${direction > 0 ? 'long to short' : 'short to long'} with one order and journals its fill`, async () => {
    const { robot, submitted, history, setNow } = setup();
    const baseline = candle(-1, 100 - direction);
    const entry = candle(0, 100 + direction);
    const reversal = candle(1, 100 - direction);
    await robot.start();
    setNow(1);
    await history(baseline, entry);
    setNow(2);
    await history(baseline, entry, { ...reversal, confirmedEma: null });
    assert.equal(submitted.length, 1);
    await history(baseline, entry, reversal);
    await history(baseline, entry, reversal);
    setNow(3);
    await history(baseline, entry, reversal, candle(2, 100 - 2 * direction));

    assert.equal(submitted.length, 2);
    const [, row] = await robot.history();
    assert.equal(row.id, submitted[1].id);
    assert.equal(row.direction, direction > 0 ? 'sell' : 'buy');
    assert.equal(row.lots, 6);
    assert.equal(row.fromPosition, direction * 3);
    assert.equal(row.targetPosition, -direction * 3);
    assert.equal(row.position, row.targetPosition);
    assert.equal(row.status, 'confirmed');
    assert.deepEqual(
      row.executions.map((fill) => fill.lots),
      [6],
    );
    assert.equal(robot.status().position, row.targetPosition);
  });
}

async function openLong({ robot, history, setNow }: ReturnType<typeof setup>) {
  await robot.start();
  setNow(1);
  await history(candle(-1, 99), candle(0, 101));
  setNow(2);
}

const closeSelection = { accountId: config.accountId, instrumentUid: config.instrumentUid };

test('stop preserves the position, then manual close uses the current lots and journals no EMA signal', async () => {
  const fixture = setup();
  const { robot, submitted, history, setAccount } = fixture;
  await openLong(fixture);
  await assert.rejects(robot.closePosition(closeSelection), { code: 'ROBOT_BUSY' });
  robot.stop();
  await history(candle(0, 101), candle(1, 99));
  assert.deepEqual(robot.status(), { mode: 'stopped', reason: null, position: 3 });
  assert.equal(submitted.length, 1);

  setAccount(2);
  await robot.closePosition(closeSelection);
  const [, close] = await robot.history();
  assert.equal(submitted.length, 2);
  assert.deepEqual(
    [
      close.action,
      close.candleTime,
      close.signalPrice,
      close.ema,
      close.direction,
      close.lots,
      close.fromPosition,
      close.targetPosition,
    ],
    ['manual-close', null, null, null, 'sell', 2, 2, 0],
  );
  assert.equal(close.status, 'confirmed');
  assert.equal(robot.status().position, 0);
  await robot.closePosition(closeSelection);
  assert.equal(submitted.length, 2, 'already flat, so no order');
});

test('manual closing a short buys only once and is not successful until the broker confirms zero', async () => {
  const { robot, broker, submitted, setAccount } = setup();
  await assert.rejects(robot.closePosition({ ...closeSelection, accountId: 'stale' }), {
    code: 'ROBOT_SELECTION_CHANGED',
  });
  setAccount(-2);
  const gate = deferred();
  const lookup = broker.orderState;
  broker.orderState = async (...args) => {
    await gate.promise;
    setAccount(-1);
    return lookup(...args);
  };
  const closed = assert.rejects(robot.closePosition(closeSelection), {
    code: 'ROBOT_ORDER_UNRESOLVED',
  });
  await setImmediate();
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].direction, 'buy');
  await assert.rejects(robot.closePosition(closeSelection), { code: 'ROBOT_BUSY' });
  await assert.rejects(
    robot.changeSettings(async () => assert.fail('Close pending')),
    { code: 'ROBOT_BUSY' },
  );
  gate.resolve();
  await closed;
  assert.deepEqual(robot.status(), {
    mode: 'paused',
    reason: 'ROBOT_ORDER_POSITION_MISMATCH',
    position: -1,
    recovery: { orderId: submitted[0].id, ready: false },
  });
  assert.equal((await robot.history())[0].status, 'unconfirmed');
  robot.stop();
  await assert.rejects(robot.closePosition(closeSelection), { code: 'ROBOT_ORDER_UNRESOLVED' });
  await assert.rejects(
    robot.changeSettings(async () => assert.fail('Unresolved close')),
    { code: 'ROBOT_ORDER_UNRESOLVED' },
  );
  assert.equal(submitted.length, 1);
});

test('stop leaves a submitted strategy order to reconcile and blocks closing until it settles', async () => {
  const { robot, broker, submitted, history, setNow } = setup();
  const gate = deferred();
  const lookup = broker.orderState;
  broker.orderState = async (...args) => {
    await gate.promise;
    return lookup(...args);
  };
  await robot.start();
  setNow(1);
  await history(candle(-1, 99), candle(0, 101));
  assert.equal(submitted.length, 1);
  robot.stop();
  await assert.rejects(robot.closePosition(closeSelection), { code: 'ROBOT_BUSY' });
  gate.resolve();
  await setImmediate();
  assert.equal((await robot.history())[0].status, 'confirmed');
  assert.deepEqual(robot.status(), { mode: 'stopped', reason: null, position: 3 });
});

test('manual close does not submit a stale position delta after reservation', async () => {
  const { robot, store, submitted, setAccount } = setup();
  setAccount(3);
  const reserve = store.reserve;
  store.reserve = async (order) => {
    const saved = await reserve(order);
    setAccount(1);
    return saved;
  };
  await assert.rejects(robot.closePosition(closeSelection), { code: 'ROBOT_POSITION_CHANGED' });
  assert.equal(submitted.length, 0);
  assert.equal((await robot.history())[0].status, 'account-check-failed-before-send');
  assert.equal(robot.status().position, 1);
});

test('a reversal uses the current broker position and skips a target already reached', async () => {
  const fixture = setup();
  const { robot, history, setNow, setAccount, submitted } = fixture;
  await openLong(fixture);
  setAccount(-3);
  await history(candle(0, 101), candle(1, 99));
  assert.equal(submitted.length, 1);
  assert.equal((await robot.history()).length, 1);
  assert.deepEqual(robot.status(), { mode: 'running', reason: null, position: -3 });

  setNow(3);
  setAccount(-2);
  await history(candle(0, 101), candle(1, 99), candle(2, 101));
  assert.equal(submitted.length, 2);
  assert.equal(submitted[1].fromPosition, -2);
  assert.equal(submitted[1].lots, 5);
  assert.equal(submitted[1].targetPosition, 3);
});

test('active broker orders prevent a reversal', async () => {
  const fixture = setup();
  const { robot, history, setAccount, submitted } = fixture;
  await openLong(fixture);
  setAccount(3, true);
  await history(candle(0, 101), candle(1, 99));
  assert.deepEqual(robot.status(), { mode: 'paused', reason: 'ROBOT_ACTIVE_ORDERS', position: 3 });
  assert.equal(submitted.length, 1);
});

for (const change of ['position', 'active order'] as const) {
  test(`change in ${change} state during reversal reservation prevents submission`, async () => {
    const fixture = setup();
    const { robot, history, setAccount, store, submitted } = fixture;
    await openLong(fixture);
    const gate = deferred();
    const reserve = store.reserve;
    store.reserve = async (order) => {
      const saved = await reserve(order);
      await gate.promise;
      return saved;
    };

    await history(candle(0, 101), candle(1, 99));
    assert.equal((await robot.history())[1].status, 'reserved');
    if (change === 'position') setAccount(-3);
    else setAccount(3, true);
    gate.resolve();
    await setImmediate();

    assert.equal(submitted.length, 1);
    assert.equal((await robot.history())[1].status, 'account-check-failed-before-send');
    assert.equal(await store.hasUnresolved(), false);
    assert.equal(robot.status().mode, 'paused');
    assert.equal(
      robot.status().reason,
      change === 'position' ? 'ROBOT_POSITION_CHANGED' : 'ROBOT_ACTIVE_ORDERS',
    );
  });
}

for (const brokerStatus of ['filled', 'partial'] as const) {
  test(`a ${brokerStatus} reversal without target position pauses trading`, async () => {
    const fixture = setup();
    const { robot, broker, history, setNow, setAccount, submitted } = fixture;
    await openLong(fixture);
    const orderState = broker.orderState;
    const actualPosition = brokerStatus === 'filled' ? 3 : -1;
    broker.orderState = async (...args) => {
      const state = await orderState(...args);
      setAccount(actualPosition);
      return brokerStatus === 'filled'
        ? state
        : {
            ...state,
            brokerStatus,
            executedLots: 4,
            executions: [{ ...state.executions[0], lots: 4 }],
          };
    };

    await history(candle(0, 101), candle(1, 99));
    assert.equal(submitted.length, 2);
    const [, row] = await robot.history();
    assert.equal(row.brokerStatus, brokerStatus);
    assert.equal(row.status, 'unconfirmed');
    assert.equal(row.position, actualPosition);
    assert.deepEqual(robot.status(), {
      mode: 'paused',
      reason: brokerStatus === 'partial' ? 'ROBOT_ORDER_PARTIAL' : 'ROBOT_ORDER_POSITION_MISMATCH',
      position: actualPosition,
      recovery: { orderId: row.id, ready: false },
    });
    setNow(3);
    await history(candle(0, 101), candle(1, 99), candle(2, 101));
    assert.equal(submitted.length, 2);
  });
}

test('ignores intrahour previews and awaits confirmed EMA for the exact closed candle', async () => {
  const { robot, submitted, history, setNow } = setup();
  const baseline = candle(-1, 99);
  await robot.start();
  await history(baseline, candle(0, 101, null, false));
  await history(baseline, candle(0, 101));
  setNow(1);
  await history(baseline, candle(0, 101, null));
  assert.equal(submitted.length, 0);
  setNow(1.25);
  await history(baseline, candle(0, 101));
  assert.equal(submitted.length, 1);
});

test('late historical EMA updates the strict baseline across a historical equality', async () => {
  const { robot, submitted, history, setNow } = setup();
  const older = candle(-3, 99);
  const equal = candle(-1, 100);
  await robot.start();
  await history(older, candle(-2, 101, null), equal);
  setNow(1);
  await history(older, candle(-2, 101, null), equal, candle(0, 101));
  await history(older, candle(-2, 101), equal, candle(0, 101));
  assert.equal(submitted.length, 0, 'Both strict closes were above EMA');
  setNow(2);
  await history(older, candle(-2, 101), equal, candle(0, 101), candle(1, 99));
  assert.equal(submitted[0]?.direction, 'sell');
});

test('awaits a delayed live EMA in order across a newer close on the same uninterrupted feed', async () => {
  const { robot, submitted, history, setNow } = setup();
  const baseline = candle(-1, 99);
  await robot.start();
  setNow(2);
  await history(baseline, candle(0, 101, null), candle(1, 102));
  assert.equal(submitted.length, 0);
  await history(baseline, candle(0, 101), candle(1, 102));
  assert.equal(submitted[0]?.candleTime, opening);
  assert.equal(submitted.length, 1);
});

for (const after of [99, 101]) {
  test(`equality preserves the last strict side before close ${after}`, async () => {
    const { robot, history, setNow, submitted } = setup();
    await robot.start();
    setNow(1);
    const baseline = candle(-1, 99);
    const equal = candle(0, 100);
    await history(baseline, equal);
    assert.equal(submitted.length, 0);
    setNow(2);
    await history(baseline, equal, candle(1, after));
    assert.equal(submitted.length, after === 101 ? 1 : 0);
  });
}

test('unknown initial side and closes on the same side make no order', async () => {
  const { robot, history, setNow, submitted } = setup();
  await robot.start();
  setNow(1);
  await history(candle(-1, 100), candle(0, 101));
  setNow(2);
  await history(candle(0, 101), candle(1, 102));
  assert.equal(submitted.length, 0);
});

test('rejects non-flat and active-order starts and checks again before sending', async () => {
  const { robot, history, setNow, setAccount, submitted } = setup();
  setAccount(-2);
  await assert.rejects(robot.start(), { code: 'ROBOT_POSITION_NOT_FLAT' });
  setAccount(0, true);
  await assert.rejects(robot.start(), { code: 'ROBOT_ACTIVE_ORDERS' });
  setAccount(0);
  await robot.start();
  setAccount(1);
  setNow(1);
  await history(candle(-1, 99), candle(0, 101));
  assert.deepEqual(robot.status(), {
    mode: 'paused',
    reason: 'ROBOT_POSITION_NOT_FLAT',
    position: 1,
  });
  assert.equal(submitted.length, 0);
});

test('cannot send over a pending submission, and checks the original ID after timeout', async () => {
  const { robot, broker, history, setNow, setAccount, lookups } = setup();
  const gate = deferred();
  const attempted: string[] = [];
  broker.submit = async (_token, order) => {
    attempted.push(order.id);
    await gate.promise;
    throw new Error('timeout');
  };
  await robot.start();
  setNow(1);
  await history(candle(-1, 99), candle(0, 101));
  assert.equal((await robot.history())[0].status, 'reserved');
  setNow(2);
  await history(candle(0, 101), candle(1, 99));
  assert.equal(attempted.length, 1);
  setAccount(3);
  gate.resolve();
  await setImmediate();
  assert.deepEqual(lookups, [[attempted[0], null]]);
  assert.equal((await robot.history())[0].status, 'unconfirmed');
  assert.equal(robot.status().mode, 'paused');
  await robot.reconcile();
  assert.deepEqual(lookups, [
    [attempted[0], null],
    [attempted[0], null],
  ]);
  assert.equal((await robot.history())[0].status, 'confirmed');
  assert.equal(robot.status().mode, 'paused');
});

test('unconfirmed order blocks new starts even after stopping', async () => {
  const { robot, broker, history, setNow, submitted } = setup();
  broker.orderState = async () => {
    throw new Error('unknown');
  };
  await robot.start();
  setNow(1);
  await history(candle(-1, 99), candle(0, 101));
  assert.equal(robot.status().mode, 'paused');
  assert.equal((await robot.history())[0].status, 'unconfirmed');
  robot.stop();
  await assert.rejects(robot.start(), { code: 'ROBOT_ORDER_UNRESOLVED' });
  assert.equal(submitted.length, 1);
});

test('a rejected order is reconciled without a resend and waits for explicit resume', async () => {
  const { robot, broker, history, setNow, setAccount, submitted, lookups } = setup();
  const submit = broker.submit;
  const orderState = broker.orderState;
  broker.submit = async (...args) => {
    await submit(...args);
    setAccount(0);
    return { brokerOrderId: 'broker-order', brokerStatus: 'rejected', executedLots: 0 };
  };
  broker.orderState = async (...args) => {
    const state = await orderState(...args);
    return { ...state, brokerStatus: 'rejected', executedLots: 0, executions: [] };
  };
  await robot.start();
  setNow(1);
  await history(candle(-1, 99), candle(0, 101));
  const id = submitted[0].id;
  assert.equal(robot.status().reason, 'ROBOT_ORDER_REJECTED');
  await assert.rejects(robot.resume(), { code: 'ROBOT_ORDER_UNRESOLVED' });
  await robot.reconcile();
  assert.equal(robot.status().mode, 'paused');
  assert.deepEqual(robot.status().recovery, { orderId: id, ready: true });
  assert.equal((await robot.history())[0].status, 'reconciled');
  assert.deepEqual(lookups, [
    [id, 'broker-order'],
    [id, null],
  ]);
  await robot.resume();
  await history(candle(-1, 99), candle(0, 101));
  assert.equal(robot.status().mode, 'running');
  assert.equal(submitted.length, 1);
});

test('a definitive rejection before order creation still requires the original lookup and matching account state', async () => {
  const { robot, broker, history, setNow, setAccount } = setup();
  const attempted: string[] = [];
  const lookedUp: string[] = [];
  broker.submit = async (_token, order) => {
    attempted.push(order.id);
    return { brokerOrderId: null, brokerStatus: 'rejected', executedLots: 0 };
  };
  broker.orderState = async (_token, order, brokerOrderId) => {
    assert.equal(brokerOrderId, null);
    lookedUp.push(order.id);
    throw new Error('not found');
  };
  await robot.start();
  setNow(1);
  await history(candle(-1, 99), candle(0, 101));
  assert.equal(robot.status().reason, 'ROBOT_ORDER_REJECTED');
  setAccount(1);
  await robot.reconcile();
  assert.equal(robot.status().reason, 'ROBOT_ORDER_POSITION_MISMATCH');
  await assert.rejects(robot.resume(), { code: 'ROBOT_ORDER_UNRESOLVED' });
  setAccount(0);
  await robot.reconcile();
  assert.equal((await robot.history())[0].status, 'reconciled');
  assert.deepEqual(lookedUp, Array(3).fill(attempted[0]));
  assert.equal(attempted.length, 1);
});

test('stopping during a resume check does not discard an account mismatch or let a fresh start bypass it', async () => {
  const { robot, broker, history, setNow, setAccount, submitted } = setup();
  const orderState = broker.orderState;
  broker.orderState = async () => {
    throw new Error('offline');
  };
  await robot.start();
  setNow(1);
  await history(candle(-1, 99), candle(0, 101));
  broker.orderState = orderState;
  await robot.reconcile();
  assert.equal(robot.status().recovery?.ready, true);
  const checking = deferred();
  const release = deferred();
  const accountState = broker.accountState;
  broker.accountState = async (config) => {
    checking.resolve();
    await release.promise;
    return accountState(config);
  };
  const resumed = assert.rejects(robot.resume(), { code: 'ROBOT_POSITION_CHANGED' });
  await checking.promise;
  robot.stop();
  setAccount(0);
  release.resolve();
  await resumed;
  assert.equal(robot.status().mode, 'stopped');
  assert.equal(robot.status().recovery?.ready, false);
  assert.equal((await robot.history())[0].status, 'unconfirmed');
  await assert.rejects(robot.start(), { code: 'ROBOT_ORDER_UNRESOLVED' });
  assert.equal(submitted.length, 1);
});

test('partial execution blocks resume until the remainder is cancelled and fills match the position', async () => {
  const fixture = setup();
  const { robot, broker, history, setNow, setAccount, submitted } = fixture;
  await openLong(fixture);
  const orderState = broker.orderState;
  let terminal = false;
  broker.orderState = async (...args) => {
    const state = await orderState(...args);
    return {
      ...state,
      brokerStatus: terminal ? 'cancelled' : 'partial',
      executedLots: 4,
      executions: [{ ...state.executions[0], lots: 4 }],
    };
  };
  await history(candle(0, 101), candle(1, 99));
  assert.equal(robot.status().reason, 'ROBOT_ORDER_PARTIAL');
  setAccount(-1, true);
  terminal = true;
  await robot.reconcile();
  assert.equal(robot.status().reason, 'ROBOT_ACTIVE_ORDERS');
  setAccount(-3);
  await robot.reconcile();
  assert.equal(robot.status().reason, 'ROBOT_ORDER_POSITION_MISMATCH');
  await assert.rejects(robot.resume(), { code: 'ROBOT_ORDER_UNRESOLVED' });
  setAccount(-1);
  await robot.reconcile();
  const [, row] = await robot.history();
  assert.deepEqual(
    [row.status, row.brokerStatus, row.position, row.executions[0].lots],
    ['reconciled', 'cancelled', -1, 4],
  );
  assert.equal(robot.status().mode, 'paused');
  assert.equal(submitted.length, 2);

  setAccount(-1, true);
  await assert.rejects(robot.resume(), { code: 'ROBOT_ACTIVE_ORDERS' });
  assert.equal((await robot.history())[1].status, 'unconfirmed');
  setAccount(-1);
  await robot.reconcile();
  setAccount(-2);
  await assert.rejects(robot.resume(), { code: 'ROBOT_POSITION_CHANGED' });
  assert.equal(robot.status().recovery?.ready, false);
  setAccount(-1);
  await robot.reconcile();
  await robot.resume();
  await history(candle(0, 101), candle(1, 99));
  assert.equal(submitted.length, 2, 'Resume does not replay the crossing during the pause');
  broker.orderState = orderState;
  setNow(3);
  await history(candle(0, 101), candle(1, 99), candle(2, 101));
  assert.equal(submitted.length, 3);
  assert.equal(submitted[2].lots, 4, 'Only a fresh crossing trades from the reconciled position');
});

test('an ambiguous timeout is never retried, even while the original request cannot be found', async () => {
  const { robot, broker, history, setNow, setAccount } = setup();
  const attempted: string[] = [];
  const lookedUp: [string, string | null][] = [];
  broker.submit = async (_token, order) => {
    attempted.push(order.id);
    throw new Error('timeout');
  };
  const orderState = broker.orderState;
  let discovered = false;
  broker.orderState = async (...args) => {
    lookedUp.push([args[1].id, args[2]]);
    if (!discovered) throw new Error('not found');
    return orderState(...args);
  };
  await robot.start();
  setNow(1);
  await history(candle(-1, 99), candle(0, 101));
  assert.equal(robot.status().reason, 'ROBOT_ORDER_SUBMISSION_UNCERTAIN');
  robot.stop();
  await robot.reconcile();
  assert.equal((await robot.history())[0].brokerStatus, 'unknown');
  await assert.rejects(robot.resume(), { code: 'ROBOT_ORDER_UNRESOLVED' });
  await assert.rejects(robot.start(), { code: 'ROBOT_ORDER_UNRESOLVED' });

  discovered = true;
  broker.accountState = async () => {
    throw new Error('offline');
  };
  await robot.reconcile();
  assert.equal(robot.status().position, null);
  assert.equal((await robot.history())[0].executedLots, 3);
  await assert.rejects(robot.resume(), { code: 'ROBOT_ORDER_UNRESOLVED' });
  broker.accountState = async () => ({ position: 3, activeOrders: false });
  setAccount(3);
  await robot.reconcile();
  assert.equal((await robot.history())[0].status, 'confirmed');
  assert.equal(robot.status().mode, 'stopped');
  await robot.resume();
  assert.equal(attempted.length, 1);
  assert.deepEqual(
    lookedUp,
    Array.from({ length: 4 }, () => [attempted[0], null]),
  );
});

for (const cancel of ['stop', 'disconnect'] as const) {
  test(`${cancel} during reserve prevents submission and journals the reason`, async () => {
    const { robot, history, setNow, store, submitted, disconnect } = setup();
    const gate = deferred();
    const reserve = store.reserve;
    store.reserve = async (order) => {
      const saved = await reserve(order);
      await gate.promise;
      return saved;
    };
    await robot.start();
    setNow(1);
    await history(candle(-1, 99), candle(0, 101));
    if (cancel === 'stop') robot.stop();
    else disconnect();
    gate.resolve();
    await setImmediate();
    assert.equal(submitted.length, 0);
    assert.equal(
      (await robot.history())[0].status,
      cancel === 'stop' ? 'stopped-before-send' : 'feed-lost-before-send',
    );
  });
}

test('a broker reconnect uses the missed crossing as baseline and trades only a new completed signal', async () => {
  const { robot, submitted, history, setNow, disconnect, backfill } = setup();
  const baseline = candle(-1, 99);
  await robot.start();
  await history(baseline);
  assert.equal(submitted.length, 0);
  disconnect();
  assert.equal(robot.status().mode, 'reconnecting');
  setNow(1);
  backfill(baseline, candle(0, 101));
  assert.equal(submitted.length, 0);
  await history(baseline, candle(0, 101));
  assert.equal(robot.status().mode, 'running');
  assert.equal(robot.status().reason, null);
  assert.equal(submitted.length, 0);
  setNow(2);
  await history(candle(0, 101), candle(1, 99));
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].direction, 'sell');
  assert.equal(submitted[0].candleTime, opening + hourMs);
});

test('a fast reconnect cannot send a reservation made on the previous stream', async () => {
  const { robot, history, disconnect, setNow, store, submitted } = setup();
  const gate = deferred();
  const reserve = store.reserve;
  store.reserve = async (order) => {
    const saved = await reserve(order);
    await gate.promise;
    return saved;
  };
  await robot.start();
  setNow(1);
  await history(candle(-1, 99), candle(0, 101));
  assert.equal((await robot.history())[0].status, 'reserved');
  disconnect();
  await history(candle(-1, 99), candle(0, 101));
  setNow(2);
  await history(candle(0, 101), candle(1, 99));
  assert.equal(submitted.length, 0);
  gate.resolve();
  await setImmediate();
  assert.equal((await robot.history())[0].status, 'feed-lost-before-send');
  assert.equal(
    submitted.length,
    1,
    'The first fresh signal is processed even without another feed update',
  );
  assert.equal(submitted[0].candleTime, opening + hourMs);
});

test('stopping while the broker reconnects does not restart trading', async () => {
  const { robot, history, disconnect, isSubscribed, setNow, submitted } = setup();
  await robot.start();
  await history(candle(-1, 99));
  disconnect();
  robot.stop();
  assert.equal(isSubscribed(), false);
  setNow(2);
  await history(candle(-1, 99), candle(0, 101), candle(1, 99));
  assert.equal(robot.status().mode, 'stopped');
  assert.equal(submitted.length, 0);
});

test('an ambiguous order sent before a disconnect still blocks a recovered feed', async () => {
  const { robot, broker, submitted, disconnect, history, setNow } = setup();
  const gate = deferred();
  broker.orderState = async () => {
    await gate.promise;
    throw new Error('offline');
  };
  await robot.start();
  setNow(1);
  await history(candle(-1, 99), candle(0, 101));
  assert.equal(submitted.length, 1);
  disconnect();
  await history(candle(-1, 99), candle(0, 101));
  gate.resolve();
  await setImmediate();
  assert.equal(robot.status().mode, 'paused');
  assert.equal(robot.status().recovery?.ready, false);
  setNow(2);
  await history(candle(0, 101), candle(1, 99));
  assert.equal(submitted.length, 1);
});

test('the first feed connection never trades candles already closed while connecting', async () => {
  const { robot, history, setNow, submitted } = setup({ autoConnect: false });
  await robot.start();
  setNow(1.5);
  await history(candle(-1, 99), candle(0, 101));
  assert.equal(submitted.length, 0);
  setNow(2);
  await history(candle(0, 101), candle(1, 99));
  assert.equal(submitted[0]?.direction, 'sell');
});

test('startup reads the actual position without opening a feed or sending an order', async () => {
  const { robot, setAccount, isSubscribed, submitted, lookups } = setup();
  setAccount(-2);
  await robot.restore();
  assert.deepEqual(robot.status(), { mode: 'stopped', reason: null, position: -2 });
  assert.equal(isSubscribed(), false);
  assert.equal(lookups.length, 0);
  assert.equal(submitted.length, 0);
  await assert.rejects(robot.start(), { code: 'ROBOT_POSITION_NOT_FLAT' });
});

test('startup keeps an unseen reserved request blocked; later reconciliation uses only its persisted ID', async () => {
  const { robot, broker, store, submitted, isSubscribed, lookups, setAccount } = setup();
  const { accountId, instrumentUid, ticker } = config;
  await store.reserve({
    id: 'persisted-request',
    accountId,
    instrumentUid,
    ticker,
    context: {
      type: 'signal',
      candleTime: opening - hourMs,
      signalTime: opening,
      strategy: { kind: 'surfing', signalPrice: 101, ema: 100 },
    },
    timeframe: '1h',
    direction: 'buy',
    lots: 3,
    fromPosition: 0,
    targetPosition: 3,
  });
  const orderState = broker.orderState;
  broker.orderState = async (_token, order, brokerId) => {
    lookups.push([order.id, brokerId]);
    throw new Error('not found');
  };
  await robot.restore();
  assert.equal(robot.status().mode, 'stopped');
  assert.deepEqual(robot.status().recovery, { orderId: 'persisted-request', ready: false });
  assert.equal((await robot.history())[0].status, 'unconfirmed');
  await assert.rejects(robot.start(), { code: 'ROBOT_ORDER_UNRESOLVED' });
  await assert.rejects(robot.resume(), { code: 'ROBOT_ORDER_UNRESOLVED' });
  broker.orderState = orderState;
  setAccount(3);
  await robot.reconcile();
  assert.deepEqual(lookups, [
    ['persisted-request', null],
    ['persisted-request', null],
  ]);
  assert.equal((await robot.history())[0].status, 'confirmed');
  assert.equal(robot.status().mode, 'stopped');
  assert.equal(isSubscribed(), false);
  assert.equal(submitted.length, 0);
});

test('invalid settings do not prevent reconciliation of the original reserved order', async () => {
  const { robot, store, submitted, lookups, setAccount, invalidateSettings } = setup();
  await store.reserve({
    id: 'original-id',
    accountId: config.accountId,
    instrumentUid: config.instrumentUid,
    ticker: config.ticker,
    context: {
      type: 'signal',
      candleTime: opening - hourMs,
      signalTime: opening,
      strategy: { kind: 'surfing', signalPrice: 101, ema: 100 },
    },
    timeframe: '1h',
    direction: 'buy',
    lots: 3,
    fromPosition: 0,
    targetPosition: 3,
  });
  setAccount(3);
  invalidateSettings();
  await robot.restore();
  assert.deepEqual(lookups, [['original-id', null]]);
  assert.equal(robot.status().recovery?.ready, true);
  await assert.rejects(robot.resume(), /Invalid saved strategy settings/);
  assert.deepEqual(submitted, []);
});

test('generic live signal context passes through reservation before submission, including target zero', async () => {
  let next = 0;
  const context = { kind: 'non-ema', reason: 'test', nested: { value: 7 } };
  const { robot, store, broker, history, submitted } = setup({
    findSignal: () => {
      const index = next++;
      return index < 2
        ? {
            candleTime: opening + index * hourMs,
            signalTime: opening + (index + 1) * hourMs,
            targetPosition: index === 0 ? 3 : 0,
            strategy: context,
          }
        : undefined;
    },
  });
  const reserve = store.reserve.bind(store);
  let reserved = false;
  let reservedIntent: import('./robot.js').OrderIntent | undefined;
  store.reserve = async (intent) => {
    reservedIntent = intent;
    assert.deepEqual(intent.context, {
      type: 'signal',
      candleTime: opening + submitted.length * hourMs,
      signalTime: opening + (submitted.length + 1) * hourMs,
      strategy: context,
    });
    reserved = await reserve(intent);
    return reserved;
  };
  const submit = broker.submit.bind(broker);
  broker.submit = async (token, intent) => {
    assert.equal(reserved, true);
    assert.equal(intent.id, reservedIntent?.id);
    assert.deepEqual(intent.context, reservedIntent?.context);
    if (intent.targetPosition === 0) {
      assert.equal(intent.fromPosition, 3);
      assert.equal(intent.direction, 'sell');
      assert.equal(intent.lots, 3);
    }
    reserved = false;
    return submit(token, intent);
  };
  await robot.start();
  await history(candle(0, 100));
  await history(candle(1, 100));
  assert.deepEqual(
    submitted.map((order) => order.targetPosition),
    [3, 0],
  );
});

test('oversized automated configuration rejects recovery-ready resume before subscribing or sending', async () => {
  const { robot, store, setAccount, submitted, isSubscribed } = setup({ lots: 1_073_741_824 });
  await store.reserve({
    id: 'saved',
    accountId: config.accountId,
    instrumentUid: config.instrumentUid,
    ticker: config.ticker,
    timeframe: config.timeframe,
    context: {
      type: 'signal',
      candleTime: opening - hourMs,
      signalTime: opening,
      strategy: { kind: 'surfing', signalPrice: 101, ema: 100 },
    },
    direction: 'buy',
    lots: 3,
    fromPosition: 0,
    targetPosition: 3,
  });
  setAccount(3);
  await robot.restore();
  assert.equal(robot.status().recovery?.ready, true);
  await assert.rejects(robot.resume(), /ROBOT_SETTINGS_INVALID/);
  assert.equal(isSubscribed(), false);
  assert.equal(submitted.length, 0);
});
