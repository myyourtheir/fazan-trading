import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import type { MarketHistory } from './market-data.js';
import {
  MemoryProtectionTransactions,
  ProtectionMemory,
} from './protection-transactions.test-support.js';
import {
  Robot,
  type FeedUpdate,
  type ImprovedProtection,
  type OrderIntent,
  type ProtectionObservation,
  type TradingConfig,
} from './robot.js';

const config: TradingConfig = {
  token: 'fake',
  accountId: 'account',
  instrumentUid: 'instrument',
  ticker: 'TEST',
  timeframe: '1h',
};
const start = Date.UTC(2026, 10, 18);
const hour = 3_600_000;
const candle = (time: number, close: number, confirmedEma: number | null = 100) => ({
  time,
  open: close,
  high: close + 1,
  low: close - 1,
  close,
  complete: true,
  confirmedEma,
  previewEma: null,
});
const history = (candles: ReturnType<typeof candle>[]) =>
  ({ instrumentUid: config.instrumentUid, timeframe: config.timeframe, candles }) as MarketHistory;

function setup(
  options: {
    freeMoney?: number;
    atrPeriod?: number;
    submitProtection?: 'confirmed' | 'not-sent' | 'rejected' | 'unconfirmed' | 'throw';
    ambiguousOrder?: boolean;
    lookupFails?: boolean;
    lookup?: () => ProtectionObservation;
    recheck?: () => Promise<void>;
    finalRecheck?: () => Promise<void>;
    sizing?: () => Promise<{ freeMoney: number; pointValue: number }>;
    session?: (signalTime: number) => Promise<{ start: number; end: number } | null>;
    recorded?: (status: string) => void;
    clock?: (now: number) => number;
    claimDelay?: () => Promise<void>;
    settlementFailure?: 'precommit' | 'postcommit';
    settlementFailureOnce?: boolean;
    settlementDelay?: () => Promise<void>;
    releaseDelay?: () => Promise<void>;
    partial?: 'cancelled' | 'partial';
    failRelease?: 'before' | 'cancel' | 'observed';
    finalAccount?: { position: number; activeOrders: boolean };
    observedAccount?: { position: number; activeOrders: boolean };
    zeroLookup?: boolean;
    zeroSubmit?: boolean;
    nativeProtection?: boolean;
    maxAddOns?: number;
    margin?: () => boolean | Promise<boolean>;
    cancelStop?: () => Promise<void>;
    closeEvidence?: NonNullable<ImprovedProtection['closeEvidence']>;
    childEvidence?: NonNullable<ImprovedProtection['childEvidence']>;
    observeOrder?: (order: OrderIntent) => 'filled' | 'new' | 'terminal-partial';
    deferSubmit?: (order: OrderIntent) => boolean;
    tradeWeekends?: boolean;
  } = {},
) {
  let listener!: (update: FeedUpdate<MarketHistory>) => void;
  let position = 0;
  let accountChecks = 0;
  const records: { id: string; status: string }[] = [];
  let unresolved: OrderIntent | null = null;
  let now = start;
  let failedSettlement = false;
  const events: string[] = [];
  const orders: OrderIntent[] = [];
  let stopActive = false;
  class Transactions extends MemoryProtectionTransactions {
    public override async beginEntrySubmit(
      ...args: Parameters<MemoryProtectionTransactions['beginEntrySubmit']>
    ) {
      const result = await super.beginEntrySubmit(...args);
      await options.claimDelay?.();
      return result;
    }
    public override async reserveProtectedEntry(
      ...args: Parameters<MemoryProtectionTransactions['reserveProtectedEntry']>
    ) {
      const result = await super.reserveProtectedEntry(...args);
      if (result.ok) {
        events.push('reserve-order:' + args[0].id, 'reserve-stop:' + args[1].id);
      }
      return result;
    }

    public override async settleProtectedEntry(
      ...args: Parameters<MemoryProtectionTransactions['settleProtectedEntry']>
    ) {
      if (
        args[1].kind === 'observed' &&
        (options.settlementFailure === 'precommit' ||
          (options.settlementFailureOnce && !failedSettlement))
      ) {
        failedSettlement = true;
        throw new Error('precommit');
      }
      if (args[1].kind === 'observed') await options.settlementDelay?.();
      const result = await super.settleProtectedEntry(...args);
      if (args[1].kind === 'not-sent') await options.releaseDelay?.();
      if (
        (args[1].kind === 'not-sent' && options.failRelease === 'before') ||
        (args[1].kind === 'observed' &&
          args[1].result.status === 'reconciled' &&
          options.failRelease === 'observed')
      )
        throw new Error('postcommit');
      if (args[1].kind === 'observed' && options.settlementFailure === 'postcommit')
        throw new Error('postcommit');
      if (result.ok) {
        const { id, status } = result.value.order;
        records.push({ id, status });
        options.recorded?.(status);
      }
      return result;
    }
    public override async cancelEntryBeforeSend(
      ...args: Parameters<MemoryProtectionTransactions['cancelEntryBeforeSend']>
    ) {
      const result = await super.cancelEntryBeforeSend(...args);
      if (options.failRelease === 'cancel') throw new Error('postcommit');
      return result;
    }
  }
  const transactions = new Transactions(new ProtectionMemory());
  const protection: ImprovedProtection = {
    ...(options.nativeProtection && {
      async cancel() {
        events.push('cancel-stop');
        await options.cancelStop?.();
        stopActive = false;
      },
      closeEvidence:
        options.closeEvidence ?? (async () => ({ status: 'never-triggered' as const })),
      childEvidence: options.childEvidence,
    }),
    ...(options.margin && {
      async canIncrease() {
        events.push('check-margin');
        return options.margin!();
      },
    }),
    async sizing() {
      if (options.sizing) return options.sizing();
      return { freeMoney: options.freeMoney ?? 1000, pointValue: 1 };
    },
    async submit(_config, value) {
      events.push('send-stop:' + value.id);
      stopActive = true;
      if (options.submitProtection === 'throw') throw new Error('no reply');
      return options.submitProtection ?? 'unconfirmed';
    },
    async lookup(_config, value) {
      events.push('lookup-stop:' + value.id);
      if (options.lookupFails) throw new Error('offline');
      return (
        options.lookup?.() ?? {
          status: stopActive && options.nativeProtection ? 'active' : 'absent',
        }
      );
    },
  };
  const robot = new Robot(
    {
      async verifySelection() {},
      async accountState() {
        accountChecks++;
        if (accountChecks === 3) await options.recheck?.();
        if (accountChecks === 4) await options.finalRecheck?.();
        if (accountChecks === 4 && options.finalAccount) return options.finalAccount;
        if (accountChecks > 4 && options.observedAccount) return options.observedAccount;
        return { position, activeOrders: false };
      },
      async submit(_token, order) {
        events.push('send-order:' + order.id);
        orders.push(order);
        if (options.deferSubmit?.(order))
          return { brokerOrderId: 'broker', brokerStatus: 'new', executedLots: 0 };
        position = options.zeroSubmit
          ? 0
          : options.partial
            ? order.direction === 'buy'
              ? 1
              : -1
            : order.targetPosition;
        if (options.ambiguousOrder) throw new Error('no reply');
        if (options.zeroSubmit)
          return { brokerOrderId: 'broker', brokerStatus: 'cancelled', executedLots: 0 };
        if (options.partial)
          return { brokerOrderId: 'broker', brokerStatus: options.partial, executedLots: 1 };
        return { brokerOrderId: 'broker', brokerStatus: 'filled', executedLots: order.lots };
      },
      async orderState(_token, order) {
        events.push('lookup-order:' + order.id);
        const observed = options.observeOrder?.(order);
        if (observed === 'new')
          return { brokerOrderId: 'broker', brokerStatus: 'new', executedLots: 0, executions: [] };
        if (observed === 'terminal-partial')
          return {
            brokerOrderId: 'broker',
            brokerStatus: 'cancelled',
            executedLots: 1,
            executions: [{ tradeId: 'partial-fill', lots: 1, price: 101, time: start }],
          };
        if (options.zeroLookup)
          return {
            brokerOrderId: 'broker',
            brokerStatus: 'cancelled',
            executedLots: 0,
            executions: [],
          };
        return {
          brokerOrderId: 'broker',
          brokerStatus: options.partial ?? 'filled',
          executedLots: options.partial ? 1 : order.lots,
          executions: [
            { tradeId: 'fill', lots: options.partial ? 1 : order.lots, price: 101, time: start },
          ],
        };
      },
    },
    {
      protection: transactions,
      async reserve(order) {
        events.push('reserve-order:' + order.id);
        if (unresolved) return false;
        unresolved = order;
        return true;
      },
      async record(id, result) {
        records.push({ id, status: result.status });
        if (unresolved?.id === id && result.status !== 'unconfirmed') unresolved = null;
        options.recorded?.(result.status);
      },
      async hasUnresolved() {
        return unresolved !== null || transactions.hasUnresolved();
      },
      async unresolved() {
        return transactions.unresolved();
      },
      async history() {
        return transactions.history();
      },
    },
    {
      async subscribe(fn) {
        listener = fn;
        return () => {};
      },
    },
    async () => config,
    () => options.clock?.(now) ?? now,
    () => undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      parameters: {
        emaPeriod: 55,
        atrPeriod: options.atrPeriod ?? 1,
        stopAtrMultiplier: 2,
        addStepAtr: 1,
        maxAddOns: options.maxAddOns ?? 3,
        tradeWeekends: options.tradeWeekends ?? false,
      },
      protection,
      session: async (_config, signalTime) =>
        options.session?.(signalTime) ?? { start: start - hour, end: start + 48 * hour },
    },
  );
  return {
    robot,
    events,
    orders,
    records,
    transactions,
    setPosition: (value: number) => {
      position = value;
    },
    setNow: (value: number) => {
      now = value;
    },
    emit: (update: FeedUpdate<MarketHistory>, observedAt?: number) => {
      if (observedAt !== undefined) now = observedAt;
      else if (update.freshCandleTime !== undefined) now = update.freshCandleTime + 3_600_000;
      listener(update);
    },
  };
}

