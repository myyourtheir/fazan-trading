import type { MarketCandle } from './market-data.js';

// The caller supplies exactly one period of completed closes to seed the EMA.
export function backtestEma(seed: readonly MarketCandle[]) {
  const last = seed[seed.length - 1].close;
  let ema = last + seed.reduce((sum, bar) => sum + (bar.close - last), 0) / seed.length;
  const alpha = 2 / (seed.length + 1);
  return {
    initial: ema,
    next(bar: MarketCandle) {
      ema = seed.length === 1 ? bar.close : ema + (bar.close - ema) * alpha;
      return { ...bar, ema };
    },
  };
}
