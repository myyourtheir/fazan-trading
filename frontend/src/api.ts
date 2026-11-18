import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';

type Authenticated = { authenticated: true };
type Session = Authenticated & { remainingMs: number };
type Dashboard = { mode: 'stopped' };
const mutationHeaders = { 'X-Serfing-Request': '1' };
const changedSessionTags = (_data: unknown, error: unknown) => error ? [] : ['Session', 'Dashboard'] as const;

export const api = createApi({
  reducerPath: 'api',
  baseQuery: fetchBaseQuery({ baseUrl: '/api', credentials: 'same-origin' }),
  tagTypes: ['Session', 'Dashboard'],
  endpoints: builder => ({
    session: builder.query<Session, void>({ query: () => 'auth/session', providesTags: ['Session'] }),
    dashboard: builder.query<Dashboard, void>({ query: () => 'dashboard', providesTags: ['Dashboard'] }),
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
