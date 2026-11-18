import { mutationHeaders, rootApi, watchSocket } from '@/shared/api';

export type Dashboard = { mode: 'stopped' | 'starting' | 'running' | 'paused'; reason: string | null; position: number | null };

export const robotApi = rootApi.injectEndpoints({
  endpoints: builder => ({
    dashboard: builder.query<Dashboard, void>({
      query: () => 'dashboard', providesTags: ['Dashboard'], keepUnusedDataFor: 0,
      async onCacheEntryAdded(_arg, { cacheDataLoaded, cacheEntryRemoved, dispatch }) {
        try {
          await cacheDataLoaded;
        } catch {
          return;
        }
        await watchSocket('/api/robot/live', cacheEntryRemoved, {
          onMessage(message: { tradingChanged: true }) {
            if (message.tradingChanged === true) dispatch(rootApi.util.invalidateTags(['Dashboard', 'Journal']));
          },
        });
      },
    }),
    robotCommand: builder.mutation<null, 'start' | 'stop'>({
      query: command => ({ url: `robot/${command}`, method: 'POST', headers: mutationHeaders }),
      invalidatesTags: ['Dashboard', 'Journal'],
    }),
  }),
});
