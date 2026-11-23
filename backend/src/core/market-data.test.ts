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
        ...(matchingEmaAvailable ? [{ time: openTime, value: 106 }] : []),
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
  await until(
    () =>
      second
        .at(-1)
        ?.history?.candles.some((candle) => candle.time === openTime && candle.complete) === true,
  );
  assert.equal(
    second.at(-1)?.stream,
    'connecting',
    'A completed candle without its matching EMA cannot restore the baseline',
  );
  matchingEmaAvailable = true;
  await until(() => second.at(-1)?.stream === 'live');
  assert.equal(second.at(-1)?.recoveredAt, now);
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
