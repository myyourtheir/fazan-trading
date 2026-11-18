import { rootApi } from '@/shared/api';

export type JournalEntry = {
  id: string; accountId: string; instrumentUid: string; ticker: string;
  action: 'ema-crossing' | 'manual-close'; manualCloseTime: number | null;
  candleTime: number | null; signalTime: number | null; signalPrice: number | null; ema: number | null;
  direction: 'buy' | 'sell'; lots: number; fromPosition: number; targetPosition: number;
  brokerOrderId: string | null; brokerStatus: 'filled' | 'rejected' | 'cancelled' | 'new' | 'partial' | 'unknown';
  status: 'reserved' | 'confirmed' | 'unconfirmed' | 'stopped-before-send' | 'feed-lost-before-send' | 'account-check-failed-before-send';
  executedLots: number | null; position: number | null;
  executions: { tradeId: string; lots: number; price: number | null; time: number | null }[];
};

export const journalApi = rootApi.injectEndpoints({
  endpoints: builder => ({
    journal: builder.query<JournalEntry[], string>({
      query: accountId => ({ url: 'robot/history', params: { accountId } }),
      providesTags: ['Journal'], keepUnusedDataFor: 0,
    }),
  }),
});