test('an opposing close exits through the guarded stop path, then sizes the reverse entry anew', async () => {
  let reads = 0;
  const { robot, orders, events, emit } = setup({
    nativeProtection: true,
    submitProtection: 'confirmed',
    sizing: async () => ({ freeMoney: ++reads === 1 ? 1000 : 500, pointValue: 1 }),
  });
  await robot.start();
  emit({ stream: 'live', history: history([candle(start, 99)]) }, start);
  emit({
    stream: 'live',
    history: history([candle(start + hour, 101)]),
    freshCandleTime: start + hour,
  });
  await setImmediate();
  emit({
    stream: 'live',
    history: history([candle(start + 2 * hour, 99)]),
    freshCandleTime: start + 2 * hour,
  });
  await setImmediate();
  assert.deepEqual(
    orders.map((order) => [order.fromPosition, order.targetPosition]),
    [
      [0, 8],
      [8, 0],
      [0, -4],
    ],
  );
  assert.equal(orders[1].context.type, 'signal');
  assert.ok(events.indexOf('cancel-stop') < events.indexOf('send-order:' + orders[1].id));
  assert.equal(robot.status().protection?.lots, 4);
});

test('opening gap exits without waiting for completion or reversing on the same candle', async () => {
  const { robot, orders, emit } = setup({ nativeProtection: true, submitProtection: 'confirmed' });
  await robot.start();
  emit({ stream: 'live', history: history([candle(start, 99)]) }, start);
  emit({
    stream: 'live',
    history: history([candle(start + hour, 101)]),
    freshCandleTime: start + hour,
  });
  await setImmediate();
  const gap = candle(start + 2 * hour, 99);
  emit(
    { stream: 'live', history: history([{ ...gap, complete: false }]), openedCandleTime: gap.time },
    gap.time,
  );
  await setImmediate();
  assert.deepEqual(
    orders.map((order) => order.targetPosition),
    [8, 0],
  );
  emit({ stream: 'live', history: history([gap]), freshCandleTime: gap.time });
  await setImmediate();
  assert.equal(orders.length, 2);
});

test('adds fixed lots only once per candle; insufficient margin does not consume a threshold', async () => {
  let margin = false;
  const h = setup({
    nativeProtection: true,
    submitProtection: 'confirmed',
    margin: () => margin,
    maxAddOns: 2,
  });
  await enterLong(h);
  const breakout = candle(start + 2 * hour, 110);
  await complete(h, breakout);
  margin = true;
  await complete(h, breakout);
  assert.equal(h.orders.length, 1);
  await complete(h, candle(start + 3 * hour, 110));
  await complete(h, candle(start + 4 * hour, 110));
  await complete(h, candle(start + 5 * hour, 110));
  assert.deepEqual(
    h.orders.map(({ lots, targetPosition }) => [lots, targetPosition]),
    [
      [8, 8],
      [8, 16],
      [8, 24],
    ],
  );
  assert.equal(h.robot.status().protection?.lots, 24);
  for (const add of h.orders.slice(1))
    assert.ok(
      h.events.indexOf(`reserve-order:${add.id}`) < h.events.indexOf(`send-order:${add.id}`),
    );
});

test('trailing replacement waits for cancellation evidence, covers the full position and never loosens', async () => {
  const h = setup({ nativeProtection: true, submitProtection: 'confirmed', maxAddOns: 0 });
  await enterLong(h);
  const initial = h.robot.status().protection!;
  await complete(h, candle(start + 2 * hour, 108));
  const unchanged = h.robot.status().protection!;
  assert.equal(unchanged.id, initial.id);
  await complete(h, candle(start + 3 * hour, 112));
  const trailed = h.robot.status().protection!;
  assert.equal(trailed.stop, 102);
  assert.equal(trailed.lots, 8);
  const cancel = h.events.indexOf('cancel-stop');
  assert.ok(h.events.lastIndexOf(`lookup-stop:${initial.id}`) > cancel);
  assert.ok(
    h.events.indexOf(`send-stop:${trailed.id}`) > h.events.lastIndexOf(`lookup-stop:${initial.id}`),
  );
  await complete(h, { ...candle(start + 4 * hour, 113), high: 140 });
  assert.equal(h.robot.status().protection?.id, trailed.id);
  assert.equal(h.orders.length, 1);
});

test('unknown cancellation never sends an add-on or replacement stop', async () => {
  const h = setup({
    nativeProtection: true,
    submitProtection: 'confirmed',
    margin: () => true,
    cancelStop: async () => {
      throw new Error('timeout');
    },
  });
  await enterLong(h);
  const original = h.robot.status().protection?.id;
  await complete(h, candle(start + 2 * hour, 110));
  assert.equal(h.orders.length, 1);
  assert.equal(h.robot.status().protection?.id, original);
  assert.equal(h.robot.status().protection?.cancellationPending, true);
  assert.equal(h.events.filter((event) => event.startsWith('send-stop:')).length, 1);
});

test('margin lost during preflight restores the old stop level without increasing exposure', async () => {
  let checks = 0;
  const h = setup({
    nativeProtection: true,
    submitProtection: 'confirmed',
    margin: () => ++checks === 1,
  });
  await enterLong(h);
  const original = h.robot.status().protection!;
  await complete(h, candle(start + 2 * hour, 110));
  const restored = h.robot.status().protection!;
  assert.notEqual(restored.id, original.id);
  assert.equal(restored.stop, original.stop);
  assert.equal(restored.lots, original.lots);
  assert.equal(h.orders.length, 1);
});

test('a native stop at the opening takes priority over the gap and suppresses the closing reversal', async () => {
  let hit = false;
  const h = setup({
    nativeProtection: true,
    submitProtection: 'confirmed',
    lookup: () =>
      hit
        ? { status: 'triggered', childId: 'native', childStatus: 'terminal' }
        : { status: 'active' },
    closeEvidence: async () => ({ status: 'triggered', childIds: ['native'] }),
    childEvidence: async () => ({ terminal: true, executedLots: 8 }),
  });
  await enterLong(h);
  const opened = candle(start + 2 * hour, 90);
  hit = true;
  h.setPosition(0);
  h.emit(
    {
      stream: 'live',
      history: history([{ ...opened, complete: false }]),
      openedCandleTime: opened.time,
    },
    opened.time,
  );
  await setImmediate();
  await complete(h, opened);
  assert.equal(h.orders.length, 1);
  assert.equal(h.events.includes('cancel-stop'), false);
  assert.equal(h.robot.status().protection, null);
});

for (const when of ['within the candle', 'after the next close', 'after reconnect'] as const) {
  test(`a deferred reversal reconciles the same order ${when}`, async () => {
    let completeExit = false;
    const h = setup({
      nativeProtection: true,
      submitProtection: 'confirmed',
      observeOrder: (order) => (order.targetPosition === 0 && !completeExit ? 'new' : 'filled'),
    });
    await enterLong(h);
    const reversal = candle(start + 2 * hour, 99);
    await complete(h, reversal);
    assert.equal(h.orders.length, 2);
    assert.equal(h.robot.status().recovery?.orderId, h.orders[1].id);
    completeExit = true;
    if (when === 'after the next close') {
      await complete(h, candle(start + 3 * hour, 98));
    } else if (when === 'after reconnect') {
      h.emit({ stream: 'disconnected' });
      h.emit({ stream: 'live', history: history([reversal]), recoveredAt: reversal.time + hour });
      await setImmediate();
    } else {
      h.emit({ stream: 'live', history: history([reversal]) });
      await setImmediate();
    }
    assert.equal(h.robot.status().recovery, undefined);
    assert.equal(h.orders.length, when === 'within the candle' ? 3 : 2);
    assert.equal(h.events.filter((event) => event === `send-order:${h.orders[1].id}`).length, 1);
  });
}

