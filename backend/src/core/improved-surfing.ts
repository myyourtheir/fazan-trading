import type { Side } from './crossing.js';
import type { ImprovedParameters } from './strategy-settings.js';

export type CompletedCandle = {
  time: number;
  high: number;
  low: number;
  close: number;
  confirmedEma: number | null;
};

export type IndicatorState = {
  previousClose: number | null;
  rangeCount: number;
  rangeSum: number;
  atr: number | null;
  side: Side | null;
};

export const initialIndicators = (): IndicatorState => ({
  previousClose: null,
  rangeCount: 0,
  rangeSum: 0,
  atr: null,
  side: null,
});

// The first candle supplies the previous close; ATR needs `period` subsequent true ranges.
export function observeCompleted(state: IndicatorState, candle: CompletedCandle, period: number) {
  if (
    !Number.isInteger(period) ||
    period < 1 ||
    !Number.isFinite(candle.high) ||
    !Number.isFinite(candle.low) ||
    !Number.isFinite(candle.close) ||
    candle.high < candle.low ||
    candle.close > candle.high ||
    candle.close < candle.low
  )
    throw new Error('Invalid completed candle or ATR period');

  const range =
    state.previousClose === null
      ? null
      : Math.max(
          candle.high - candle.low,
          Math.abs(candle.high - state.previousClose),
          Math.abs(candle.low - state.previousClose),
        );
  const warming = range !== null && state.atr === null;
  const rangeCount = state.rangeCount + (warming ? 1 : 0);
  const rangeSum = state.rangeSum + (warming ? range : 0);
  const atr =
    range === null
      ? state.atr
      : state.atr !== null
        ? (state.atr * (period - 1) + range) / period
        : rangeCount === period
          ? rangeSum / period
          : null;
  const ema = candle.confirmedEma;
  const side =
    ema === null || !Number.isFinite(ema)
      ? null
      : candle.close === ema
        ? state.side
        : candle.close > ema
          ? 1
          : -1;
  const crossing = side !== null && state.side !== null && side !== state.side ? side : null;
  return {
    state: { previousClose: candle.close, rangeCount, rangeSum, atr, side },
    crossing,
  };
}

export type ImprovedPosition = {
  side: Side;
  entryClose: number;
  entryAtr: number;
  entryLots: number;
  addOns: number;
  favorableClose: number;
  stop: number;
};

export function entryLots(freeMoney: number, close: number, pointValue: number) {
  if (
    !Number.isFinite(freeMoney) ||
    !Number.isFinite(close) ||
    !Number.isFinite(pointValue) ||
    freeMoney <= 0 ||
    close <= 0 ||
    pointValue <= 0
  )
    return 0;
  const lots = Math.floor((0.9 * freeMoney) / (close * pointValue));
  return Number.isSafeInteger(lots) ? lots : 0;
}

export function openImprovedPosition(
  side: Side,
  close: number,
  atr: number,
  lots: number,
  parameters: ImprovedParameters,
): ImprovedPosition {
  return {
    side,
    entryClose: close,
    entryAtr: atr,
    entryLots: lots,
    addOns: 0,
    favorableClose: close,
    stop: close - side * parameters.stopAtrMultiplier * atr,
  };
}

// This is a proposal, not a filled add: callers only increment after confirmation.
export function addOnDue(
  position: ImprovedPosition,
  close: number,
  parameters: ImprovedParameters,
) {
  const threshold =
    position.entryClose +
    position.side * (position.addOns + 1) * parameters.addStepAtr * position.entryAtr;
  return (
    position.addOns < parameters.maxAddOns &&
    Number.isFinite(close) &&
    position.side * (close - threshold) >= 0
  );
}

export function trailStop(
  position: ImprovedPosition,
  close: number,
  atr: number,
  parameters: ImprovedParameters,
): ImprovedPosition {
  if (
    !Number.isFinite(close) ||
    !Number.isFinite(atr) ||
    atr < 0 ||
    position.side * (close - position.favorableClose) <= 0
  )
    return position;
  const candidate = close - position.side * parameters.stopAtrMultiplier * atr;
  return {
    ...position,
    favorableClose: close,
    stop:
      position.side === 1 ? Math.max(position.stop, candidate) : Math.min(position.stop, candidate),
  };
}

export function gapAgainstPosition(side: Side, open: number, previousConfirmedEma: number) {
  return (
    Number.isFinite(open) &&
    Number.isFinite(previousConfirmedEma) &&
    side * (open - previousConfirmedEma) < 0
  );
}
