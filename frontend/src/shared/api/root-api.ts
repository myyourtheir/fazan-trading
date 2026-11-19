import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';

export const rootApi = createApi({
  reducerPath: 'api',
  baseQuery: fetchBaseQuery({ baseUrl: '/api', credentials: 'same-origin' }),
  tagTypes: ['Session', 'Dashboard', 'Sandbox', 'SandboxBalance', 'Strategy', 'Journal', 'Market', 'DisplaySettings'],
  endpoints: () => ({}),
});

export const mutationHeaders = { 'X-Serfing-Request': '1' };

export function hasStatus(error: unknown, status: number) {
  return typeof error === 'object' && error !== null && 'status' in error && error.status === status;
}