test('reconnect checks the live stop before accepting signals and never replays its baseline', async () => {
  const h = setup({ nativeProtection: true, submitProtection: 'throw' });
  await enterLong(h);
  const before = h.robot.status().protection!;
  assert.equal(before.state, 'unconfirmed');
  h.emit({ stream: 'disconnected' });
  const missed = candle(start + 2 * hour, 99);
  h.emit(
    {
      stream: 'live',
      history: history([candle(start + hour, 101), missed]),
      recoveredAt: missed.time + hour,
      freshCandleTime: missed.time,
    },
    missed.time + hour,
  );
  await setImmediate();
  assert.equal(h.robot.status().mode, 'running');
  assert.equal(h.events.at(-1), 'lookup-stop:' + before.id);
  assert.equal(h.orders.length, 1);
  await complete(h, missed);
  assert.equal(h.orders.length, 1);
  await complete(h, candle(start + 3 * hour, 101));
  await complete(h, candle(start + 4 * hour, 99));
  assert.deepEqual(
    h.orders.map((order) => order.targetPosition),
    [8, 0, -9],
  );
});

test('weekend opt-out still permits a protective gap exit', async () => {
  const h = setup({ nativeProtection: true, submitProtection: 'confirmed' });
  await enterLong(h);
  const saturday = candle(Date.UTC(2026, 10, 21), 99);
  h.emit(
    {
      stream: 'live',
      history: history([{ ...saturday, complete: false }]),
      openedCandleTime: saturday.time,
    },
    saturday.time,
  );
  await setImmediate();
  assert.deepEqual(
    h.orders.map((order) => order.targetPosition),
    [8, 0],
  );
});

test('a gap received while an add-on is in preflight wins over the increase', async () => {
  let approve!: (allowed: boolean) => void;
  const h = setup({
    nativeProtection: true,
    submitProtection: 'confirmed',
    margin: () =>
      new Promise((resolve) => {
        approve = resolve;
      }),
  });
  await enterLong(h);
  await complete(h, candle(start + 2 * hour, 110));
  const opened = candle(start + 3 * hour, 99);
  h.emit(
    {
      stream: 'live',
      history: history([{ ...opened, complete: false }]),
      openedCandleTime: opened.time,
    },
    opened.time,
  );
  approve(true);
  await setImmediate();
  assert.deepEqual(
    h.orders.map((order) => order.targetPosition),
    [8, 0],
  );
});

test('a stop triggered during cancellation forbids reversal even with zero native fills', async () => {
  let triggered = false;
  const h = setup({
    nativeProtection: true,
    submitProtection: 'confirmed',
    cancelStop: async () => {
      triggered = true;
    },
    closeEvidence: async () =>
      triggered ? { status: 'triggered', childIds: ['child'] } : { status: 'never-triggered' },
    childEvidence: async () => ({ terminal: true, executedLots: 0 }),
  });
  await enterLong(h);
  await complete(h, candle(start + 2 * hour, 99));
  assert.deepEqual(
    h.orders.map((order) => order.targetPosition),
    [8, 0],
  );
  assert.equal(h.robot.status().protection, null);
});

test('a terminal partial reversal exit restores protection on the verified remainder', async () => {
  let terminal = false;
  const h = setup({
    nativeProtection: true,
    submitProtection: 'confirmed',
    deferSubmit: (order) => order.targetPosition === 0,
    observeOrder: (order) =>
      order.targetPosition !== 0 ? 'filled' : terminal ? 'terminal-partial' : 'new',
  });
  await enterLong(h);
  const reversal = candle(start + 2 * hour, 99);
  await complete(h, reversal);
  terminal = true;
  h.setPosition(7);
  h.emit({ stream: 'live', history: history([reversal]) });
  await setImmediate();
  assert.equal(h.orders.length, 2);
  assert.equal(h.robot.status().recovery, undefined);
  assert.equal(h.robot.status().protection?.lots, 7);
  assert.equal(h.robot.status().protection?.state, 'confirmed');
});

async function enterLong(h: ReturnType<typeof setup>) {
  await h.robot.start();
  h.emit({ stream: 'live', history: history([candle(start, 99)]) }, start);
  await complete(h, candle(start + hour, 101));
  assert.equal(h.robot.status().position, 8);
}

async function complete(h: ReturnType<typeof setup>, value: ReturnType<typeof candle>) {
  h.emit({ stream: 'live', history: history([value]), freshCandleTime: value.time });
  await setImmediate();
}

test('final account read after claim forfeits and publishes a changed account', async () => {
  const { robot, emit, orders, transactions } = setup({
    finalAccount: { position: 0, activeOrders: true },
  });
  const publications: Promise<string[]>[] = [];
  robot.subscribe(() =>
    publications.push(transactions.history().then((rows) => rows.map((row) => row.status))),
  );
  await robot.start();
  emit({ stream: 'live', history: history([candle(start, 99)]) }, start);
  emit({
    stream: 'live',
    history: history([candle(start, 99), candle(start + hour, 101)]),
    freshCandleTime: start + hour,
  });
  await setImmediate();
  assert.equal(orders.length, 0);
  assert.equal(await transactions.loadProtectedEntry(), null);
  assert.equal((await transactions.history())[0].status, 'account-check-failed-before-send');
  assert.ok(
    (await Promise.all(publications)).some((rows) =>
      rows.includes('account-check-failed-before-send'),
    ),
  );
});

test('positive submit fill cannot be erased by a zero lookup', async () => {
  const { robot, emit, orders, transactions } = setup({ zeroLookup: true });
  await robot.start();
  emit({ stream: 'live', history: history([candle(start, 99)]) }, start);
  emit({
    stream: 'live',
    history: history([candle(start, 99), candle(start + hour, 101)]),
    freshCandleTime: start + hour,
  });
  await setImmediate();
  assert.equal(orders.length, 1);
  assert.ok(await transactions.loadProtectedEntry());
  assert.equal(robot.status().recovery?.ready, false);
  await robot.reconcile();
  assert.ok(await transactions.loadProtectedEntry());
});

test('cancelled entry with an inconsistent account remains unconfirmed and guarded', async () => {
  const { robot, emit, transactions } = setup({
    zeroSubmit: true,
    zeroLookup: true,
    observedAccount: { position: 1, activeOrders: false },
  });
  await robot.start();
  emit({ stream: 'live', history: history([candle(start, 99)]) }, start);
  emit({
    stream: 'live',
    history: history([candle(start, 99), candle(start + hour, 101)]),
    freshCandleTime: start + hour,
  });
  await setImmediate();
  await robot.reconcile();
  assert.ok(await transactions.loadProtectedEntry());
  assert.equal((await transactions.history())[0].status, 'unconfirmed');
});

