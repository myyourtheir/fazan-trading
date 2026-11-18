import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BacktestHistory, backtestLimits } from '../core/backtest-history.js';
import { timeframeMs } from '../core/timeframe.js';
import { InvestSandbox } from './invest-sandbox.js';

const {
  SERFING_TEST_SANDBOX_TOKEN: token,
  SERFING_TEST_FUTURE_UID: instrumentUid,
  SERFING_TEST_BACKTEST_TO: lastDate,
} = process.env;

test('sandbox supports the requested historical coverage and exposes futures pricing metadata', {
  skip: !token || !instrumentUid || !lastDate,
  timeout: 180_000,
}, async t => {
  assert.ok(token && instrumentUid && lastDate);
  const day = Date.parse(`${lastDate}T00:00:00Z`);
  assert.ok(Number.isFinite(day), 'Set SERFING_TEST_BACKTEST_TO to the last inclusive Moscow date (YYYY-MM-DD)');
  const from = new Date(day - (backtestLimits.maxDays - 1) * 86_400_000).toISOString().slice(0, 10);
  const broker = new InvestSandbox();
  const contract = await broker.backtestFuture(token, instrumentUid);
  assert.ok(contract.currency && Number.isSafeInteger(contract.lot) && contract.lot > 0);
  assert.ok(contract.priceStep && contract.priceStep > 0);
  assert.ok(contract.priceStepAmount && contract.priceStepAmount > 0);
  const timeframes = Object.keys(timeframeMs) as (keyof typeof timeframeMs)[];
  for (const timeframe of timeframes) {
    for (const emaPeriod of [5, 55, backtestLimits.maxEmaPeriod]) {
      await t.test(`${timeframe} / EMA ${emaPeriod} / ${from}–${lastDate}`, async sample => {
        const samples = new Map<number, number>();
        const history = new BacktestHistory({
          candles: broker.candles.bind(broker),
          backtestFuture: broker.backtestFuture.bind(broker),
          async ema(...args) {
            const points = await broker.ema(...args);
            for (const time of new Set(points.map(point => point.time))) {
              samples.set(time, (samples.get(time) ?? 0) + 1);
            }
            return points;
          },
        }, async () => token);
        const result = await history.check({ instrumentUid, timeframe, emaPeriod, lots: 1, from, to: lastDate });
        assert.equal(result.cutoff, null, 'Use a final date that has already ended in Moscow');
        const observedSeam = result.candles.some(bar => (samples.get(bar.time) ?? 0) > 1);
        assert.ok(observedSeam, 'Choose a range whose historical request seam falls during an active session');
        sample.diagnostic(`Matched ${result.candles.length} completed candles`);
      });
    }
  }
});
