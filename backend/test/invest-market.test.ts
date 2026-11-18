import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { NodeApiClient } from '@ttech-pub/grpc-node-client';
import { InvestSandbox } from '../src/infra/invest-sandbox.js';

const { SERFING_TEST_SANDBOX_TOKEN: token, SERFING_TEST_FUTURE_UID: uid } = process.env;

test('the SDK adapter reads EMA from signal and never substitutes middleBand', async t => {
  const from = new Date('2026-11-18T09:00:00Z');
  const to = new Date('2026-11-18T12:00:00Z');
  const second = new Date('2026-11-18T10:00:00Z');
  t.mock.method(NodeApiClient, 'create', async () => ({
    marketdata: {
      async getTechAnalysis() {
        return { technicalIndicators: [
          { timestamp: from, signal: { units: 101, nano: 250_000_000 }, middleBand: { units: 999, nano: 0 } },
          { timestamp: second, signal: { units: 0, nano: 0 } },
          { timestamp: to, middleBand: { units: 999, nano: 0 } },
          { signal: { units: 102, nano: 0 } },
        ] };
      },
    },
  } as unknown as NodeApiClient));
  assert.deepEqual(await new InvestSandbox().ema('fake-token', 'future', 55, from, to), [
    { time: from.getTime(), value: 101.25 },
    { time: second.getTime(), value: 0 },
  ]);
});

test('sandbox history, EMA and a streamed candle share opening timestamps', {
  skip: !token || !uid, timeout: 45_000,
}, async () => {
  assert.ok(token && uid);
  const broker = new InvestSandbox();
  const to = new Date();
  const from = new Date(to.getTime() - 7 * 24 * 60 * 60_000);
  const candles = await broker.candles(token, uid, from, to);
  const ema = await broker.ema(token, uid, 5, from, to);
  const completeTimes = new Set(candles.filter(candle => candle.complete).map(candle => candle.time));
  assert.ok(ema.some(point => completeTimes.has(point.time)), 'No EMA timestamp matched a completed hourly candle');
  const signal = AbortSignal.timeout(20_000);
  let subscribed = false;
  let opening: number | undefined;
  for await (const event of broker.stream(token, uid, signal)) {
    if (event.kind === 'subscribed') subscribed = true;
    else { opening = event.candle.time; break; }
  }
  assert.ok(subscribed, 'Sandbox did not acknowledge the hourly candle subscription');
  assert.ok(opening !== undefined, 'No streamed candle; run during active trading for this contract');
  for (let attempt = 0; attempt < 3; attempt++) {
    const recent = await broker.candles(token, uid, new Date(opening - 3_600_000), new Date());
    if (recent.some(candle => candle.time === opening)) return;
    await delay(1_000);
  }
  assert.fail('The streamed opening timestamp did not match a historical candle');
});
