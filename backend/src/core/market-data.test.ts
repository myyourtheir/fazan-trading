import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import {
  MarketData,
  type MarketCandle,
  type MarketBroker,
  type MarketUpdate,
} from './market-data.js';
import { timeframeMs } from './timeframe.js';
import { Robot, type Broker, type TradingStore } from './robot.js';
import { surfingStrategy, type SurfingLiveConfig } from './surfing-strategy.js';
import { surfingFeed } from './surfing-feed.js';

const interval = timeframeMs['15m'];
const openTime = Date.UTC(2026, 10, 18, 12);
const previous = openTime - interval;
const config = {
  instrumentUid: 'future-uid',
  emaPeriod: 3,
  token: 'fake-token',
  timeframe: '15m',
} as const;
const candle = (time: number, close: number, complete: boolean): MarketCandle => ({
  time,
  open: 100,
  high: Math.max(100, close),
  low: 100,
  close,
  complete,
});

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 100 && !check(); attempt++) await delay(5);
  assert.ok(check(), 'Expected a market update');
}

test('overlapping EMA requests use their completion snapshot and never replace newer confirmations', async (t) => {
  const responses: ((value: { time: number; value: number }[]) => void)[] = [];
  let complete = false;
  const updates: MarketUpdate[] = [];
  const market = new MarketData(
    {
      async candles() {
        return [candle(previous, 100, true), candle(openTime, 110, complete)];
      },
      async ema() {
        return new Promise((resolve) => responses.push(resolve));
      },
      async *stream(_token, _uid, _timeframe, signal) {
        yield { kind: 'subscribed' };
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
      },
    },
    async () => config,
    { now: () => openTime + interval + 1, refreshMs: 5 },
  );
  t.after(await market.subscribe((update) => updates.push(update)));
  await until(() => responses.length >= 1);
  complete = true;
  await until(() => responses.length >= 2);
  responses[0]([{ time: openTime, value: 999 }]);
  await delay(10);
  assert.equal(
    updates.at(-1)?.history?.candles.find((c) => c.time === openTime)?.confirmedEma,
    null,
  );
  responses[1]([
    { time: previous, value: 20 },
    { time: openTime, value: 30 },
  ]);
  await until(
    () => updates.at(-1)?.history?.candles.find((c) => c.time === openTime)?.confirmedEma === 30,
  );
  await until(() => responses.length >= 4);
  responses[3]([{ time: previous, value: 40 }]);
  await until(
    () => updates.at(-1)?.history?.candles.find((c) => c.time === previous)?.confirmedEma === 40,
  );
  responses[2]([{ time: previous, value: 10 }]);
  await delay(10);
  assert.equal(updates.at(-1)?.history?.candles.find((c) => c.time === previous)?.confirmedEma, 40);
});

test('history confirms EMA only on a complete candle with exactly the same opening timestamp', async () => {
  const broker: MarketBroker = {
    async candles(_token, _uid, timeframe) {
      assert.equal(timeframe, '15m');
      return [
        candle(openTime, 110, false),
        candle(previous, 100, true),
        candle(previous - interval, 105, true),
      ];
    },
    async ema(_token, instrumentUid, timeframe, period) {
      assert.equal(instrumentUid, config.instrumentUid);
      assert.equal(timeframe, '15m');
      assert.equal(period, 3);
      return [
        { time: previous, value: 102 },
        { time: previous - interval + 1, value: 94 },
        { time: openTime, value: 999 },
      ];
    },
    async *stream() {},
  };
  const market = new MarketData(broker, async () => config, { now: () => openTime + 1 });
  const history = await market.history();
  assert.equal(history?.timeframe, '15m');
  assert.deepEqual(
    history?.candles.map(({ time, confirmedEma, previewEma }) => [time, confirmedEma, previewEma]),
    [
      [previous - interval, null, null],
      [previous, 102, null],
      [openTime, null, 106],
    ],
  );
  const expired = new MarketData(broker, async () => config, { now: () => openTime + interval });
  assert.equal((await expired.history())?.candles.at(-1)?.previewEma, null);
});