for (const failure of ['before', 'cancel', 'observed'] as const) {
  test(`postcommit ${failure} release reload permits a fresh start without another send`, async () => {
    let sessions = 0;
    let claimed!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => (claimed = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { robot, emit, orders, transactions, setNow } = setup({
      failRelease: failure,
      zeroLookup: failure === 'observed',
      zeroSubmit: failure === 'observed',
      session: async () =>
        failure === 'before' && ++sessions === 2
          ? null
          : { start: start - hour, end: start + 48 * hour },
      claimDelay:
        failure === 'cancel'
          ? async () => {
              claimed();
              await gate;
            }
          : undefined,
    });
    await robot.start();
    emit({ stream: 'live', history: history([candle(start, 99)]) }, start);
    emit({
      stream: 'live',
      history: history([candle(start, 99), candle(start + hour, 101)]),
      freshCandleTime: start + hour,
    });
    if (failure === 'cancel') {
      await reached;
      setNow(start + 3 * hour);
      release();
    }
    await setImmediate();
    if (failure === 'observed') await robot.reconcile();
    assert.equal(await transactions.loadProtectedEntry(), null);
    assert.equal(robot.status().recovery, undefined);
    const sent = orders.length;
    await robot.stop();
    await robot.start();
    assert.equal(orders.length, sent);
  });
}

for (const interruption of ['stop', 'feed', 'expiry'] as const) {
  test(`acknowledged delayed entry claim is cancelled after ${interruption}`, async () => {
    let release!: () => void;
    let claimed!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const reached = new Promise<void>((resolve) => (claimed = resolve));
    const { robot, emit, orders, setNow, events } = setup({
      claimDelay: async () => {
        claimed();
        await gate;
      },
    });
    await robot.start();
    emit({ stream: 'live', history: history([candle(start, 99)]) }, start);
    emit({
      stream: 'live',
      history: history([candle(start, 99), candle(start + hour, 101)]),
      freshCandleTime: start + hour,
    });
    await reached;
    if (interruption === 'stop') await robot.stop();
    if (interruption === 'feed') emit({ stream: 'disconnected' });
    if (interruption === 'expiry') setNow(start + 3 * hour);
    release();
    await setImmediate();
    assert.equal(orders.length, 0);
    assert.equal(
      events.some((event) => event.startsWith('send-stop:')),
      false,
    );
  });
}

for (const failure of ['precommit', 'postcommit'] as const) {
  test(`entry settlement ${failure} reloads without another send`, async () => {
    const { robot, emit, orders, events } = setup({ settlementFailure: failure });
    await robot.start();
    emit({ stream: 'live', history: history([candle(start, 99)]) }, start);
    emit({
      stream: 'live',
      history: history([candle(start, 99), candle(start + hour, 101)]),
      freshCandleTime: start + hour,
    });
    await setImmediate();
    assert.equal(orders.length, 1);
    assert.equal(
      events.some((event) => event.startsWith('send-stop:')),
      false,
    );
    assert.equal(
      robot.status().reason,
      failure === 'precommit' ? 'ROBOT_ORDER_UNRESOLVED' : 'ROBOT_PROTECTION_UNRESOLVED',
    );
    if (failure === 'precommit') assert.equal(robot.status().recovery?.ready, false);
  });
}

test('failed settlement retains submit fill evidence against a flat zero-fill lookup', async () => {
  const { robot, emit, transactions } = setup({
    settlementFailureOnce: true,
    zeroLookup: true,
    observedAccount: { position: 0, activeOrders: false },
  });
  await robot.start();
  emit({ stream: 'live', history: history([candle(start, 99)]) }, start);
  emit({
    stream: 'live',
    history: history([candle(start, 99), candle(start + hour, 101)]),
    freshCandleTime: start + hour,
  });
  await setImmediate();
  await robot.reconcile();
  assert.ok(await transactions.loadProtectedEntry());
  assert.equal(await transactions.hasUnresolved(), true);
  assert.equal(robot.status().reason, 'ROBOT_ORDER_UNRESOLVED');
});

test('stop during settlement publishes committed protection without sending it', async () => {
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const pending = new Promise<void>((resolve) => (reached = resolve));
  const { robot, emit, events, transactions } = setup({
    settlementDelay: async () => {
      reached();
      await gate;
    },
  });
  const snapshots: ReturnType<typeof robot.status>[] = [];
  robot.subscribe(() => snapshots.push(robot.status()));
  await robot.start();
  emit({ stream: 'live', history: history([candle(start, 99)]) }, start);
  emit({
    stream: 'live',
    history: history([candle(start, 99), candle(start + hour, 101)]),
    freshCandleTime: start + hour,
  });
  await pending;
  robot.stop();
  release();
  await setImmediate();
  assert.equal((await transactions.loadProtection())?.state, 'not-sent');
  assert.equal(snapshots.at(-1)?.mode, 'stopped');
  assert.equal(snapshots.at(-1)?.protection?.state, 'not-sent');
  assert.equal(
    events.some((event) => event.startsWith('send-stop:')),
    false,
  );
});

test('postcommit release reload preserves a concurrent feed-loss reason', async () => {
  let release!: () => void;
  let reached!: () => void;
  let sessions = 0;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const pending = new Promise<void>((resolve) => (reached = resolve));
  const { robot, emit, transactions } = setup({
    failRelease: 'before',
    session: async () =>
      ++sessions === 2 ? null : { start: start - hour, end: start + 48 * hour },
    releaseDelay: async () => {
      reached();
      await gate;
    },
  });
  await robot.start();
  emit({ stream: 'live', history: history([candle(start, 99)]) }, start);
  emit({
    stream: 'live',
    history: history([candle(start, 99), candle(start + hour, 101)]),
    freshCandleTime: start + hour,
  });
  await pending;
  emit({ stream: 'disconnected' });
  release();
  await setImmediate();
  assert.equal(await transactions.loadProtectedEntry(), null);
  assert.equal(robot.status().mode, 'reconnecting');
  assert.equal(robot.status().reason, 'ROBOT_FEED_LOST');
});

for (const partial of ['cancelled', 'partial'] as const) {
  test(`explicit recovery of ${partial} partial entry never sends a stop`, async () => {
    const { robot, emit, orders, events } = setup({ partial });
    await robot.start();
    emit({ stream: 'live', history: history([candle(start, 99)]) }, start);
    emit({
      stream: 'live',
      history: history([candle(start, 99), candle(start + hour, 101)]),
      freshCandleTime: start + hour,
    });
    await setImmediate();
    assert.equal(orders.length, 1);
    await robot.reconcile();
    assert.equal(events.filter((event) => event.startsWith('send-order:')).length, 1);
    assert.equal(
      events.some((event) => event.startsWith('send-stop:')),
      false,
    );
    if (partial === 'cancelled') {
      assert.equal(robot.status().reason, 'ROBOT_PROTECTION_UNRESOLVED');
      assert.equal(robot.status().protection?.lots, 1);
      assert.equal(robot.status().protection?.state, 'not-sent');
    } else {
      assert.equal(robot.status().recovery?.ready, false);
    }
  });
}

test('known incomplete preceding candle blocks crossing until resolved and contributes to ATR', async () => {
  const { robot, emit, orders } = setup({ atrPeriod: 2, submitProtection: 'confirmed' });
  await robot.start();
  const warmup = candle(start - hour, 99);
  const first = candle(start, 99);
  const middle = { ...candle(start + hour, 99), high: 110 };
  const crossing = candle(start + 2 * hour, 101);
  emit(
    { stream: 'live', history: history([warmup, first, { ...middle, complete: false }]) },
    start + hour,
  );
  emit({ stream: 'live', history: history([crossing]), freshCandleTime: crossing.time });
  await setImmediate();
  assert.equal(orders.length, 0);
  emit({ stream: 'live', history: history([middle]) }, start + 3 * hour);
  emit({ stream: 'live', history: history([crossing]), freshCandleTime: crossing.time });
  await setImmediate();
  assert.equal(orders.length, 1);
  // True ranges A=2 and B=12 seed ATR at 7; C=3 advances it to 5.
  assert.equal(robot.status().protection?.stop, 91);
});

test('premature marker retains incomplete evidence and cannot make it fresh', async () => {
  const { robot, emit, orders } = setup({ atrPeriod: 2, submitProtection: 'confirmed' });
  await robot.start();
  const first = candle(start, 99);
  const middle = { ...candle(start + hour, 99), high: 110 };
  const crossing = candle(start + 2 * hour, 101);
  emit({ stream: 'live', history: history([first]) }, start);
  emit(
    {
      stream: 'live',
      history: history([{ ...middle, complete: false }]),
      freshCandleTime: middle.time,
    },
    middle.time,
  );
  emit({ stream: 'live', history: history([crossing]), freshCandleTime: crossing.time });
  await setImmediate();
  assert.equal(orders.length, 0);
  emit({ stream: 'live', history: history([middle]) }, crossing.time + hour);
  await setImmediate();
  assert.equal(orders.length, 0);
  emit({ stream: 'live', history: history([crossing]), freshCandleTime: crossing.time });
  await setImmediate();
  assert.equal(orders.length, 1);
  assert.equal(robot.status().protection?.stop, 86);
});

test('an unresolved candle cannot keep an unbounded history running', async () => {
  const { robot, emit, orders } = setup();
  await robot.start();
  emit(
    { stream: 'live', history: history([{ ...candle(start, 99), complete: false }]) },
    start + hour,
  );
  const completed = Array.from({ length: 4100 }, (_, i) => candle(start + (i + 1) * hour, 99));
  emit({ stream: 'live', history: history(completed) }, start + 4101 * hour);
  assert.equal(robot.status().mode, 'paused');
  assert.equal(robot.status().reason, 'ROBOT_FEED_LOST');
  emit({
    stream: 'live',
    history: history([candle(start + 4101 * hour, 101)]),
    freshCandleTime: start + 4101 * hour,
  });
  await setImmediate();
  assert.equal(orders.length, 0);
});

test('newer incomplete candle permits checkpoint eviction without losing Wilder ATR', async () => {
  const { robot, emit, orders } = setup({
    atrPeriod: 4096,
    submitProtection: 'confirmed',
    session: async (time) => ({ start: time - hour, end: time + hour }),
  });
  await robot.start();
  const completed = Array.from({ length: 4096 }, (_, i) => candle(start + i * hour, 99));
  completed[0] = candle(start, 90);
  emit({ stream: 'live', history: history(completed) }, start + 4096 * hour);
  const crossing = candle(start + 4096 * hour, 101);
  emit({ stream: 'live', history: history([{ ...crossing, complete: false }]) }, crossing.time);
  assert.equal(robot.status().mode, 'running');
  emit({ stream: 'live', history: history([crossing]), freshCandleTime: crossing.time });
  await setImmediate();
  assert.equal(orders.length, 1);
  const atr = (10 + 4094 * 2 + 3) / 4096;
  assert.equal(robot.status().protection?.stop, 101 - 2 * atr);
});

test('seeded Wilder ATR checkpoint survives repeated evictions', async () => {
  const { robot, emit, orders } = setup({
    atrPeriod: 4096,
    submitProtection: 'confirmed',
    session: async (time) => ({ start: time - hour, end: time + hour }),
  });
  await robot.start();
  // Pick a weekday after enough evictions to seed and then advance the checkpoint.
  let count = 8198;
  while ([0, 6].includes(new Date(start + (count + 1) * hour + 3 * hour).getUTCDay())) count++;
  const completed = Array.from({ length: count }, (_, i) => candle(start + i * hour, 99));
  completed[0] = candle(start, 90);
  emit({ stream: 'live', history: history(completed) }, start + count * hour);
  const crossing = candle(start + count * hour, 101);
  emit({ stream: 'live', history: history([crossing]), freshCandleTime: crossing.time });
  await setImmediate();
  assert.equal(orders.length, 1);
  let atr = (10 + 4095 * 2) / 4096;
  for (let i = 4097; i < count; i++) atr = (atr * 4095 + 2) / 4096;
  atr = (atr * 4095 + 3) / 4096;
  assert.equal(robot.status().protection?.stop, 101 - 2 * atr);
});

test('premature marker does not hide a correction to a pending crossing', async () => {
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => (release = resolve));
  const rechecking = new Promise<void>((resolve) => (entered = resolve));
  const { robot, emit, orders, events, records } = setup({
    recheck: async () => {
      entered();
      await blocked;
    },
  });
  await robot.start();
  const first = candle(start, 99);
  const crossing = candle(start + hour, 101);
  const next = candle(start + 2 * hour, 102);
  emit({ stream: 'live', history: history([first]) }, start);
  emit({ stream: 'live', history: history([crossing]), freshCandleTime: crossing.time });
  await rechecking;
  emit(
    {
      stream: 'live',
      history: history([{ ...crossing, confirmedEma: 102 }, next]),
      freshCandleTime: next.time,
    },
    next.time,
  );
  release();
  await setImmediate();
  const reservation = events.find((event) => event.startsWith('reserve-order:'))!;
  assert.deepEqual(records, [
    { id: reservation.slice('reserve-order:'.length), status: 'stale-signal-before-send' },
  ]);
  assert.equal(orders.length, 0);
});

