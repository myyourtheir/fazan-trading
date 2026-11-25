import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BacktestHistory, type BacktestAdapter } from './backtest-history.js';
import type { BacktestBaseParameters } from './backtest.js';
import type { MarketCandle } from './market-data.js';

test('public history runs a strategy without EMA and fills signals even when the next observation is missing', async () => {
  const start = Date.parse('2026-11-18T00:00:00Z');
  const bars: MarketCandle[] = [0, 1, 2, 3].map((i) => ({
    time: start + i * 3_600_000,
    open: 100 + i,
    high: 100 + i,
    low: 100 + i,
    close: 100 + i,
    complete: true,
  }));
  const adapter: BacktestAdapter<BacktestBaseParameters, MarketCandle, number> = {
    warmupCount: () => 0,
    prepare: (_parameters, candles) => ({ candles, initialState: 0 }),
    decide: (state, candle) => {
      if (candle.time === bars[1].time) return undefined;
      return {
        state: state + 1,
        signal: state === 0 ? { targetPosition: 3 } : state === 1 ? { targetPosition: 0 } : null,
      };
    },
  };
  const history = new BacktestHistory(
    {
      async backtestFuture() {
        return {
          firstTrade: undefined,
          lastTrade: undefined,
          currency: 'rub',
          priceStep: 1,
          priceStepAmount: 1,
          lot: 1,
        };
      },
      async backtestCandles() {
        return bars;
      },
    },
    async () => 'token',
    () => start + 86_400_000,
    adapter,
  );
  const report = await history.run({
    instrumentUid: 'future',
    timeframe: '1h',
    from: '2026-11-18',
    to: '2026-11-18',
    timeZone: 'UTC',
    commission: 0,
    slippage: 0,
  });
  assert.deepEqual(
    report.executions.map(({ time, direction, lots, price }) => ({ time, direction, lots, price })),
    [
      { time: bars[1].time, direction: 'buy', lots: 3, price: 101 },
      { time: bars[3].time, direction: 'sell', lots: 3, price: 103 },
    ],
  );
  assert.equal(report.result.position, 0);
  assert.equal(report.result.closed, 6);
});
