import { mutationHeaders, rootApi } from '@/shared/api';
import type { ImprovedParameters, Timeframe } from '@/entities/strategy';

export const backtestTimeZone = 'Europe/Moscow';

export type BacktestRequest = {
  instrumentUid: string;
  timeframe: Timeframe;
  emaPeriod: number;
  from: string;
  to: string;
  commission: number;
  slippage: number;
  initialMoney: number;
} & ({ kind: 'surfing'; lots: number } | ({ kind: 'improved-surfing' } & ImprovedParameters));
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
  reason: 'entry' | 'add-on' | 'reversal-exit' | 'reversal-entry' | 'gap' | 'stop';
};
export type EquityPoint = { time: number; value: number };
export type BacktestReport = {
  parameters: BacktestParameters;
  currency: string;
  pointValue: number;
  priceStep: number;
  priceStepAmount: number;
  lot: number;
  candles: HistoricalCandle[];
  executions: BacktestExecution[];
  equity: EquityPoint[];
  model: { missingMinutes: number; marginPerLotAtClose: number };
  result: {
    closed: number;
    open: number;
    total: number;
    position: number;
    maxDrawdown: number;
    commission: number;
    returnPercent: number;
  };
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