test('premature marker for a cached completed candle preserves the queued crossing', async () => {
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => (release = resolve));
  const rechecking = new Promise<void>((resolve) => (entered = resolve));
  const { robot, emit, orders, setNow } = setup({
    recheck: async () => {
      entered();
      await blocked;
    },
  });
  await robot.start();
  const first = candle(start, 99);
  const crossing = candle(start + hour, 101);
  const next = candle(start + 2 * hour, 99);
  emit({ stream: 'live', history: history([first]) }, start);
  emit({ stream: 'live', history: history([crossing]), freshCandleTime: crossing.time });
  await rechecking;
  emit({ stream: 'live', history: history([next]), freshCandleTime: next.time });
  emit({ stream: 'live', history: history([next]), freshCandleTime: next.time }, next.time);
  // Restore the clock to the valid candidate's completion time.
  setNow(next.time + hour);
  release();
  await setImmediate();
  assert.equal(orders.length, 1);
  assert.equal(orders[0].direction, 'sell');
});

test('scheduled gaps do not block a confirmed crossing', async () => {
  const { robot, emit, orders } = setup();
  await robot.start();
  const first = candle(start, 99);
  const crossing = candle(start + 3 * hour, 101);
  emit({ stream: 'live', history: history([first]) }, start);
  emit({ stream: 'live', history: history([crossing]), freshCandleTime: crossing.time });
  await setImmediate();
  assert.equal(orders.length, 1);
});

test('premature marker cannot become tradable on a later snapshot', async () => {
  const { robot, emit, orders } = setup();
  await robot.start();
  const first = candle(start, 99);
  const crossing = candle(start + hour, 101);
  emit({ stream: 'live', history: history([first]) }, start);
  emit(
    {
      stream: 'live',
      history: history([{ ...crossing, complete: false }]),
      freshCandleTime: crossing.time,
    },
    start + hour,
  );
  emit({ stream: 'live', history: history([crossing]) }, start + 2 * hour);
  await setImmediate();
  assert.equal(orders.length, 0);
});

test('premature marker does not displace a valid queued crossing', async () => {
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => (release = resolve));
  const rechecking = new Promise<void>((resolve) => (entered = resolve));
  const { robot, emit, orders } = setup({
    recheck: async () => {
      entered();
      await blocked;
    },
  });
  await robot.start();
  const first = candle(start, 99);
  const crossing = candle(start + hour, 101);
  const next = candle(start + 2 * hour, 99);
  const premature = candle(start + 3 * hour, 101);
  emit({ stream: 'live', history: history([first]) }, start);
  emit({ stream: 'live', history: history([crossing]), freshCandleTime: crossing.time });
  await rechecking;
  emit({ stream: 'live', history: history([next]), freshCandleTime: next.time });
  emit(
    {
      stream: 'live',
      history: history([premature]),
      freshCandleTime: premature.time,
    },
    start + 3 * hour,
  );
  release();
  await setImmediate();
  assert.equal(orders.length, 1);
  assert.equal(orders[0].direction, 'sell');
});

test('final expiry and session checks share the exact deadline timestamp', async () => {
  let final = false;
  let reads = 0;
  const { robot, emit, orders, records } = setup({
    session: async () => ({ start, end: start + 4 * hour }),
    finalRecheck: async () => {
      final = true;
    },
    clock: (now) => (final ? start + 3 * hour - 1 + reads++ : now),
  });
  await robot.start();
  emit({ stream: 'live', history: history([candle(start, 99)]) }, start);
  emit({
    stream: 'live',
    history: history([candle(start + hour, 101)]),
    freshCandleTime: start + hour,
  });
  await setImmediate();
  assert.equal(orders.length, 1);
  assert.notEqual(records[0]?.status, 'stale-signal-before-send');
  assert.equal(reads, 1);
});

test('Wilder ATR retains its seed as feed history is trimmed before a crossing', async () => {
  const { robot, emit, orders } = setup({ atrPeriod: 2, submitProtection: 'confirmed' });
  await robot.start();
  const candles = [
    candle(start, 99),
    { ...candle(start + hour, 99), high: 110 },
    candle(start + 2 * hour, 99),
    candle(start + 3 * hour, 99),
    candle(start + 4 * hour, 101),
  ];
  emit({ stream: 'live', history: history(candles.slice(0, 3)) }, start + 3 * hour);
  emit(
    { stream: 'live', history: history(candles.slice(1, 4)), freshCandleTime: start + 3 * hour },
    start + 4 * hour,
  );
  emit(
    { stream: 'live', history: history(candles.slice(2)), freshCandleTime: start + 4 * hour },
    start + 5 * hour,
  );
  await setImmediate();
  assert.equal(orders.length, 1);
  assert.equal(robot.status().protection?.stop, 93.5);
});

test('a corrected retained candle is included in the Wilder seed', async () => {
  const { robot, emit, orders } = setup({ atrPeriod: 2, submitProtection: 'confirmed' });
  await robot.start();
  const first = candle(start, 99);
  const second = { ...candle(start + hour, 99), high: 110 };
  const third = candle(start + 2 * hour, 99);
  emit({ stream: 'live', history: history([first, second, third]) }, start + 3 * hour);
  const fourth = candle(start + 3 * hour, 99);
  emit(
    {
      stream: 'live',
      history: history([{ ...second, high: 106 }, third, fourth]),
      freshCandleTime: fourth.time,
    },
    start + 4 * hour,
  );
  const fifth = candle(start + 4 * hour, 101);
  emit(
    { stream: 'live', history: history([third, fourth, fifth]), freshCandleTime: fifth.time },
    start + 5 * hour,
  );
  await setImmediate();
  assert.equal(orders.length, 1);
  assert.equal(robot.status().protection?.stop, 94.5);
});

test('ordinary entry is skipped when there is no eligible trading session', async () => {
  const { robot, emit, orders, events } = setup({ session: async () => null });
  await robot.start();
  emit({ stream: 'live', history: history([candle(start, 99)]) }, start);
  emit({
    stream: 'live',
    history: history([candle(start, 99), candle(start + hour, 101)]),
    freshCandleTime: start + hour,
  });
  await setImmediate();
  assert.equal(orders.length, 0);
  assert.equal(
    events.some((event) => event.startsWith('reserve-order:')),
    false,
  );
});

for (const failedLookup of [1, 2]) {
  test(`superseded calendar lookup ${failedLookup} cannot pause recovery or strand a reservation`, async () => {
    let rejectLookup!: (error: Error) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => (entered = resolve));
    let calls = 0;
    const { robot, emit, orders, records, events } = setup({
      session: async () => {
        if (++calls === failedLookup) {
          entered();
          return new Promise((_, reject) => (rejectLookup = reject));
        }
        return { start, end: start + 48 * hour };
      },
    });
    await robot.start();
    emit({ stream: 'live', history: history([candle(start, 99)]) }, start);
    const old = [candle(start, 99), candle(start + hour, 101)];
    emit({ stream: 'live', history: history(old), freshCandleTime: start + hour });
    await started;
    const reservation = events.find((event) => event.startsWith('reserve-order:'));
    emit({ stream: 'disconnected' });
    emit({ stream: 'live', recoveredAt: start + 2 * hour, history: history(old) });
    emit({
      stream: 'live',
      history: history([...old, candle(start + 2 * hour, 99)]),
      freshCandleTime: start + 2 * hour,
    });
    rejectLookup(new Error('old calendar failed'));
    await setImmediate();
    if (failedLookup === 2) {
      assert.ok(reservation);
      assert.deepEqual(records[0], {
        id: reservation.slice('reserve-order:'.length),
        status: 'feed-lost-before-send',
      });
    }
    assert.equal(orders.length, 0);
    assert.equal(robot.status().mode, 'reconnecting');
    assert.equal(robot.status().reason, 'ROBOT_FEED_LOST');
  });
}

