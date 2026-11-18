import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { hourMs, type MarketHistory, type MarketUpdate } from './market-data.js';
import { Robot, type Broker, type JournalEntry, type TradingConfig, type TradingStore } from './robot.js';

type Candle = MarketHistory['candles'][number];
const config: TradingConfig = {
  token: 'fake', accountId: 'account', instrumentUid: 'future', ticker: 'FUT', emaPeriod: 55, lots: 3,
};
const opening = Date.UTC(2026, 10, 18, 12);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function candle(offset: number, close: number, confirmedEma: number | null = 100, complete = true): Candle {
  return { time: opening + offset * hourMs, open: close, high: close, low: close, close, complete,
    confirmedEma, previewEma: complete ? null : 100 };
}

function setup({ autoConnect = true } = {}) {
  const entries: JournalEntry[] = [];
  const submitted: JournalEntry[] = [];
  const lookups: [string, string | null][] = [];
  let listener: ((update: MarketUpdate) => void) | undefined;
  let now = opening + hourMs / 2;
  let position = 0;
  let activeOrders = false;
  const store: TradingStore = {
    async reserve(order) {
      if (await store.hasUnresolved()) return false;
      if (order.candleTime !== null && entries.some(row => row.candleTime === order.candleTime)) return false;
      entries.push({ ...order, status: 'reserved', brokerStatus: 'unknown', brokerOrderId: null, position: null,
        executedLots: null, executions: [] });
      return true;
    },
    async record(id, result) { Object.assign(entries.find(row => row.id === id)!, result); },
    async history() { return entries; },
    async hasUnresolved() { return entries.some(row => row.status === 'reserved' || row.status === 'unconfirmed'); },
  };
  const broker: Broker = {
    async verifySelection(selection) { assert.deepEqual(selection, config); },
    async accountState() { return { position, activeOrders }; },
    async submit(token, order) {
      const saved = entries.find(row => row.id === order.id);
      assert.equal(token, config.token);
      assert.equal(saved?.status, 'reserved', 'The intent must be saved before posting');
      submitted.push({ ...saved! });
      position = order.targetPosition;
      return { brokerOrderId: 'broker-order', brokerStatus: 'filled', executedLots: order.lots };
    },
    async orderState(_token, order, brokerId) {
      lookups.push([order.id, brokerId]);
      return { brokerOrderId: 'broker-order', brokerStatus: 'filled', executedLots: order.lots,
        executions: [{ lots: order.lots, price: 103.25, time: now + 50, tradeId: 'execution-id' }] };
    },
  };
  const robot = new Robot(broker, store, {
    async subscribe(callback, pinned) {
      assert.deepEqual(pinned, config);
      listener = callback;
      if (autoConnect) listener({ stream: 'live' });
      return () => { listener = undefined; };
    },
  }, async () => config, () => now);
  return {
    robot, broker, store, submitted, lookups,
    setNow: (offset: number) => { now = opening + offset * hourMs; },
    setAccount: (lots: number, active = false) => { position = lots; activeOrders = active; },
    disconnect: () => { listener?.({ stream: 'disconnected' }); },
    async history(...candles: Candle[]) {
      listener?.({ stream: 'live', history: { instrumentUid: config.instrumentUid, emaPeriod: config.emaPeriod, candles } });
      await setImmediate();
    },
  };
}

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
    assert.equal(submitted.length, 1, 'A correction or another close on the same side cannot send an order');
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
    assert.deepEqual(row.executions.map(fill => fill.lots), [6]);
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
    [close.action, close.candleTime, close.signalPrice, close.ema, close.direction, close.lots, close.fromPosition, close.targetPosition],
    ['manual-close', null, null, null, 'sell', 2, 2, 0],
  );
  assert.equal(close.status, 'confirmed');
  assert.equal(robot.status().position, 0);
  await robot.closePosition(closeSelection);
  assert.equal(submitted.length, 2, 'already flat, so no order');
});

