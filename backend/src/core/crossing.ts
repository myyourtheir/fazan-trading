import type { MarketHistory } from './market-data.js';
import { timeframeMs } from './timeframe.js';
import { decideSurfing } from './surfing.js';

export type Side = -1 | 1;

export function crossing(previous: Side | null, close: number, ema: number) {
  const result = decideSurfing({ side: previous }, { close, ema }, { lots: 1 });
  return { side: result.state.side, direction: result.signal ? result.state.side : null };
}

export function findLiveCrossing(
  { candles, timeframe }: MarketHistory,
  {
    since,
    now,
    lastAttempted,
    lots,
    decide = decideSurfing,
  }: {
    since: number;
    now: number;
    lastAttempted: number;
    lots: number;
    decide?: typeof decideSurfing;
  },
) {
  let side: Side | null = null;
  let historicalEmaPending = false;
  // Rebuild from ordered snapshots: late confirmation can change the strict side before an equality.
  for (const candle of candles) {
    const signalTime = candle.time + timeframeMs[timeframe];
    if (signalTime > now) continue;
    if (
      !candle.complete ||
      candle.confirmedEma === null ||
      !Number.isFinite(candle.confirmedEma) ||
      !Number.isFinite(candle.close)
    ) {
      if (signalTime > since) break;
      historicalEmaPending = true;
      continue;
    }
    if (signalTime > since && historicalEmaPending) break;
    const next = decide({ side }, { close: candle.close, ema: candle.confirmedEma }, { lots });
    side = next.state.side;
    if (candle.close !== candle.confirmedEma) historicalEmaPending = false;
    if (next.signal && signalTime > since && candle.time > lastAttempted) {
      return {
        candleTime: candle.time,
        signalTime,
        strategy: { kind: 'surfing', signalPrice: candle.close, ema: candle.confirmedEma },
        targetPosition: next.signal.targetPosition,
      };
    }
  }
}

export { positionDelta } from './position.js';