test('current second calendar lookup failure finalizes its reservation and pauses', async () => {
  let calls = 0;
  const { robot, emit, orders, records, events } = setup({
    session: async () => {
      if (++calls === 2) throw new Error('calendar unavailable');
      return { start, end: start + 48 * hour };
    },
  });
  await robot.start();
  emit({ stream: 'live', history: history([candle(start, 99)]) }, start);
  emit({
    stream: 'live',
    history: history([candle(start, 99), candle(start + hour, 101)]),
    freshCandleTime: start + hour,
  });
  await setImmediate();
  const reservation = events.find((event) => event.startsWith('reserve-order:'))!;
  assert.deepEqual(records, [
    {
      id: reservation.slice('reserve-order:'.length),
      status: 'session-check-failed-before-send',
    },
  ]);
  assert.equal(orders.length, 0);
  assert.equal(robot.status().reason, 'ROBOT_TRADE_FAILED');
});

test('recovery between calendar error handling and outer catch does not pause the new session', async () => {
  let calls = 0;
  let publicationsAfterRecovery = 0;
  const { robot, emit, orders, records } = setup({
    session: async () => {
      if (++calls === 2) throw new Error('calendar unavailable');
      return { start, end: start + 48 * hour };
    },
    recorded: (status) => {
      if (status === 'session-check-failed-before-send') recover();
    },
  });
  const publications: { mode: string; records: string[] }[] = [];
  robot.subscribe(() =>
    publications.push({
      mode: robot.status().mode,
      records: records.map((record) => record.status),
    }),
  );
  await robot.start();
  emit({ stream: 'live', history: history([candle(start, 99)]) }, start);
  const old = [candle(start, 99), candle(start + hour, 101)];
  const recover = () => {
    emit({ stream: 'disconnected' });
    emit({ stream: 'live', recoveredAt: start + 2 * hour, history: history(old) });
    publicationsAfterRecovery = publications.length;
  };
  emit({ stream: 'live', history: history(old), freshCandleTime: start + hour });
  await setImmediate();
  assert.equal(records[0].status, 'session-check-failed-before-send');
  assert.equal(orders.length, 0);
  assert.equal(robot.status().mode, 'reconnecting');
  assert.equal(robot.status().reason, 'ROBOT_FEED_LOST');
  assert.ok(publicationsAfterRecovery > 0);
  assert.ok(publications.length > publicationsAfterRecovery);
  assert.deepEqual(publications.at(-1), {
    mode: 'reconnecting',
    records: ['session-check-failed-before-send'],
  });
});

test('stopping during terminal recording still publishes the record after stop returns', async () => {
  let calls = 0;
  let publicationsAfterStop: number | undefined;
  const { robot, emit, orders, records } = setup({
    session: async () => {
      if (++calls === 2) throw new Error('calendar unavailable');
      return { start, end: start + 48 * hour };
    },
    recorded: (status) => {
      if (status === 'session-check-failed-before-send') {
        robot.stop();
        publicationsAfterStop = publications.length;
      }
    },
  });
  const publications: { mode: string; records: string[] }[] = [];
  robot.subscribe(() =>
    publications.push({
      mode: robot.status().mode,
      records: records.map((record) => record.status),
    }),
  );
  await robot.start();
  emit({ stream: 'live', history: history([candle(start, 99)]) }, start);
  emit({
    stream: 'live',
    history: history([candle(start, 99), candle(start + hour, 101)]),
    freshCandleTime: start + hour,
  });
  await setImmediate();
  assert.equal(records[0].status, 'session-check-failed-before-send');
  assert.equal(orders.length, 0);
  assert.equal(robot.status().mode, 'stopped');
  assert.notEqual(publicationsAfterStop, undefined);
  assert.ok(publications.length > publicationsAfterStop!);
  assert.deepEqual(publications.at(-1), {
    mode: 'stopped',
    records: ['session-check-failed-before-send'],
  });
});

test('second calendar lookup can reject a reserved entry and publishes its terminal record', async () => {
  let calls = 0;
  const { robot, emit, orders, records, events } = setup({
    session: async () => (++calls === 1 ? { start, end: start + 48 * hour } : null),
  });
  const publishedRecords: string[][] = [];
  robot.subscribe(() => publishedRecords.push(records.map((record) => record.status)));
  await robot.start();
  emit({ stream: 'live', history: history([candle(start, 99)]) }, start);
  emit({
    stream: 'live',
    history: history([candle(start, 99), candle(start + hour, 101)]),
    freshCandleTime: start + hour,
  });
  await setImmediate();
  const reservation = events.find((event) => event.startsWith('reserve-order:'))!;
  assert.equal(calls, 2);
  assert.deepEqual(records, [
    { id: reservation.slice('reserve-order:'.length), status: 'session-ended-before-send' },
  ]);
  assert.equal(orders.length, 0);
  assert.deepEqual(publishedRecords.at(-1), ['session-ended-before-send']);
});

test('the final account recheck follows the second calendar lookup', async () => {
  const steps: string[] = [];
  const { robot, emit, orders } = setup({
    session: async () => {
      steps.push('calendar');
      return { start, end: start + 48 * hour };
    },
    recheck: async () => {
      steps.push('account');
    },
  });
  await robot.start();
  emit({ stream: 'live', history: history([candle(start, 99)]) }, start);
  emit({
    stream: 'live',
    history: history([candle(start, 99), candle(start + hour, 101)]),
    freshCandleTime: start + hour,
  });
  await setImmediate();
  assert.deepEqual(steps, ['calendar', 'calendar', 'account']);
  assert.equal(orders.length, 1);
});

test('reserved entry is not dispatched after its session ends during preflight', async () => {
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => (release = resolve));
  const rechecking = new Promise<void>((resolve) => (entered = resolve));
  const { robot, emit, orders, records, setNow } = setup({
    session: async () => ({ start, end: start + 2 * hour + 1000 }),
    recheck: async () => {
      entered();
      await blocked;
    },
  });
  await robot.start();
  emit({ stream: 'live', history: history([candle(start, 99)]) }, start);
  emit({
    stream: 'live',
    history: history([candle(start, 99), candle(start + hour, 101)]),
    freshCandleTime: start + hour,
  });
  await rechecking;
  setNow(start + 2 * hour + 1000);
  release();
  await setImmediate();
  assert.equal(orders.length, 0);
  assert.equal(records[0].status, 'session-ended-before-send');
});

test('recovery does not enable trading without verified continuity and reconciliation', async () => {
  const { robot, emit, orders } = setup();
  await robot.start();
  emit({ stream: 'live', history: history([candle(start + 9 * hour, 99)]) }, start + 9 * hour);
  emit({ stream: 'disconnected' });
  const recoveredAt = start + 10 * hour + 23 * 60_000;
  const snapshot = history([candle(start + 9 * hour, 99), candle(start + 10 * hour, 101)]);
  emit(
    { stream: 'live', recoveredAt, history: snapshot, freshCandleTime: start + 10 * hour },
    recoveredAt,
  );
  await setImmediate();
  assert.equal(orders.length, 0);
  emit(
    { stream: 'live', history: snapshot, freshCandleTime: start + 10 * hour },
    start + 11 * hour,
  );
  await setImmediate();
  assert.equal(orders.length, 0);
  assert.equal(robot.status().mode, 'reconnecting');
});

test('a closed crossing in the recovery snapshot never trades even if later marked fresh', async () => {
  const { robot, emit, orders, events } = setup();
  await robot.start();
  const baseline = candle(start + 9 * hour, 99);
  const crossingTime = start + 10 * hour;
  emit({ stream: 'live', history: history([baseline]) }, crossingTime);
  emit({ stream: 'disconnected' });

  // The crossing closed before recovery, but remains within its freshness window.
  const recoveredAt = start + 11 * hour + 10 * 60_000;
  const snapshot = history([baseline, candle(crossingTime, 101)]);
  emit(
    { stream: 'live', recoveredAt, history: snapshot, freshCandleTime: crossingTime },
    recoveredAt,
  );
  await setImmediate();
  assert.equal(orders.length, 0);
  assert.equal(
    events.some((event) => event.startsWith('reserve-order:')),
    false,
  );

  emit(
    { stream: 'live', history: snapshot, freshCandleTime: crossingTime },
    recoveredAt + 5 * 60_000,
  );
  await setImmediate();
  assert.equal(orders.length, 0);
  assert.equal(
    events.some((event) => event.startsWith('reserve-order:')),
    false,
  );
});

test('stale sizing rejection does not pause the recovered session or discard its queued crossing', async () => {
  let rejectSizing!: (error: Error) => void;
  let entered!: () => void;
  const sizingStarted = new Promise<void>((resolve) => (entered = resolve));
  let calls = 0;
  const { robot, emit, orders } = setup({
    sizing: () => {
      if (++calls > 1) return Promise.resolve({ freeMoney: 1000, pointValue: 1 });
      entered();
      return new Promise((_, reject) => (rejectSizing = reject));
    },
  });
  await robot.start();
  emit({ stream: 'live', history: history([candle(start, 99)]) }, start);
  const old = [candle(start, 99), candle(start + hour, 101)];
  emit({ stream: 'live', history: history(old), freshCandleTime: start + hour });
  await sizingStarted;
  emit({ stream: 'disconnected' });
  emit({ stream: 'live', recoveredAt: start + 2 * hour, history: history(old) });
  const recovered = [...old, candle(start + 2 * hour, 99)];
  emit({ stream: 'live', history: history(recovered), freshCandleTime: start + 2 * hour });
  rejectSizing(new Error('old session failed'));
  await setImmediate();
  assert.equal(orders.length, 0);
  assert.equal(robot.status().mode, 'reconnecting');
  assert.equal(robot.status().reason, 'ROBOT_FEED_LOST');
});

