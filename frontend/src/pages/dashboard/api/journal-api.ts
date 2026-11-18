import { rootApi } from '@/shared/api';

export type JournalEntry = {
  id: string; accountId: string; instrumentUid: string; ticker: string; candleTime: number;
  signalTime: number; signalPrice: number; ema: number;
  direction: 'buy' | 'sell'; lots: number; fromPosition: number; targetPosition: number;
  brokerOrderId: string | null; brokerStatus: 'filled' | 'rejected' | 'cancelled' | 'new' | 'partial' | 'unknown';
  status: 'reserved' | 'confirmed' | 'unconfirmed' | 'stopped-before-send' | 'feed-lost-before-send';
  executedLots: number | null; position: number | null;
  executions: { tradeId: string; lots: number; price: number | null; time: number | null }[];
};

export const journalApi = rootApi.injectEndpoints({
  endpoints: builder => ({
    journal: builder.query<JournalEntry[], void>({
      query: () => 'robot/history', providesTags: ['Journal'], keepUnusedDataFor: 0,
    }),
  }),
});
