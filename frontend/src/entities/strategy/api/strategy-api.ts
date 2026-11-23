import { mutationHeaders, rootApi } from '@/shared/api';
import type { Timeframe } from '../model/timeframe';

export type FutureContract = {
  uid: string;
  ticker: string;
  name: string;
  classCode: string;
  exchange: string;
  expirationDate: string | null;
};
export type StrategyConfig = {
  defaults: { ticker: string; emaPeriod: number; timeframe: Timeframe };
  settings: {
    instrument: FutureContract;
    emaPeriod: number;
    lots: number;
    timeframe: Timeframe;
  } | null;
};
type StrategyUpdate = {
  accountId: string;
  instrumentUid: string;
  emaPeriod: number;
  lots: number;
  timeframe: Timeframe;
};

export const strategyApi = rootApi.injectEndpoints({
  endpoints: (builder) => ({
    strategy: builder.query<StrategyConfig, void>({
      query: () => 'strategy',
      providesTags: ['Strategy'],
    }),
    searchFutures: builder.query<FutureContract[], string>({
      query: (q) => ({ url: 'strategy/futures', params: { q } }),
      providesTags: ['Sandbox'],
    }),
    saveStrategy: builder.mutation<null, StrategyUpdate>({
      query: (body) => ({ url: 'strategy', method: 'PUT', headers: mutationHeaders, body }),
      invalidatesTags: (_data, error) => (error ? [] : ['Strategy', 'Dashboard']),
    }),
  }),
});