test('sizing rejection in the current session pauses trading', async () => {
  const { robot, emit, orders } = setup({
    sizing: async () => {
      throw new Error('sizing unavailable');
    },
  });
  await robot.start();
  emit({ stream: 'live', history: history([candle(start, 99)]) }, start);
  emit({
    stream: 'live',
    history: history([candle(start, 99), candle(start + hour, 101)]),
    freshCandleTime: start + hour,
  });
  await setImmediate();
  assert.equal(orders.length, 0);
  assert.equal(robot.status().reason, 'ROBOT_TRADE_FAILED');
});

test('snapshot never trades; fresh crossing reserves entry and protection before sending, then reconciles original stop ID', async () => {
  const { robot, events, orders, emit } = setup();
  await robot.start();
  const candles = [candle(start, 99), candle(start + 1 * hour, 101)];
  emit({ stream: 'live', history: history(candles) });
  await setImmediate();
  assert.equal(orders.length, 0);
  emit({ stream: 'live', history: history(candles), freshCandleTime: start + 1 * hour });
  await setImmediate();
  assert.equal(orders.length, 1);
  assert.equal(orders[0].lots, 8);
  const stop = robot.status().protection!;
  assert.deepEqual(events.slice(0, 5), [
    'reserve-order:' + orders[0].id,
    'reserve-stop:' + stop.id,
    'send-order:' + orders[0].id,
    'lookup-order:' + orders[0].id,
    'send-stop:' + stop.id,
  ]);
  assert.equal(stop.stop, 95);
  assert.equal(stop.state, 'unconfirmed');
  emit({ stream: 'live', history: history(candles), freshCandleTime: start + 1 * hour });
  robot.stop();
  await assert.rejects(robot.closePosition(config), { code: 'ROBOT_PROTECTION_UNRESOLVED' });
  await robot.reconcileProtection();
  assert.equal(events.at(-1), 'lookup-stop:' + stop.id);
  assert.equal(robot.status().protection?.state, 'absent');
  assert.deepEqual(robot.status().protection?.observation, { status: 'absent' });
  assert.equal(orders.length, 1);
});

test('a delayed confirmation cannot trade after a newer completed candle', async () => {
  const { robot, emit, orders, events } = setup();
  await robot.start();
  emit({ stream: 'live', history: history([candle(start, 99)]) }, start);
  emit(
    {
      stream: 'live',
      history: history([
        candle(start, 99),
        candle(start + 1 * hour, 101),
        candle(start + 2 * hour, 102),
      ]),
      freshCandleTime: start + 1 * hour,
    },
    start + 3 * hour,
  );
  await setImmediate();
  assert.equal(orders.length, 0);
  assert.equal(
    events.some((event) => event.startsWith('reserve-order:')),
    false,
  );
});

test('a delayed confirmation cannot trade after the next candle should have closed', async () => {
  const { robot, emit, orders, events } = setup();
  await robot.start();
  emit({ stream: 'live', history: history([candle(start, 99)]) });
  emit(
    {
      stream: 'live',
      history: history([candle(start, 99), candle(start + 1 * hour, 101)]),
      freshCandleTime: start + 1 * hour,
    },
    start + 1 * hour + 2 * hour,
  );
  await setImmediate();
  assert.equal(orders.length, 0);
  assert.equal(
    events.some((event) => event.startsWith('reserve-order:')),
    false,
  );
});

for (const staleBy of ['expiry', 'newer candle'] as const) {
  test(`reserved entry is not sent when ${staleBy} occurs during account recheck`, async () => {
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const rechecking = new Promise<void>((resolve) => (entered = resolve));
    const { robot, emit, orders, events, records, setNow } = setup({
      recheck: async () => {
        entered();
        await blocked;
      },
    });
    await robot.start();
    emit({ stream: 'live', history: history([candle(start, 99)]) }, start);
    const candles = [candle(start, 99), candle(start + hour, 101)];
    emit(
      { stream: 'live', history: history(candles), freshCandleTime: start + hour },
      start + 2 * hour,
    );
    await rechecking;
    const reservation = events.find((event) => event.startsWith('reserve-order:'));
    assert.ok(reservation);
    if (staleBy === 'expiry') setNow(start + 3 * hour);
    else
      emit(
        { stream: 'live', history: history([...candles, candle(start + 2 * hour, 102)]) },
        start + 2 * hour,
      );
    release();
    await setImmediate();
    assert.equal(orders.length, 0);
    assert.deepEqual(records, [
      { id: reservation.slice('reserve-order:'.length), status: 'stale-signal-before-send' },
    ]);
  });
}

test('correction during final account check finalizes the original reservation without retry', async () => {
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => (release = resolve));
  const rechecking = new Promise<void>((resolve) => (entered = resolve));
  const { robot, emit, orders, events, records } = setup({
    recheck: async () => {
      entered();
      await blocked;
    },
  });
  await robot.start();
  const first = candle(start, 99);
  const crossing = candle(start + hour, 101);
  emit({ stream: 'live', history: history([first]) }, start);
  emit({ stream: 'live', history: history([first, crossing]), freshCandleTime: crossing.time });
  await rechecking;
  emit({ stream: 'live', history: history([first, { ...crossing, confirmedEma: 102 }]) });
  release();
  await setImmediate();
  const reservation = events.find((event) => event.startsWith('reserve-order:'))!;
  assert.deepEqual(records, [
    { id: reservation.slice('reserve-order:'.length), status: 'stale-signal-before-send' },
  ]);
  emit({ stream: 'live', history: history([first, crossing]), freshCandleTime: crossing.time });
  await setImmediate();
  assert.equal(orders.length, 0);
});

test('correction during sizing prevents a stale reservation', async () => {
  let release!: (value: { freeMoney: number; pointValue: number }) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const { robot, emit, events } = setup({
    sizing: () => {
      entered();
      return new Promise((resolve) => (release = resolve));
    },
  });
  await robot.start();
  const first = candle(start, 99);
  const crossing = candle(start + hour, 101);
  emit({ stream: 'live', history: history([first]) }, start);
  emit({ stream: 'live', history: history([first, crossing]), freshCandleTime: crossing.time });
  await started;
  emit({ stream: 'live', history: history([{ ...first, high: first.high + 1 }]) });
  release({ freeMoney: 1000, pointValue: 1 });
  await setImmediate();
  assert.equal(
    events.some((event) => event.startsWith('reserve-order:')),
    false,
  );
});

test('queued crossing uses corrected cache rather than replaying the older snapshot', async () => {
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => (release = resolve));
  const rechecking = new Promise<void>((resolve) => (entered = resolve));
  const { robot, emit, orders } = setup({
    recheck: async () => {
      entered();
      await blocked;
    },
  });
  await robot.start();
  const first = [candle(start, 99), candle(start + hour, 101)];
  emit({ stream: 'live', history: history([first[0]]) }, start);
  emit({ stream: 'live', history: history(first), freshCandleTime: first[1].time });
  await rechecking;
  const next = candle(start + 2 * hour, 99);
  emit({ stream: 'live', history: history([...first, next]), freshCandleTime: next.time });
  emit({ stream: 'live', history: history([{ ...next, confirmedEma: 98 }]) });
  release();
  await setImmediate();
  assert.equal(orders.length, 0);
});

for (const outcome of ['fresh', 'expired', 'newer snapshot', 'reconnect', 'stop'] as const) {
  test(`new crossing during entry preflight is processed only when still ${outcome}`, async () => {
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const rechecking = new Promise<void>((resolve) => (entered = resolve));
    const { robot, emit, orders, events, records, setNow } = setup({
      recheck: async () => {
        entered();
        await blocked;
      },
    });
    await robot.start();
    emit({ stream: 'live', history: history([candle(start, 99)]) }, start);
    const first = [candle(start, 99), candle(start + hour, 101)];
    emit({ stream: 'live', history: history(first), freshCandleTime: start + hour });
    await rechecking;
    const reservation = events.find((event) => event.startsWith('reserve-order:'))!;
    const second = [...first, candle(start + 2 * hour, 99)];
    emit({ stream: 'live', history: history(second), freshCandleTime: start + 2 * hour });
    if (outcome === 'expired') setNow(start + 4 * hour);
    if (outcome === 'newer snapshot')
      emit({ stream: 'live', history: history([...second, candle(start + 3 * hour, 98)]) });
    if (outcome === 'reconnect') {
      emit({ stream: 'disconnected' });
      emit({ stream: 'live', recoveredAt: start + 3 * hour, history: history(second) });
    }
    if (outcome === 'stop') robot.stop();
    release();
    await setImmediate();
    assert.equal(orders.length, outcome === 'fresh' ? 1 : 0);
    if (outcome === 'fresh') {
      assert.equal(orders[0].direction, 'sell');
      assert.equal(orders[0].context.type, 'signal');
      if (orders[0].context.type === 'signal')
        assert.equal(orders[0].context.candleTime, start + 2 * hour);
    }
    assert.deepEqual(records[0], {
      id: reservation.slice('reserve-order:'.length),
      status:
        outcome === 'stop'
          ? 'stopped-before-send'
          : outcome === 'reconnect'
            ? 'feed-lost-before-send'
            : 'stale-signal-before-send',
    });
  });
}

