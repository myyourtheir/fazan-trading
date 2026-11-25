import { BacktestError } from './backtest-history.js';
import type { BacktestCandle, BacktestExecution, ResolvedBacktestContract } from './backtest.js';
import type { Side } from './crossing.js';
import type { FullBacktestParameters } from './historical-backtest.js';
import {
  actionableCrossing,
  addOnDue,
  entryLots,
  gapAgainstPosition,
  initialIndicators,
  observeCompleted,
  openImprovedPosition,
  ordinaryTradingDay,
  trailStop,
  type ImprovedPosition,
} from './improved-surfing.js';
import type { MarketCandle } from './market-data.js';
import { decideSurfing } from './surfing.js';
import { timeframeMs } from './timeframe.js';

export const moscow = 'Europe/Moscow';
export const minute = 60_000;
export type HistoricalDataset = {
  from: number;
  warmup: BacktestCandle[];
  candles: BacktestCandle[];
  minutes: MarketCandle[];
  sessionByBucket: ReadonlyMap<number, number>;
  missingMinutes: number;
  contract: ResolvedBacktestContract;
};
type Reason = 'entry' | 'add-on' | 'reversal-exit' | 'reversal-entry' | 'gap' | 'stop';

export function simulateHistory(parameters: FullBacktestParameters, data: HistoricalDataset) {
  const { contract, candles, warmup } = data;
  const { priceStep, priceStepAmount, lot } = contract;
  const pointValue = (priceStepAmount / priceStep) * lot;
  const interval = timeframeMs[parameters.timeframe];
  const improved = parameters.kind === 'improved-surfing' ? parameters : null;
  const executions: (BacktestExecution & { reason: Reason })[] = [];
  const equity = [{ time: data.from, value: parameters.initialMoney }];
  let indicators = initialIndicators();
  let surfingSide: Side | null = null;
  let previousEma: number | undefined;
  let model: ImprovedPosition | null = null;
  let position = 0;
  let average = 0;
  let entryFees = 0;
  let closed = 0;
  let fees = 0;
  let peak = parameters.initialMoney;
  let maxDrawdown = 0;
  let blockedBar = -Infinity;

  const openResult = (price: number) => (price - average) * position * pointValue - entryFees;
  const value = (price: number) => parameters.initialMoney + closed + openResult(price);
  const mark = (price: number) => {
    const current = value(price);
    if (!Number.isFinite(current)) throw new BacktestError('BACKTEST_EXECUTION_PRICE_INVALID');
    peak = Math.max(peak, current);
    maxDrawdown = Math.max(maxDrawdown, peak - current);
    return current;
  };
  // The quote in points is treated as RUB per lot, independently of the P&L point value.
  const requiredMargin = (size: number, quotePoints: number) => Math.abs(size) * quotePoints;
  const quote = (base: number, delta: number) => {
    const price = base + Math.sign(delta) * parameters.slippage * priceStep;
    const commission = price * Math.abs(delta) * pointValue * (parameters.commission / 100);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(commission))
      throw new BacktestError('BACKTEST_EXECUTION_PRICE_INVALID');
    return { price, commission };
  };
  // Each fill is either a close of the whole position or an increase in one direction.
  const fill = (time: number, base: number, delta: number, reason: Reason) => {
    const { price, commission } = quote(base, delta);
    if (delta === -position) {
      closed += openResult(price) - commission;
      average = 0;
      entryFees = 0;
    } else {
      average += (price - average) * (delta / (position + delta));
      entryFees += commission;
    }
    position += delta;
    fees += commission;
    executions.push({
      time,
      direction: delta > 0 ? 'buy' : 'sell',
      lots: Math.abs(delta),
      price,
      commission,
      reason,
    });
    mark(base);
  };
  const affordable = (base: number, delta: number) => {
    const { commission, price } = quote(base, delta);
    const immediateLoss = (price - base) * delta * pointValue;
    return value(base) - commission - immediateLoss >= requiredMargin(position + delta, base);
  };
  const observe = (candle: BacktestCandle): Side | null => {
    previousEma = candle.ema;
    if (improved) {
      const observed = observeCompleted(
        indicators,
        { ...candle, confirmedEma: candle.ema },
        improved.atrPeriod,
      );
      indicators = observed.state;
      return observed.crossing;
    }
    if (parameters.kind !== 'surfing') return null;
    const next = decideSurfing({ side: surfingSide }, candle, parameters);
    surfingSide = next.state.side;
    return next.signal ? surfingSide : null;
  };
  for (const candle of warmup) observe(candle);

  let closeIndex = 0;
  let lastBucket = -Infinity;
  for (const bar of data.minutes) {
    const { time, open, high, low } = bar;
    const bucket = Math.floor(time / interval) * interval;
    const session = data.sessionByBucket.get(bucket)!;
    let signalAtOpen:
      | { kind: 'crossing'; candle: BacktestCandle; side: Side; atr: number | null }
      | { kind: 'add-on' }
      | null = null;
    let simultaneousTrail: ImprovedPosition | null = null;
    while (closeIndex < candles.length && candles[closeIndex].time + interval <= time) {
      const candle = candles[closeIndex++];
      const signalTime = candle.time + interval;
      const crossing = observe(candle);
      const atr = indicators.atr;
      if (candle.time <= blockedBar) continue;
      const eligible =
        data.sessionByBucket.get(candle.time) === session &&
        data.sessionByBucket.get(signalTime) === session &&
        (!improved ||
          (ordinaryTradingDay(signalTime, improved.tradeWeekends) &&
            ordinaryTradingDay(time, improved.tradeWeekends)));
      const signal = improved
        ? actionableCrossing(crossing, candle.close, atr, improved) &&
          ordinaryTradingDay(signalTime, improved.tradeWeekends)
          ? crossing
          : null
        : crossing;

      if (signal && Math.sign(position) !== signal) {
        if (eligible) signalAtOpen = { kind: 'crossing', candle, side: signal, atr };
        continue;
      }
      if (improved && model && atr !== null) {
        const trailed = trailStop(model, candle.close, atr, improved);
        if (Number.isFinite(trailed.stop) && trailed.stop > 0) {
          if (signalTime === time) simultaneousTrail = trailed;
          else model = trailed;
        }
        if (eligible && addOnDue(model, candle.close, improved)) signalAtOpen = { kind: 'add-on' };
      }
    }

    mark(open);
    const protect = (reason: 'stop' | 'gap', base: number) => {
      fill(time, base, -position, reason);
      model = null;
      blockedBar = bucket;
    };
    // Protection already in force has priority at the opening print, including after breaks.
    if (model && model.side * (open - model.stop) <= 0) protect('stop', open);
    else if (
      model &&
      bucket !== lastBucket &&
      previousEma !== undefined &&
      gapAgainstPosition(model.side, open, previousEma)
    )
      protect('gap', open);
    if (model && simultaneousTrail) model = simultaneousTrail;
    lastBucket = bucket;

    if (signalAtOpen && blockedBar < bucket) {
      if (signalAtOpen.kind === 'add-on' && model) {
        const delta = model.side * model.entryLots;
        if (Math.abs(position + delta) <= 2_147_483_647 && affordable(open, delta)) {
          fill(time, open, delta, 'add-on');
          model.addOns++;
        }
      } else if (signalAtOpen.kind === 'crossing') {
        const { candle, side, atr } = signalAtOpen;
        const reversal = position !== 0;
        if (reversal) {
          fill(time, open, -position, 'reversal-exit');
          model = null;
        }
        const lots =
          parameters.kind === 'surfing'
            ? parameters.lots
            : entryLots(value(open), candle.close, pointValue);
        if (lots > 0 && lots <= 2_147_483_647 && affordable(open, side * lots)) {
          fill(time, open, side * lots, reversal ? 'reversal-entry' : 'entry');
          if (improved && atr !== null)
            model = openImprovedPosition(side, candle.close, atr, lots, improved);
        }
      }
    }

    if (model) {
      const stop = model.stop;
      if (model.side * (open - stop) <= 0) protect('stop', open);
      else if (model.side === 1 ? low <= stop : high >= stop) protect('stop', stop);
    }
    equity.push({ time: time + minute, value: mark(bar.close) });
  }

  const lastClose = data.minutes.at(-1)!.close;
  const open = openResult(lastClose);
  const total = closed + open;
  const returnPercent = (total / parameters.initialMoney) * 100;
  if (!Number.isFinite(returnPercent) || !Number.isFinite(fees) || !Number.isFinite(maxDrawdown))
    throw new BacktestError('BACKTEST_EXECUTION_PRICE_INVALID');
  return {
    parameters: { ...parameters, timeZone: moscow },
    ...contract,
    pointValue,
    candles,
    executions,
    equity,
    model: { missingMinutes: data.missingMinutes, marginPerLotAtClose: lastClose },
    cutoff: null,
    result: {
      closed,
      open,
      total,
      position,
      maxDrawdown,
      commission: fees,
      returnPercent,
    },
  };
}
