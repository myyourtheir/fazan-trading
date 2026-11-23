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
export type StrategyKind = 'surfing' | 'improved-surfing';
export type ImprovedParameters = {
  emaPeriod: number;
  atrPeriod: number;
  stopAtrMultiplier: number;
  addStepAtr: number;
  maxAddOns: number;
  tradeWeekends: boolean;
};
type SavedProfile<P> = {
  instrument: FutureContract;
  timeframe: Timeframe;
  parameters: P;
};
export type StrategyProfiles = {
  selected: StrategyKind;
  legacyClaimAvailable: boolean;
  profiles: {
    surfing: {
      defaults: StrategyConfig['defaults'];
      settings: SavedProfile<{ emaPeriod: number; lots: number }> | null;
    };
    'improved-surfing': {
      defaults: ImprovedParameters & { ticker: string; timeframe: Timeframe };
      settings: SavedProfile<ImprovedParameters> | null;
    };
  };
};

export const strategyApi = rootApi.injectEndpoints({
  endpoints: (builder) => ({
    strategy: builder.query<StrategyConfig, void>({
      query: () => 'strategy',
      providesTags: ['Strategy'],
    }),
    profiles: builder.query<StrategyProfiles, void>({
      query: () => 'strategy/profiles',
      providesTags: ['Strategy'],
    }),
    selectStrategy: builder.mutation<null, { accountId: string; kind: StrategyKind }>({
      query: (body) => ({
        url: 'strategy/selection',
        method: 'PUT',
        headers: mutationHeaders,
        body,
      }),
      invalidatesTags: (_data, error) => (error ? [] : ['Strategy', 'Dashboard']),
    }),
    claimLegacy: builder.mutation<null, void>({
      query: () => ({
        url: 'strategy/legacy-claim',
        method: 'POST',
        headers: mutationHeaders,
        body: { confirmed: true },
      }),
      invalidatesTags: (_data, error) => (error ? [] : ['Strategy', 'Dashboard']),
    }),
    saveProfile: builder.mutation<
      null,
      {
        accountId: string;
        instrumentUid: string;
        timeframe: Timeframe;
        kind: StrategyKind;
        parameters: ImprovedParameters | { emaPeriod: number; lots: number };
      }
    >({
      query: (body) => ({ url: 'strategy', method: 'PUT', headers: mutationHeaders, body }),
      invalidatesTags: (_data, error) => (error ? [] : ['Strategy', 'Dashboard']),
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
