import { mutationHeaders, rootApi } from '@/shared/api';
import type { Timeframe } from '@/entities/strategy';

export type BacktestRequest = {
  instrumentUid: string;
  timeframe: Timeframe;
  emaPeriod: number;
  lots: number;
  from: string;
  to: string;
  commission: number;
  slippage: number;
};
export type BacktestParameters = BacktestRequest & { timeZone: string };
export type HistoricalCandle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  ema: number;
};
export type BacktestExecution = {
  time: number;
  direction: 'buy' | 'sell';
  lots: number;
  price: number;
  commission: number;
};
export type BacktestSignal = {
  candleTime: number;
  direction: 'buy' | 'sell';
  targetPosition: number;
};
export type BacktestReport = {
  parameters: BacktestParameters;
  currency: string;
  pointValue: number;
  priceStep: number;
  priceStepAmount: number;
  lot: number;
  candles: HistoricalCandle[];
  executions: BacktestExecution[];
  finalSignal: BacktestSignal | null;
  result: { closed: number; open: number; total: number; position: number; maxDrawdown: number };
  cutoff: number | null;
};
type BacktestLimits = { maxDays: number; maxEmaPeriod: number };

export const backtestApi = rootApi.injectEndpoints({
  endpoints: (builder) => ({
    backtestLimits: builder.query<BacktestLimits, void>({ query: () => 'backtest/limits' }),
    runBacktest: builder.mutation<BacktestReport, BacktestRequest>({
      query: (body) => ({ url: 'backtest/run', method: 'POST', headers: mutationHeaders, body }),
    }),
  }),
});
