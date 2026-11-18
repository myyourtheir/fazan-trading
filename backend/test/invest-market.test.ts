import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { InvestSandbox } from '../src/invest-sandbox.js';

const { SERFING_TEST_SANDBOX_TOKEN: token, SERFING_TEST_FUTURE_UID: uid } = process.env;

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
