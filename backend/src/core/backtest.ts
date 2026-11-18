import type { MarketCandle, MarketSelection } from './market-data.js';
import { crossing, positionDelta, type Side } from './crossing.js';

export type BacktestParameters = MarketSelection & { lots: number; from: string; to: string };

export type BacktestContract = {
  currency: string;
  priceStep: number | null;
  priceStepAmount: number | null;
  lot: number;
};

// The contract resolved for a money report: every field the conversion coefficient depends on is non-null.
export type ResolvedBacktestContract = { currency: string; priceStep: number; priceStepAmount: number; lot: number };

export type BacktestCandle = MarketCandle & { ema: number };

export type BacktestDataset = {
  parameters: BacktestParameters;
  candles: BacktestCandle[];
  contract: ResolvedBacktestContract;
  initialSide: Side;
  cutoff: number | null;
};

export type BacktestExecution = { time: number; direction: 'buy' | 'sell'; lots: number; price: number };

export type BacktestSignal = { candleTime: number; direction: 'buy' | 'sell'; targetPosition: number };

export type BacktestReport = {
  parameters: BacktestParameters;
  currency: string;
  pointValue: number;
  priceStep: number;
  priceStepAmount: number;
  lot: number;
  candles: BacktestCandle[];
  executions: BacktestExecution[];
  finalSignal: BacktestSignal | null;
  result: { closed: number; open: number; total: number; position: number };
  cutoff: number | null;
};

// The dataset's contract is already resolved: a missing or non-positive price step would otherwise
// yield an infinite or zero conversion coefficient and a meaningless money result.
export function runBacktest({ parameters, candles, contract, initialSide, cutoff }: BacktestDataset): BacktestReport {
  const { priceStep, priceStepAmount, lot, currency } = contract;
  // Money per quote point per lot: the money value of one price step over the step size, times the lot.
  const pointValue = (priceStepAmount / priceStep) * lot;

  let side: Side = initialSide;
  let position = 0;
  let entryPrice = 0;
  let closed = 0;
  const executions: BacktestExecution[] = [];
  let finalSignal: BacktestSignal | null = null;

  for (let index = 0; index < candles.length; index++) {
    const candle = candles[index];
    const next = crossing(side, candle.close, candle.ema);
    // `side` is a strict side, so crossing keeps it strict: equality preserves the previous non-null side.
    side = next.side as Side;
    if (next.direction === null) continue;
    const targetPosition = next.direction * parameters.lots;
    const delta = positionDelta(position, targetPosition);
    if (!delta) continue;
    const executionCandle = candles[index + 1];
    if (!executionCandle) {
      // A signal on the last candle of the period has no following open to model and does not trade.
      finalSignal = { candleTime: candle.time, direction: delta.direction, targetPosition };
      continue;
    }
    const price = executionCandle.open;
    // A reversal closes the old side and opens the new side at the same execution price.
    if (position !== 0) closed += (price - entryPrice) * position * pointValue;
    executions.push({ time: executionCandle.time, direction: delta.direction, lots: delta.lots, price });
    position = targetPosition;
    entryPrice = price;
  }

  const lastClose = candles.at(-1)?.close ?? 0;
  const open = position !== 0 ? (lastClose - entryPrice) * position * pointValue : 0;
  return {
    parameters, currency, pointValue, priceStep, priceStepAmount, lot,
    candles, executions, finalSignal, result: { closed, open, total: closed + open, position }, cutoff,
  };
}
