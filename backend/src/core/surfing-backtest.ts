import {
  runBacktest,
  type BacktestCandle,
  type BacktestDataset,
  type BacktestParameters,
} from './backtest.js';
import type { BacktestAdapter } from './backtest-history.js';
import { crossing, type Side } from './crossing.js';
import { decideSurfing } from './surfing.js';

export function createSurfingBacktest(
  decide: (
    state: Parameters<typeof decideSurfing>[0],
    observation: Parameters<typeof decideSurfing>[1],
    parameters: BacktestParameters,
  ) => ReturnType<typeof decideSurfing>,
): BacktestAdapter<BacktestParameters, BacktestCandle, Side | null> {
  return {
    warmupCount: ({ emaPeriod }) => emaPeriod,
    prepare({ emaPeriod }, selected, warmup) {
      const last = warmup[warmup.length - 1].close;
      let ema = last + warmup.reduce((sum, bar) => sum + (bar.close - last), 0) / emaPeriod;
      const initialState = crossing(null, last, ema).side;
      const alpha = 2 / (emaPeriod + 1);
      const candles = selected.map((bar) => {
        ema = emaPeriod === 1 ? bar.close : ema + (bar.close - ema) * alpha;
        return { ...bar, ema };
      });
      return { candles, initialState };
    },
    decide: (side, candle, parameters) => {
      const result = decide({ side }, candle, parameters);
      return { ...result, state: result.state.side };
    },
  };
}
export const surfingBacktest = createSurfingBacktest(decideSurfing);

// Compatibility helper for direct Surfing simulations with prepared EMA data.
export function runSurfingBacktest(dataset: BacktestDataset, decide = decideSurfing) {
  return runBacktest(dataset, (side, candle, parameters) => {
    const result = decide({ side }, candle, parameters);
    return { ...result, state: result.state.side };
  });
}
