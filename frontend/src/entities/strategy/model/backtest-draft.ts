import type { Timeframe } from './timeframe';

// A one-shot snapshot of the strategy draft handed to the backtest form, never saved or written to
// the URL. `emaPeriod` and `lots` stay strings to mirror the controlled form fields they seed.
export type BacktestDraft = {
  instrumentUid: string; ticker: string; timeframe: Timeframe; emaPeriod: string; lots: string;
};