test('live repeats replace the current candle; only broker history can finalize it and confirm delayed EMA', async (t) => {
  let now = openTime + 1;
  let historyAvailable = false;
  let completed = false;
  let emaArrived = false;
  let push!: (candle: MarketCandle) => void;
  async function* ticks(signal: AbortSignal) {
    yield { kind: 'subscribed' } as const;
    while (!signal.aborted) {
      const tick = await new Promise<MarketCandle | undefined>((resolve) => {
        const abort = () => resolve(undefined);
        signal.addEventListener('abort', abort, { once: true });
        push = (value) => {
          signal.removeEventListener('abort', abort);
          resolve(value);
        };
      });
      if (tick) yield { kind: 'candle', candle: tick } as const;
    }
  }
  const broker: MarketBroker = {
    async candles() {
      if (!historyAvailable) throw new Error('History temporarily unavailable');
      return [candle(previous, 100, true), candle(openTime, completed ? 115 : 110, completed)];
    },
    async ema() {
      return [
        { time: previous, value: 102 },
        ...(emaArrived ? [{ time: openTime, value: 108 }] : []),
      ];
    },
    stream(_token, _uid, timeframe, signal) {
      assert.equal(timeframe, '15m');
      return ticks(signal);
    },
  };
  const market = new MarketData(broker, async () => config, { refreshMs: 10, now: () => now });
  let update: MarketUpdate | undefined;
  let candles: MarketUpdate['history'];
  const off = await market.subscribe((message) => {
    update = message;
    candles = message.history ?? candles;
  });
  t.after(off);
  const current = () => candles?.candles.find((candle) => candle.time === openTime);
  await until(() => update?.stream === 'live' && typeof push === 'function');
  push(candle(openTime, 110, false));
  await until(() => update?.tick?.candle.close === 110);
  assert.equal(update?.tick?.timeframe, '15m');
  assert.equal(update?.tick?.candle.confirmedEma, null);
  historyAvailable = true;
  await until(() => update?.stream === 'live' && current()?.close === 110);
  push(candle(openTime, 120, false));
  await until(() => current()?.previewEma === 111);
  push(candle(openTime, 118, false));
  await until(() => current()?.previewEma === 110);
  assert.equal(candles?.candles.length, 2);
  now += interval;
  completed = true;
  await until(() => current()?.complete === true);
  assert.equal(current()?.previewEma, null);
  assert.equal(current()?.confirmedEma, null);
  push(candle(openTime, 120, false));
  emaArrived = true;
  await until(() => current()?.confirmedEma === 108);
  assert.equal(current()?.close, 115);
  assert.equal(candles?.candles.length, 2);
});

