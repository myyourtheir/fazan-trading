export type Side = -1 | 1;

export function crossing(previous: Side | null, close: number, ema: number) {
  const side = close === ema ? previous : close > ema ? 1 : -1;
  return { side, direction: previous !== null && side !== previous ? side : null };
}

export function findLiveCrossing(candles: MarketHistory['candles'], { since, now, lastAttempted }: {
  since: number; now: number; lastAttempted: number;
}) {
  let side: Side | null = null;
  let historicalEmaPending = false;
  // Rebuild from ordered snapshots: late confirmation can change the strict side before an equality.
  for (const candle of candles) {
    const signalTime = candle.time + hourMs;
    if (signalTime > now) continue;
    if (!candle.complete || candle.confirmedEma === null) {
      if (signalTime > since) break;
      historicalEmaPending = true;
      continue;
    }
    if (signalTime > since && historicalEmaPending) break;
    const next = crossing(side, candle.close, candle.confirmedEma);
    side = next.side;
    if (candle.close !== candle.confirmedEma) historicalEmaPending = false;
    if (next.direction && signalTime > since && candle.time > lastAttempted) {
      return { candleTime: candle.time, signalTime, signalPrice: candle.close, ema: candle.confirmedEma, direction: next.direction };
    }
  }
}

export function positionDelta(position: number, target: number) {
  const delta = target - position;
  if (delta === 0) return null;
  return { direction: delta > 0 ? 'buy' as const : 'sell' as const, lots: Math.abs(delta) };
}
import { hourMs, type MarketHistory } from './market-data.js';
