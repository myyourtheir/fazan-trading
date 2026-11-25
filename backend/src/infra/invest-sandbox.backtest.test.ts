import { surfingBacktest } from '../core/surfing-backtest.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BacktestHistory, backtestLimits } from '../core/backtest-history.js';
import { HistoricalBacktest } from '../core/historical-backtest.js';
import { improvedDefaults } from '../core/strategy-settings.js';
import { timeframeMs } from '../core/timeframe.js';
import { InvestSandbox } from './invest-sandbox.js';

const {
  SERFING_TEST_SANDBOX_TOKEN: token,
  SERFING_TEST_FUTURE_UID: instrumentUid,
  SERFING_TEST_BACKTEST_TO: lastDate,
  SERFING_TEST_BACKTEST_FROM: firstDate,
} = process.env;

test(
  'sandbox supplies usable historical coverage for the chosen contract and range',
  {
    skip: !token || !instrumentUid || !firstDate || !lastDate,
    timeout: 180_000,
  },
  async () => {
    assert.ok(token && instrumentUid && firstDate && lastDate);
    const { ticker: _ticker, ...defaults } = improvedDefaults;
    const backtest = new HistoricalBacktest(new InvestSandbox(), async () => token, Date.now);
    const result = await backtest.check({
      ...defaults,
      kind: 'improved-surfing',
      instrumentUid,
      from: firstDate,
      to: lastDate,
      initialMoney: 100_000,
      commission: 0,
      slippage: 0,
    });
    assert.ok(result.candles.length > 0, 'Choose a period with trading sessions');
  },
);

test(
  'sandbox supports the requested historical coverage and exposes futures pricing metadata',
  {
    skip: !token || !instrumentUid || !lastDate,
    timeout: 180_000,
  },
  async (t) => {
    assert.ok(token && instrumentUid && lastDate);
    const day = Date.parse(`${lastDate}T00:00:00Z`);
    assert.ok(
      Number.isFinite(day),
      'Set SERFING_TEST_BACKTEST_TO to the last inclusive Moscow date (YYYY-MM-DD)',
    );
    const from = firstDate ?? new Date(day - 34 * 86_400_000).toISOString().slice(0, 10);
    const broker = new InvestSandbox();
    const contract = await broker.backtestFuture(token, instrumentUid);
    assert.ok(contract.currency && Number.isSafeInteger(contract.lot) && contract.lot > 0);
    assert.ok(contract.priceStep && contract.priceStep > 0);
    assert.ok(contract.priceStepAmount && contract.priceStepAmount > 0);
    const timeframes = Object.keys(timeframeMs) as (keyof typeof timeframeMs)[];
    const history = new BacktestHistory(broker, async () => token, Date.now, surfingBacktest);
    for (const timeframe of timeframes) {
      for (const emaPeriod of [5, 55, backtestLimits.maxEmaPeriod]) {
        await t.test(`${timeframe} / EMA ${emaPeriod} / ${from}–${lastDate}`, async (sample) => {
          const result = await history.check({
            instrumentUid,
            timeframe,
            emaPeriod,
            lots: 1,
            from,
            to: lastDate,
            timeZone: 'Europe/Moscow',
            commission: 0,
            slippage: 0,
          });
          assert.equal(result.cutoff, null, 'Use a final date that has already ended in Moscow');
          assert.ok(
            result.candles.every(
              (bar, index, rows) =>
                bar.complete &&
                (bar.ema === null || Number.isFinite(bar.ema)) &&
                (index === 0 || rows[index - 1].time < bar.time),
            ),
          );
          sample.diagnostic(
            `Loaded ${result.candles.length} completed candles with locally calculated EMA`,
          );
        });
      }
    }
  },
);