test('subscribers share a broker stream; reconnect backfills candles missed during the break', async (t) => {
  let streams = 0;
  let now = openTime + 1;
  let reachedSecondAttempt = false;
  let reconnectEmaAvailable = false;
  let reconnectCandleComplete = false;
  let matchingEmaAvailable = false;
  let matchingEma = NaN;
  let reconnectEmaReads = 0;
  let disconnect!: () => void;
  const broker: MarketBroker = {
    async candles() {
      return [
        candle(previous, 100, true),
        candle(openTime, 110, reconnectCandleComplete),
        ...(reachedSecondAttempt ? [candle(openTime + interval, 112, false)] : []),
      ];
    },
    async ema() {
      if (reachedSecondAttempt) {
        reconnectEmaReads++;
        if (!reconnectEmaAvailable) throw new Error('EMA temporarily unavailable');
      }
      return [
        { time: previous, value: 102 },
        ...(matchingEmaAvailable ? [{ time: openTime, value: matchingEma }] : []),
      ];
    },
    async *stream(_token, _uid, _timeframe, signal) {
      reachedSecondAttempt = ++streams === 2;
      yield { kind: 'subscribed' };
      await new Promise<void>((resolve) => {
        const done = () => {
          signal.removeEventListener('abort', done);
          resolve();
        };
        signal.addEventListener('abort', done, { once: true });
        disconnect = done;
      });
    },
  };
  const market = new MarketData(broker, async () => config, {
    retryMs: 5,
    refreshMs: 10,
    now: () => now,
  });
  const first: MarketUpdate[] = [];
  const second: MarketUpdate[] = [];
  t.after(await market.subscribe((update) => first.push(update)));
  t.after(await market.subscribe((update) => second.push(update)));
  let submissions = 0;
  const tradingBroker: Broker = {
    async verifySelection() {},
    async accountState() {
      return { position: 0, activeOrders: false };
    },
    async submit() {
      submissions++;
      throw new Error('Unexpected stale order');
    },
    async orderState() {
      throw new Error('Unexpected lookup');
    },
  };
  const store: TradingStore = {
    async reserve() {
      throw new Error('Unexpected stale reservation');
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
  };
  const robot = new Robot<SurfingLiveConfig>(
    tradingBroker,
    store,
    surfingFeed(market),
    async () => ({
      ...config,
      accountId: 'account',
      ticker: 'FUT',
      lots: 3,
    }),
    () => now,
    (history, options, config) => surfingStrategy.live(history, options, config),
  );
  t.after(() => robot.shutdown());
  await robot.start();
  await until(() => second.some((update) => update.history?.candles.at(-1)?.previewEma === 106));
  assert.equal(streams, 1);
  now += interval;
  disconnect();
  await until(() => second.some((update) => update.history?.candles.length === 3));
  const afterDisconnect = second.slice(
    second.findIndex((update) => update.stream === 'disconnected') + 1,
  );
  assert.ok(
    afterDisconnect.every((update) => update.stream !== 'live'),
    'Reconnection stays blocked until EMA backfill succeeds',
  );
  reconnectEmaAvailable = true;
  const reads = reconnectEmaReads;
  await until(() => reconnectEmaReads > reads);
  assert.equal(
    second.at(-1)?.stream,
    'connecting',
    'A successful but incomplete backfill is still not tradeable',
  );
  reconnectCandleComplete = true;
  await until(() => second.at(-1)?.stream === 'live');
  assert.equal(second.at(-1)?.recoveredAt, now);
  assert.equal(submissions, 0);
  assert.equal(robot.status().mode, 'running');
  matchingEmaAvailable = true;
  matchingEma = 106;
  await until(
    () =>
      second
        .at(-1)
        ?.history?.candles.some((bar) => bar.time === openTime && bar.confirmedEma === 106) ===
      true,
  );
  assert.equal(submissions, 0, 'late EMA must not trade a backfilled crossing');
  const duringBreak = first
    .find((update) => update.stream === 'disconnected')
    ?.history?.candles.at(-1);
  assert.equal(duringBreak?.time, openTime);
  assert.equal(duringBreak?.previewEma, null);
  assert.equal(
    second.at(-1)?.history?.candles.find((candle) => candle.time === openTime)?.confirmedEma,
    106,
  );
  assert.equal(streams, 2);
});

test('different timeframes use separate broker feeds even for the same instrument and EMA period', async (t) => {
  const market = new MarketData(
    {
      async candles() {
        return [];
      },
      async ema() {
        return [];
      },
      async *stream(_token, _uid, timeframe, signal) {
        yield { kind: 'candle', candle: candle(openTime, timeframe === '5m' ? 105 : 115, false) };
        await delay(10_000, undefined, { signal });
      },
    },
    async () => config,
    { now: () => openTime },
  );
  const first: MarketUpdate[] = [];
  const second: MarketUpdate[] = [];
  t.after(await market.subscribe((update) => first.push(update)));
  t.after(await market.subscribe((update) => second.push(update), { ...config, timeframe: '5m' }));
  await until(() => first.some((update) => update.tick) && second.some((update) => update.tick));
  assert.deepEqual(
    first.flatMap(({ tick }) => (tick ? [[tick.timeframe, tick.candle.close]] : [])),
    [['15m', 115]],
  );
  assert.deepEqual(
    second.flatMap(({ tick }) => (tick ? [[tick.timeframe, tick.candle.close]] : [])),
    [['5m', 105]],
  );
});

test('recovery publishes the candle cutoff while broker EMA is still pending', async (t) => {
  let now = openTime + 1;
  let attempts = 0;
  let disconnect!: () => void;
  const updates: MarketUpdate[] = [];
  const market = new MarketData(
    {
      async candles() {
        return [candle(now < openTime + interval ? previous : openTime, 110, true)];
      },
      async ema() {
        return new Promise<never>(() => {});
      },
      async *stream(_token, _uid, _timeframe, signal) {
        attempts++;
        yield { kind: 'subscribed' };
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
          disconnect = resolve;
        });
      },
    },
    async () => config,
    { now: () => now, retryMs: 5, refreshMs: 10 },
  );
  t.after(await market.subscribe((update) => updates.push(update)));
  await until(() => updates.some((update) => update.history));
  now += interval;
  disconnect();
  await until(() => updates.some((update) => update.recoveredAt === now));
  assert.equal(attempts, 2);
  const recovered = updates.find((update) => update.recoveredAt === now);
  assert.equal(recovered?.stream, 'live');
  assert.equal(recovered?.history?.candles.at(-1)?.confirmedEma, null);
});
