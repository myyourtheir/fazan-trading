import { mutationHeaders, rootApi, watchSocket } from '@/shared/api';

export type Dashboard = {
  mode: 'stopped' | 'starting' | 'running' | 'reconnecting' | 'paused'; reason: string | null; position: number | null;
  recovery?: { orderId: string; ready: boolean };
};
export type CloseSelection = { accountId: string; instrumentUid: string };
type RobotCommand = 'start' | 'stop' | 'reconcile' | 'resume' | CloseSelection;

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
        const refreshTrading = () => dispatch(rootApi.util.invalidateTags(['Dashboard', 'Journal']));
        await watchSocket('/api/robot/live', cacheEntryRemoved, {
          onReconnect: refreshTrading,
          onMessage(message: { tradingChanged: true }) {
            if (message.tradingChanged === true) refreshTrading();
          },
        });
      },
    }),
    robotCommand: builder.mutation<null, RobotCommand>({
      query: command => typeof command === 'string'
        ? { url: `robot/${command}`, method: 'POST', headers: mutationHeaders }
        : { url: 'robot/close', method: 'POST', headers: mutationHeaders, body: { ...command, confirmed: true } },
      invalidatesTags: ['Dashboard', 'Journal'],
    }),
  }),
});
