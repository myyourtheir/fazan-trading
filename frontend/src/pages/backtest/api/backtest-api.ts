import { mutationHeaders, rootApi } from '@/shared/api';
import type { Timeframe } from '@/entities/strategy';

export type BacktestParameters = {
  instrumentUid: string; timeframe: Timeframe; emaPeriod: number; lots: number; from: string; to: string;
};
export type HistoricalCandle = { time: number; open: number; high: number; low: number; close: number; ema: number };
type HistoryCheck = { parameters: BacktestParameters; candles: HistoricalCandle[]; cutoff: number | null };
type BacktestLimits = { maxDays: number; maxEmaPeriod: number };

export const backtestApi = rootApi.injectEndpoints({
  endpoints: builder => ({
    backtestLimits: builder.query<BacktestLimits, void>({ query: () => 'backtest/limits' }),
    checkBacktestHistory: builder.mutation<HistoryCheck, BacktestParameters>({
      query: body => ({ url: 'backtest/history', method: 'POST', headers: mutationHeaders, body }),
    }),
  }),
});