test('manual closing a short buys only once and is not successful until the broker confirms zero', async () => {
  const { robot, broker, submitted, setAccount } = setup();
  await assert.rejects(robot.closePosition({ ...closeSelection, accountId: 'stale' }), { code: 'ROBOT_SELECTION_CHANGED' });
  setAccount(-2);
  const gate = deferred();
  const lookup = broker.orderState;
  broker.orderState = async (...args) => {
    await gate.promise;
    setAccount(-1);
    return lookup(...args);
  };
  const closed = assert.rejects(robot.closePosition(closeSelection), { code: 'ROBOT_ORDER_UNRESOLVED' });
  await setImmediate();
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].direction, 'buy');
  await assert.rejects(robot.closePosition(closeSelection), { code: 'ROBOT_BUSY' });
  await assert.rejects(robot.changeSettings(async () => assert.fail('Close pending')), { code: 'ROBOT_BUSY' });
  gate.resolve();
  await closed;
  assert.deepEqual(robot.status(), { mode: 'stopped', reason: 'ROBOT_ORDER_UNRESOLVED', position: -1 });
  assert.equal((await robot.history())[0].status, 'unconfirmed');
  await assert.rejects(robot.closePosition(closeSelection), { code: 'ROBOT_ORDER_UNRESOLVED' });
  await assert.rejects(robot.changeSettings(async () => assert.fail('Unresolved close')), { code: 'ROBOT_ORDER_UNRESOLVED' });
  assert.equal(submitted.length, 1);
});

test('stop leaves a submitted strategy order to reconcile and blocks closing until it settles', async () => {
  const { robot, broker, submitted, history, setNow } = setup();
  const gate = deferred();
  const lookup = broker.orderState;
  broker.orderState = async (...args) => { await gate.promise; return lookup(...args); };
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
  store.reserve = async order => {
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
    store.reserve = async order => { const saved = await reserve(order); await gate.promise; return saved; };

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
    assert.equal(robot.status().reason, change === 'position' ? 'ROBOT_POSITION_CHANGED' : 'ROBOT_ACTIVE_ORDERS');
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
      return brokerStatus === 'filled' ? state : {
        ...state, brokerStatus, executedLots: 4, executions: [{ ...state.executions[0], lots: 4 }],
      };
    };

    await history(candle(0, 101), candle(1, 99));
    assert.equal(submitted.length, 2);
    const [, row] = await robot.history();
    assert.equal(row.brokerStatus, brokerStatus);
    assert.equal(row.status, 'unconfirmed');
    assert.equal(row.position, actualPosition);
    assert.deepEqual(robot.status(), { mode: 'paused', reason: 'ROBOT_ORDER_UNRESOLVED', position: actualPosition });
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
  assert.deepEqual(robot.status(), { mode: 'paused', reason: 'ROBOT_POSITION_NOT_FLAT', position: 1 });
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
  assert.equal((await robot.history())[0].status, 'confirmed');
});

test('unconfirmed order blocks new starts even after stopping', async () => {
  const { robot, broker, history, setNow, submitted } = setup();
  broker.orderState = async () => { throw new Error('unknown'); };
  await robot.start();
  setNow(1);
  await history(candle(-1, 99), candle(0, 101));
  assert.equal(robot.status().mode, 'paused');
  assert.equal((await robot.history())[0].status, 'unconfirmed');
  robot.stop();
  await assert.rejects(robot.start(), { code: 'ROBOT_ORDER_UNRESOLVED' });
  assert.equal(submitted.length, 1);
});

for (const cancel of ['stop', 'disconnect'] as const) {
  test(`${cancel} during reserve prevents submission and journals the reason`, async () => {
  const { robot, history, setNow, store, submitted, disconnect } = setup();
  const gate = deferred();
  const reserve = store.reserve;
  store.reserve = async order => { const saved = await reserve(order); await gate.promise; return saved; };
  await robot.start();
  setNow(1);
  await history(candle(-1, 99), candle(0, 101));
  if (cancel === 'stop') robot.stop();
  else disconnect();
  gate.resolve();
  await setImmediate();
  assert.equal(submitted.length, 0);
  assert.equal((await robot.history())[0].status, cancel === 'stop' ? 'stopped-before-send' : 'feed-lost-before-send');
  });
}

test('does not open on backfill or after feed loss', async () => {
  const { robot, history, setNow, disconnect, submitted } = setup();
  await robot.start();
  await history(candle(-2, 99), candle(-1, 101));
  assert.equal(submitted.length, 0);
  disconnect();
  setNow(2);
  await history(candle(0, 101), candle(1, 99));
  assert.equal(submitted.length, 0);
  assert.equal(robot.status().reason, 'ROBOT_FEED_LOST');
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
