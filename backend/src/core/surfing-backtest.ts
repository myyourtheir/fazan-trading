import {
  runBacktest,
  type BacktestChartCandle,
  type BacktestDataset,
  type BacktestParameters,
} from './backtest.js';
import type { BacktestAdapter } from './backtest-history.js';
import { backtestEma } from './backtest-ema.js';
import { crossing, type Side } from './crossing.js';
import { decideSurfing } from './surfing.js';

export function createSurfingBacktest(
  decide: (
    state: Parameters<typeof decideSurfing>[0],
    observation: Parameters<typeof decideSurfing>[1],
    parameters: BacktestParameters,
  ) => ReturnType<typeof decideSurfing>,
): BacktestAdapter<BacktestParameters, BacktestChartCandle, Side | null> {
  return {
    emaSource: 'local',
    warmupCount: ({ emaPeriod }) => emaPeriod,
    prepare(_parameters, selected, warmup, warmupInRange) {
      const last = warmup[warmup.length - 1].close;
      const ema = backtestEma(warmup);
      const initialState = crossing(null, last, ema.initial).side;
      const candles: BacktestChartCandle[] = selected.slice(0, warmupInRange).map((bar, index) => ({
        ...bar,
        ema: index === warmupInRange - 1 ? ema.initial : null,
      }));
      for (let index = warmupInRange; index < selected.length; index++)
        candles.push(ema.next(selected[index]));
      return { candles, initialState };
    },
    decide: (side, candle, parameters) => {
      if (candle.ema === null) return undefined;
      const result = decide({ side }, { ...candle, ema: candle.ema }, parameters);
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
