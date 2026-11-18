import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';

type Authenticated = { authenticated: true };
type Session = Authenticated & { remainingMs: number };
type Dashboard = { mode: 'stopped' };
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
const changedSessionTags = (_data: unknown, error: unknown) => error ? [] : ['Session', 'Dashboard', 'Sandbox', 'Strategy'] as const;
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
  tagTypes: ['Session', 'Dashboard', 'Sandbox', 'Strategy'],
  endpoints: builder => ({
    session: builder.query<Session, void>({ query: () => 'auth/session', providesTags: ['Session'] }),
    dashboard: builder.query<Dashboard, void>({ query: () => 'dashboard', providesTags: ['Dashboard'] }),
    sandbox: builder.query<SandboxStatus, void>({ query: () => 'sandbox', providesTags: ['Sandbox'] }),
    strategy: builder.query<StrategyConfig, void>({ query: () => 'strategy', providesTags: ['Strategy'] }),
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
