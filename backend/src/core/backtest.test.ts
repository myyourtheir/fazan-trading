import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBacktest, type BacktestCandle, type BacktestDataset } from './backtest.js';
import type { Side } from './crossing.js';

const hour = 3_600_000;
const t0 = Date.parse('2026-11-18T09:00:00Z');
const contract = { currency: 'rub', priceStep: 0.5, priceStepAmount: 5, lot: 1 };
const parameters = { instrumentUid: 'future', timeframe: '1h' as const, emaPeriod: 55, lots: 3,
  from: '2026-11-18', to: '2026-11-18' };

const candle = (index: number, open: number, close: number, ema: number): BacktestCandle =>
  ({ time: t0 + index * hour, open, high: Math.max(open, close), low: Math.min(open, close), close, complete: true, ema });

function dataset(candles: BacktestCandle[], initialSide: Side): BacktestDataset {
  return { parameters, candles, contract, initialSide, cutoff: null };
}

test('entries both ways, a full reversal, and the money result follow the crossing rule', () => {
  const report = runBacktest(dataset([
    candle(0, 100, 105, 100), // cross up below EMA
    candle(1, 101, 98, 100),  // cross down
    candle(2, 103, 100, 100), // touch, keeps the strict short side
    candle(3, 104, 95, 100),
    candle(4, 97, 110, 100),  // cross up again
    candle(5, 112, 112, 100),
  ], -1));

  assert.equal(report.pointValue, 10);
  assert.deepEqual(report.executions, [
    { time: t0 + 1 * hour, direction: 'buy', lots: 3, price: 101 },
    { time: t0 + 2 * hour, direction: 'sell', lots: 6, price: 103 },
    { time: t0 + 5 * hour, direction: 'buy', lots: 6, price: 112 },
  ]);
  assert.equal(report.finalSignal, null);
  assert.deepEqual(report.result, { closed: -210, open: 0, total: -210, position: 3 });
});

test('an EMA touch alone gives no signal and does not reset the strict side', () => {
  const report = runBacktest(dataset([
    candle(0, 100, 100, 100), // touch while already above
    candle(1, 104, 99, 100),   // only now a real crossing down
    candle(2, 98, 99, 100),
  ], 1));

  assert.equal(report.executions.length, 1);
  assert.deepEqual(report.executions[0], { time: t0 + 2 * hour, direction: 'sell', lots: 3, price: 98 });
  assert.equal(report.finalSignal, null);
});

test('a complete period without crossings reports zero executions and a flat result', () => {
  const report = runBacktest(dataset([
    candle(0, 90, 92, 100), candle(1, 91, 94, 100), candle(2, 92, 95, 100),
  ], -1));

  assert.deepEqual(report.executions, []);
  assert.equal(report.finalSignal, null);
  assert.deepEqual(report.result, { closed: 0, open: 0, total: 0, position: 0 });
});

test('a signal on the last candle is reported without an execution or a position change', () => {
  const report = runBacktest(dataset([
    candle(0, 90, 92, 100),
    candle(1, 96, 104, 100), // crossing up on the final candle
  ], -1));

  assert.deepEqual(report.executions, []);
  assert.deepEqual(report.finalSignal, { candleTime: t0 + hour, direction: 'buy', targetPosition: 3 });
  assert.deepEqual(report.result, { closed: 0, open: 0, total: 0, position: 0 });
});

test('an open remainder is marked to the last close without an artificial closing fee', () => {
  const report = runBacktest(dataset([
    candle(0, 100, 105, 100), // enter long on the next open
    candle(1, 101, 104, 100),
    candle(2, 102, 108, 100),
  ], -1));

  assert.deepEqual(report.executions, [{ time: t0 + hour, direction: 'buy', lots: 3, price: 101 }]);
  assert.equal(report.result.open, (108 - 101) * 3 * 10);
  assert.equal(report.result.total, report.result.open);
  assert.equal(report.result.position, 3);
});
