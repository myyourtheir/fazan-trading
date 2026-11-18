import { mutationHeaders, rootApi } from '@/shared/api';

type SandboxAccount = { id: string; name: string };
export type SandboxStatus = {
  accountId: string | null;
  accounts: SandboxAccount[];
} & ({ status: 'connected'; virtualFundingRubles: number }
  | { status: 'unconfigured' }
  | { status: 'unavailable'; code: string });

const changedSandboxTags = (_data: unknown, error: unknown) => error ? [] : ['Sandbox'] as const;

export function selectedSandboxAccount(connection: SandboxStatus | undefined) {
  return connection?.status === 'connected' ? connection.accounts.find(account => account.id === connection.accountId) : undefined;
}

// RTK Query mutation arguments appear in Redux actions. Keep this credential out of Redux.
export async function saveSandboxToken(token: string): Promise<{ status: number; data: unknown } | null> {
  const response = await fetch('/api/sandbox/connection', {
    method: 'PUT', credentials: 'same-origin',
    headers: { ...mutationHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  return response.ok ? null : { status: response.status, data: await response.json().catch(() => null) };
}

export const sandboxApi = rootApi.injectEndpoints({
  endpoints: builder => ({
    sandbox: builder.query<SandboxStatus, void>({ query: () => 'sandbox', providesTags: ['Sandbox'] }),
    sandboxBalance: builder.query<{ accountId: string; rubles: number | null }, string>({
      query: accountId => ({ url: 'sandbox/balance', params: { accountId } }),
      providesTags: (_data, _error, id) => [{ type: 'SandboxBalance', id }],
      keepUnusedDataFor: 0,
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
      invalidatesTags: (_data, error, id) => error ? [] : [{ type: 'SandboxBalance', id }],
    }),
  }),
});
