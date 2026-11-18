import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { MarketData, type HourlyCandle, type MarketBroker, type MarketUpdate } from '../src/market-data.js';

const hour = 60 * 60_000;
const openTime = Date.UTC(2026, 10, 18, 12);
const previous = openTime - hour;
const config = { instrumentUid: 'future-uid', emaPeriod: 3, token: 'fake-token' };
const candle = (time: number, close: number, complete: boolean): HourlyCandle =>
  ({ time, open: 100, high: Math.max(100, close), low: 100, close, complete });

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 100 && !check(); attempt++) await delay(5);
  assert.ok(check(), 'Expected a market update');
}

test('history confirms EMA only on a complete candle with exactly the same opening timestamp', async () => {
  const broker: MarketBroker = {
    async candles() { return [candle(openTime, 110, false), candle(previous, 100, true), candle(previous - hour, 105, true)]; },
    async ema(_token, instrumentUid, period) {
      assert.equal(instrumentUid, config.instrumentUid);
      assert.equal(period, 3);
      return [{ time: previous, value: 102 }, { time: previous - hour + 1, value: 94 }, { time: openTime, value: 999 }];
    },
    async *stream() {},
  };
  const market = new MarketData(broker, async () => config, { now: () => openTime + 1 });
  const history = await market.history();
  assert.deepEqual(history?.candles.map(({ time, confirmedEma, previewEma }) => [time, confirmedEma, previewEma]), [
    [previous - hour, null, null], [previous, 102, null], [openTime, null, 106],
  ]);
});

test('live repeats replace the current candle; only broker history can finalize it and confirm delayed EMA', async t => {
  let now = openTime + 1;
  let historyAvailable = false;
  let completed = false;
  let emaArrived = false;
  let push!: (candle: HourlyCandle) => void;
  async function* ticks(signal: AbortSignal) {
    yield { kind: 'subscribed' } as const;
    while (!signal.aborted) {
      const tick = await new Promise<HourlyCandle | undefined>(resolve => {
        const abort = () => resolve(undefined);
        signal.addEventListener('abort', abort, { once: true });
        push = value => { signal.removeEventListener('abort', abort); resolve(value); };
      });
      if (tick) yield { kind: 'candle', candle: tick } as const;
    }
  }
  const broker: MarketBroker = {
    async candles() {
      if (!historyAvailable) throw new Error('History temporarily unavailable');
      return [candle(previous, 100, true), candle(openTime, completed ? 115 : 110, completed)];
    },
    async ema() { return [{ time: previous, value: 102 }, ...(emaArrived ? [{ time: openTime, value: 108 }] : [])]; },
    stream(_token, _uid, signal) { return ticks(signal); },
  };
  const market = new MarketData(broker, async () => config, { refreshMs: 10, now: () => now });
  let update: MarketUpdate | undefined;
  let candles: MarketUpdate['history'];
  const off = await market.subscribe(message => { update = message; candles = message.history ?? candles; });
  t.after(off);
  const current = () => candles?.candles.find(candle => candle.time === openTime);
  await until(() => update?.stream === 'live' && typeof push === 'function');
  push(candle(openTime, 110, false));
  await until(() => update?.tick?.candle.close === 110);
  assert.equal(update?.tick?.candle.confirmedEma, null);
  historyAvailable = true;
  await until(() => update?.stream === 'live' && current()?.close === 110);
  push(candle(openTime, 120, false));
  await until(() => current()?.previewEma === 111);
  push(candle(openTime, 118, false));
  await until(() => current()?.previewEma === 110);
  assert.equal(candles?.candles.length, 2);
  now += hour;
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

test('subscribers share a broker stream; reconnect backfills candles missed during the break', async t => {
  let streams = 0;
  let now = openTime + 1;
  let reachedSecondAttempt = false;
  let disconnect!: () => void;
  const broker: MarketBroker = {
    async candles() {
      return [candle(previous, 100, true), candle(openTime, 110, reachedSecondAttempt),
        ...(reachedSecondAttempt ? [candle(openTime + hour, 112, false)] : [])];
    },
    async ema() { return [{ time: previous, value: 102 }, { time: openTime, value: 106 }]; },
    async *stream(_token, _uid, signal) {
      reachedSecondAttempt = ++streams === 2;
      yield { kind: 'subscribed' };
      await new Promise<void>(resolve => {
        const done = () => { signal.removeEventListener('abort', done); resolve(); };
        signal.addEventListener('abort', done, { once: true });
        disconnect = done;
      });
    },
  };
  const market = new MarketData(broker, async () => config, { retryMs: 5, now: () => now });
  const first: MarketUpdate[] = [];
  const second: MarketUpdate[] = [];
  t.after(await market.subscribe(update => first.push(update)));
  t.after(await market.subscribe(update => second.push(update)));
  await until(() => second.some(update => update.history?.candles.at(-1)?.previewEma === 106));
  assert.equal(streams, 1);
  now += hour;
  disconnect();
  await until(() => second.some(update => update.history?.candles.length === 3));
  const duringBreak = first.find(update => update.stream === 'disconnected')?.history?.candles.at(-1);
  assert.equal(duringBreak?.time, openTime);
  assert.equal(duringBreak?.previewEma, null);
  assert.equal(second.at(-1)?.history?.candles.find(candle => candle.time === openTime)?.confirmedEma, 106);
  assert.equal(streams, 2);
});
