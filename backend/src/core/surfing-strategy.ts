import { createSurfingBacktest } from './surfing-backtest.js';
import { findLiveCrossing } from './crossing.js';
import { decideSurfing, type SurfingObservation, type SurfingState } from './surfing.js';
import { defineStrategy } from './strategy.js';
import type { TradingConfig } from './robot.js';
import type { BacktestChartCandle, BacktestParameters } from './backtest.js';
import type { Side } from './crossing.js';

type Parameters = { emaPeriod: number; lots: number };
export type SurfingLiveConfig = TradingConfig & Parameters;
const positiveInt32 = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 2_147_483_647;

// A live reversal submits twice the configured target, in a PostgreSQL integer column.
export function canTradeSurfing(parameters: { lots: number }) {
  return positiveInt32(parameters.lots) && parameters.lots <= Math.floor(2_147_483_647 / 2);
}

export const surfingStrategy = defineStrategy<
  'surfing',
  Parameters,
  SurfingState,
  SurfingObservation,
  { close: number; ema: number },
  SurfingLiveConfig,
  BacktestParameters,
  BacktestChartCandle,
  Side | null
>({
  kind: 'surfing',
  validate(value): value is Parameters {
    if (typeof value !== 'object' || value === null) return false;
    const candidate = value as Record<string, unknown>;
    return (
      Object.keys(candidate).length === 2 &&
      positiveInt32(candidate.emaPeriod) &&
      positiveInt32(candidate.lots)
    );
  },
  decide: decideSurfing,
  live: (decide) => (history, options, config) =>
    findLiveCrossing(history, {
      ...options,
      lots: config.lots,
      decide: (state, observation) =>
        decide(state, observation, { lots: config.lots, emaPeriod: config.emaPeriod }),
    }),
  backtest: createSurfingBacktest,
});
