import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
import { addCandles, watchMarket, watchTrading, type MarketChartData, type MarketHistory, type MarketSelection } from './market-data';

type Authenticated = { authenticated: true };
type Session = Authenticated & { remainingMs: number };
export type Dashboard = { mode: 'stopped' | 'starting' | 'running' | 'paused'; reason: string | null; position: number | null };
export type JournalEntry = {
  id: string; accountId: string; instrumentUid: string; ticker: string; candleTime: number;
  signalTime: number; signalPrice: number; ema: number;
  direction: 'buy' | 'sell'; lots: number; fromPosition: number; targetPosition: number;
  brokerOrderId: string | null; brokerStatus: 'filled' | 'rejected' | 'cancelled' | 'new' | 'partial' | 'unknown';
  status: 'reserved' | 'confirmed' | 'unconfirmed' | 'stopped-before-send' | 'feed-lost-before-send';
  executedLots: number | null; position: number | null;
  executions: { tradeId: string; lots: number; price: number | null; time: number | null }[];
};
type SandboxAccount = { id: string; name: string };
export type SandboxStatus = {
  accountId: string | null;
  accounts: SandboxAccount[];
} & ({ status: 'connected'; virtualFundingRubles: number }
  | { status: 'unconfigured' }
  | { status: 'unavailable'; code: string });

export type FutureContract = {
  uid: string; ticker: string; name: string; classCode: string; exchange: string; expirationDate: string | null;
};
type StrategyConfig = {
  defaults: { ticker: string; emaPeriod: number };
  settings: { instrument: FutureContract; emaPeriod: number; lots: number } | null;
};
type StrategyUpdate = { accountId: string; instrumentUid: string; emaPeriod: number; lots: number };

export function hasStatus(error: unknown, status: number) {
  return typeof error === 'object' && error !== null && 'status' in error && error.status === status;
}

const mutationHeaders = { 'X-Serfing-Request': '1' };
const changedSessionTags = (_data: unknown, error: unknown) => error ? [] : ['Session', 'Dashboard', 'Sandbox', 'Strategy', 'Journal'] as const;
const changedSandboxTags = (_data: unknown, error: unknown) => error ? [] : ['Sandbox'] as const;

// RTK Query mutation arguments appear in Redux actions. Keep this credential out of Redux.
export async function saveSandboxToken(token: string): Promise<{ status: number; data: unknown } | null> {
  const response = await fetch('/api/sandbox/connection', {
    method: 'PUT', credentials: 'same-origin',
    headers: { ...mutationHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  return response.ok ? null : { status: response.status, data: await response.json().catch(() => null) };
}

export const api = createApi({
  reducerPath: 'api',
  baseQuery: fetchBaseQuery({ baseUrl: '/api', credentials: 'same-origin' }),
  tagTypes: ['Session', 'Dashboard', 'Sandbox', 'Strategy', 'Journal'],
  endpoints: builder => ({
    session: builder.query<Session, void>({ query: () => 'auth/session', providesTags: ['Session'] }),
    dashboard: builder.query<Dashboard, void>({
      query: () => 'dashboard', providesTags: ['Dashboard'], keepUnusedDataFor: 0,
      async onCacheEntryAdded(_arg, { cacheDataLoaded, cacheEntryRemoved, dispatch }) {
        try {
          await cacheDataLoaded;
        } catch {
          return;
        }
        await watchTrading(cacheEntryRemoved, () => { dispatch(api.util.invalidateTags(['Dashboard', 'Journal'])); });
      },
    }),
    journal: builder.query<JournalEntry[], void>({
      query: () => 'robot/history', providesTags: ['Journal'], keepUnusedDataFor: 0,
    }),
    robotCommand: builder.mutation<null, 'start' | 'stop'>({
      query: command => ({ url: `robot/${command}`, method: 'POST', headers: mutationHeaders }),
      invalidatesTags: ['Dashboard', 'Journal'],
    }),
    sandbox: builder.query<SandboxStatus, void>({ query: () => 'sandbox', providesTags: ['Sandbox'] }),
    strategy: builder.query<StrategyConfig, void>({ query: () => 'strategy', providesTags: ['Strategy'] }),
    market: builder.query<MarketChartData, MarketSelection>({
      keepUnusedDataFor: 0,
      async queryFn(selection, _api, _extra, fetchMarket) {
        const { data, error } = await fetchMarket('market');
        if (error?.status === 401) return { error };
        const history = data as MarketHistory | null | undefined;
        const matches = history?.instrumentUid === selection.instrumentUid && history.emaPeriod === selection.emaPeriod;
        return { data: { ...selection, candles: matches ? history.candles : [], historyAvailable: matches, stream: 'connecting' } };
      },
      merge(cache, incoming) {
        if (!cache.historyAvailable && incoming.historyAvailable) {
          cache.candles = addCandles(incoming.candles, cache.candles);
          cache.historyAvailable = true;
        }
      },
      async onCacheEntryAdded(selection, { cacheDataLoaded, cacheEntryRemoved, updateCachedData, dispatch }) {
        try {
          await cacheDataLoaded;
        } catch {
          return; // Cache entry was removed before the REST response.
        }
        await watchMarket(selection, cacheEntryRemoved, updateCachedData, () => {
          dispatch(api.util.invalidateTags(['Strategy']));
        });
      },
    }),
    searchFutures: builder.query<FutureContract[], string>({
      query: q => ({ url: 'strategy/futures', params: { q } }),
      providesTags: ['Sandbox'],
    }),
    saveStrategy: builder.mutation<null, StrategyUpdate>({
      query: body => ({ url: 'strategy', method: 'PUT', headers: mutationHeaders, body }),
      invalidatesTags: (_data, error) => error ? [] : ['Strategy'],
    }),
    selectSandboxAccount: builder.mutation<null, string>({
      query: accountId => ({ url: 'sandbox/account', method: 'PUT', headers: mutationHeaders, body: { accountId } }),
      invalidatesTags: changedSandboxTags,
    }),
    createSandboxAccount: builder.mutation<null, void>({
      query: () => ({ url: 'sandbox/accounts', method: 'POST', headers: mutationHeaders }),
      invalidatesTags: changedSandboxTags,
    }),
    fundSandboxAccount: builder.mutation<null, string>({
      query: accountId => ({ url: 'sandbox/funding', method: 'POST', headers: mutationHeaders, body: { accountId } }),
    }),
    login: builder.mutation<Authenticated, string>({
      query: password => ({ url: 'auth/login', method: 'POST', headers: mutationHeaders, body: { password } }),
      invalidatesTags: changedSessionTags,
    }),
    logout: builder.mutation<null, void>({
      query: () => ({ url: 'auth/logout', method: 'POST', headers: mutationHeaders }),
      invalidatesTags: changedSessionTags,
    }),
  }),
});
