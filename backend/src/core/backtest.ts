import type { MarketCandle, MarketSelection } from './market-data.js';
import { crossing, positionDelta, type Side } from './crossing.js';

export type BacktestParameters = MarketSelection & {
  lots: number; from: string; to: string;
  // Costs in percent, each non-negative and zero by default.
  commission: number; slippage: number;
};

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
  initialSide: Side | null;
  cutoff: number | null;
};

export type BacktestExecution = {
  time: number;
  direction: 'buy' | 'sell';
  lots: number;
  price: number; // next-candle open worsened by slippage
  commission: number; // fee charged on the full executed volume
};

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
  result: { closed: number; open: number; total: number; position: number; maxDrawdown: number };
  cutoff: number | null;
};

// The dataset's contract is already resolved: a missing or non-positive price step would otherwise
// yield an infinite or zero conversion coefficient and a meaningless money result.
export function runBacktest({ parameters, candles, contract, initialSide, cutoff }: BacktestDataset): BacktestReport {
  const { priceStep, priceStepAmount, lot, currency } = contract;
  // Money per quote point per lot: the money value of one price step over the step size, times the lot.
  const pointValue = (priceStepAmount / priceStep) * lot;
  const slippageRate = parameters.slippage / 100;
  const commissionRate = parameters.commission / 100;

  let side = initialSide;
  let position = 0;
  let entryPrice = 0;
  let entryCommission = 0;
  let closed = 0;
  let peak = 0;
  let maxDrawdown = 0;
  const executions: BacktestExecution[] = [];
  let finalSignal: BacktestSignal | null = null;

  // Slippage always works against the owner: a buy fills above the open, a sell below it.
  const executionPrice = (open: number, direction: 'buy' | 'sell') =>
    direction === 'buy' ? open * (1 + slippageRate) : open * (1 - slippageRate);

  const markToMarket = (close: number) =>
    position !== 0 ? (close - entryPrice) * position * pointValue - entryCommission : 0;

  // A reversal closes the old side and opens the new side at the same execution price. Its fee is
  // charged on the full executed volume and attributed to the closed and opened halves by volume.
  const apply = (candle: BacktestCandle, direction: 'buy' | 'sell', lots: number) => {
    const price = executionPrice(candle.open, direction);
    const commission = price * lots * pointValue * commissionRate;
    const previous = position;
    const next = previous + (direction === 'buy' ? lots : -lots);
    if (previous !== 0) {
      const closingCommission = commission * (Math.abs(previous) / lots);
      closed += (price - entryPrice) * previous * pointValue - closingCommission - entryCommission;
    }
    if (next !== 0) {
      entryCommission = commission * (Math.abs(next) / lots);
      entryPrice = price;
    } else {
      entryCommission = 0;
      entryPrice = 0;
    }
    position = next;
    executions.push({ time: candle.time, direction, lots, price, commission });
  };

  let pending: { direction: 'buy' | 'sell'; lots: number } | null = null;
  for (let index = 0; index < candles.length; index++) {
    const candle = candles[index];

    // The previous candle's signal executes at this candle's open, including after a session pause.
    if (pending) {
      apply(candle, pending.direction, pending.lots);
      pending = null;
    }

    const next = crossing(side, candle.close, candle.ema);
    side = next.side;
    if (next.direction !== null) {
      const targetPosition = next.direction * parameters.lots;
      const delta = positionDelta(position, targetPosition);
      if (delta) {
        if (index + 1 < candles.length) pending = delta;
        else finalSignal = { candleTime: candle.time, direction: delta.direction, targetPosition };
      }
    }

    // Drawdown is the deepest fall of the total result from its running peak, observed at candle closes.
    const equity = closed + markToMarket(candle.close);
    if (equity > peak) peak = equity;
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }

  const lastClose = candles.at(-1)?.close ?? 0;
  const open = markToMarket(lastClose);
  return {
    parameters, currency, pointValue, priceStep, priceStepAmount, lot,
    candles, executions, finalSignal,
    result: { closed, open, total: closed + open, position, maxDrawdown },
    cutoff,
  };
}