for (const outcome of ['fresh', 'expired', 'newer snapshot'] as const) {
  test(`recovered session drains its queued crossing only when ${outcome}`, async () => {
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const rechecking = new Promise<void>((resolve) => (entered = resolve));
    const { robot, emit, orders, records, setNow } = setup({
      recheck: async () => {
        entered();
        await blocked;
      },
    });
    await robot.start();
    emit({ stream: 'live', history: history([candle(start, 99)]) }, start);
    const first = [candle(start, 99), candle(start + hour, 101)];
    emit({ stream: 'live', history: history(first), freshCandleTime: start + hour });
    await rechecking;
    // An old-session candidate must not be replayed after recovery.
    const old = [...first, candle(start + 2 * hour, 99)];
    emit({ stream: 'live', history: history(old), freshCandleTime: start + 2 * hour });
    emit({ stream: 'disconnected' });
    emit({ stream: 'live', recoveredAt: start + 3 * hour, history: history(old) });
    const recovered = [...old, candle(start + 3 * hour, 101)];
    emit({ stream: 'live', history: history(recovered), freshCandleTime: start + 3 * hour });
    if (outcome === 'expired') setNow(start + 5 * hour);
    if (outcome === 'newer snapshot')
      emit({ stream: 'live', history: history([...recovered, candle(start + 4 * hour, 102)]) });
    release();
    await setImmediate();
    assert.equal(records[0].status, 'feed-lost-before-send');
    assert.equal(orders.length, 0);
    assert.equal(robot.status().mode, 'reconnecting');
  });
}

test('failed stop lookup is not absence and blocks conflicting close', async () => {
  const { robot, emit } = setup({ lookupFails: true });
  await robot.start();
  emit({ stream: 'live', history: history([candle(start, 99)]) });
  emit({
    stream: 'live',
    history: history([candle(start, 99), candle(start + 1 * hour, 101)]),
    freshCandleTime: start + 1 * hour,
  });
  await setImmediate();
  robot.stop();
  await assert.rejects(robot.reconcileProtection(), { code: 'ROBOT_PROTECTION_UNRESOLVED' });
  assert.equal(robot.status().protection?.state, 'unconfirmed');
  assert.ok(robot.status().protection?.pendingAttempt);
  await assert.rejects(robot.closePosition(config), { code: 'ROBOT_PROTECTION_UNRESOLVED' });
});

for (const observation of [
  { status: 'active' },
  { status: 'triggered', childId: 'child-1', childStatus: 'active' },
  { status: 'triggered', childId: 'child-1', childStatus: 'terminal' },
  { status: 'triggered', childId: 'child-1', childStatus: 'unknown' },
  { status: 'cancelled' },
  { status: 'absent' },
  { status: 'unknown' },
] as const satisfies readonly ProtectionObservation[]) {
  test(`stop observation ${JSON.stringify(observation)} remains distinct and blocks unverified exit`, async () => {
    const { robot, emit, orders } = setup({ lookup: () => observation });
    await robot.start();
    emit({ stream: 'live', history: history([candle(start, 99)]) });
    emit({
      stream: 'live',
      history: history([candle(start, 99), candle(start + hour, 101)]),
      freshCandleTime: start + hour,
    });
    await setImmediate();
    robot.stop();
    await robot.reconcileProtection();
    assert.deepEqual(robot.status().protection?.observation, observation);
    await assert.rejects(robot.closePosition(config), { code: 'ROBOT_PROTECTION_UNRESOLVED' });
    assert.equal(orders.length, 1);
  });
}

test('less informative stop lookup cannot erase known child identity', async () => {
  let observation: ProtectionObservation = {
    status: 'triggered',
    childId: 'child-1',
    childStatus: 'active',
  };
  const { robot, emit, orders } = setup({ lookup: () => observation });
  await robot.start();
  emit({ stream: 'live', history: history([candle(start, 99)]) });
  emit({
    stream: 'live',
    history: history([candle(start, 99), candle(start + hour, 101)]),
    freshCandleTime: start + hour,
  });
  await setImmediate();
  robot.stop();
  await robot.reconcileProtection();
  observation = { status: 'absent' };
  await robot.reconcileProtection();
  assert.deepEqual(robot.status().protection?.observation, {
    status: 'triggered',
    childId: 'child-1',
    childStatus: 'active',
  });
  await assert.rejects(robot.closePosition(config), { code: 'ROBOT_PROTECTION_UNRESOLVED' });
  assert.equal(orders.length, 1);
});

test('a failed lookup after a terminal child observation blocks a competing exit', async () => {
  let observation: ProtectionObservation = {
    status: 'triggered',
    childId: 'child-1',
    childStatus: 'terminal',
  };
  const { robot, emit, orders } = setup({ lookup: () => observation });
  await robot.start();
  emit({ stream: 'live', history: history([candle(start, 99)]) });
  emit({
    stream: 'live',
    history: history([candle(start, 99), candle(start + hour, 101)]),
    freshCandleTime: start + hour,
  });
  await setImmediate();
  robot.stop();
  await robot.reconcileProtection();
  assert.deepEqual(robot.status().protection?.observation, {
    status: 'triggered',
    childId: 'child-1',
    childStatus: 'terminal',
  });
  observation = { status: 'unknown' };
  await robot.reconcileProtection();
  assert.deepEqual(robot.status().protection?.observation, {
    status: 'triggered',
    childId: 'child-1',
    childStatus: 'terminal',
  });
  await assert.rejects(robot.closePosition(config), { code: 'ROBOT_PROTECTION_UNRESOLVED' });
  assert.equal(orders.length, 1);
});

for (const response of ['confirmed', 'not-sent', 'rejected', 'throw'] as const) {
  test(`protection ${response} remains visible and blocks competing orders`, async () => {
    const { robot, emit, orders } = setup({ submitProtection: response });
    await robot.start();
    emit({ stream: 'live', history: history([candle(start, 99)]) });
    emit({
      stream: 'live',
      history: history([candle(start, 99), candle(start + 1 * hour, 101)]),
      freshCandleTime: start + 1 * hour,
    });
    await setImmediate();
    assert.equal(robot.status().protection?.state, response === 'throw' ? 'unconfirmed' : response);
    robot.stop();
    await assert.rejects(robot.closePosition(config), { code: 'ROBOT_PROTECTION_UNRESOLVED' });
    assert.equal(orders.length, 1);
  });
}

test('ambiguous improved entry is looked up by original ID and is not retried', async () => {
  const { robot, emit, orders, events } = setup({ ambiguousOrder: true });
  await robot.start();
  emit({ stream: 'live', history: history([candle(start, 99)]) });
  const snapshot = history([candle(start, 99), candle(start + 1 * hour, 101)]);
  emit({ stream: 'live', history: snapshot, freshCandleTime: start + 1 * hour });
  await setImmediate();
  assert.equal(orders.length, 1);
  assert.equal(events[0], 'reserve-order:' + orders[0].id);
  assert.match(events[1], /^reserve-stop:.+/);
  assert.deepEqual(events.slice(2, 4), [
    'send-order:' + orders[0].id,
    'lookup-order:' + orders[0].id,
  ]);
  assert.equal(robot.status().reason, 'ROBOT_ORDER_SUBMISSION_UNCERTAIN');
  emit({ stream: 'live', history: snapshot, freshCandleTime: start + 1 * hour });
  await robot.reconcile();
  assert.equal(events.at(-1), 'lookup-order:' + orders[0].id);
  await assert.rejects(robot.resume(), { code: 'ROBOT_PROTECTION_UNRESOLVED' });
  assert.equal(orders.length, 1);
});

test('missing EMA, invalid sizing and reconnect snapshots never create entries', async () => {
  const { robot, emit, orders } = setup({ freeMoney: 0 });
  await robot.start();
  emit({ stream: 'live', history: history([candle(start, 99)]) });
  emit({
    stream: 'live',
    history: history([candle(start, 99), candle(start + 1 * hour, 101, null)]),
    freshCandleTime: start + 1 * hour,
  });
  emit({ stream: 'disconnected' });
  emit({
    stream: 'live',
    recoveredAt: start + 2 * hour,
    history: history([candle(start + 2 * hour, 99), candle(start + 3 * hour, 101)]),
    freshCandleTime: start + 3 * hour,
  });
  emit({
    stream: 'live',
    history: history([candle(start + 2 * hour, 99), candle(start + 3 * hour, 101)]),
    freshCandleTime: start + 3 * hour,
  });
  await setImmediate();
  assert.equal(orders.length, 0);
});
