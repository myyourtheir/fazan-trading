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
  const seamOverlaps = new Map<string, number>();
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
        const result = await history.check({ instrumentUid, timeframe, emaPeriod, lots: 1, from, to: lastDate, commission: 0, slippage: 0 });
        assert.equal(result.cutoff, null, 'Use a final date that has already ended in Moscow');
        // A seam value read in more than one chunk proves the overlap was real and that its values
        // agreed (check merges them with a tolerance). A seam on a session close or a weekend has no
        // overlapping candle, which is a pause, not missing data.
        const overlaps = result.candles.filter(bar => (samples.get(bar.time) ?? 0) > 1).length;
        seamOverlaps.set(timeframe, (seamOverlaps.get(timeframe) ?? 0) + overlaps);
        sample.diagnostic(`Matched ${result.candles.length} completed candles; ${overlaps} seam overlaps`);
      });
    }
  }
  // The 5-minute seam always lands on the session close (23:50 MSK), so it can never overlap; every
  // other timeframe must exercise the seam-consistency merge on a trading day.
  for (const timeframe of timeframes) {
    if (timeframe === '5m') continue;
    assert.ok((seamOverlaps.get(timeframe) ?? 0) > 0, `No seam overlap for ${timeframe}. Choose `
      + 'SERFING_TEST_BACKTEST_TO so the in-period seam (two days before it, in the evening) falls on a trading day.');
  }
});
