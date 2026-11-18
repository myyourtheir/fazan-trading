import { rootApi } from '@/shared/api';
import { addCandles, type MarketChartData, type MarketHistory, type MarketSelection } from '../model/market-data';
import { watchMarket } from './watch-market';

export const marketApi = rootApi.injectEndpoints({
  endpoints: builder => ({
    market: builder.query<MarketChartData, MarketSelection>({
      keepUnusedDataFor: 0,
      providesTags: ['Market'],
      async queryFn(selection, _api, _extra, fetchMarket) {
        const { data, error } = await fetchMarket('market');
        if (error?.status === 401) return { error };
        const history = data as MarketHistory | null | undefined;
        const matches = history?.instrumentUid === selection.instrumentUid && history.emaPeriod === selection.emaPeriod;
        return { data: { ...selection, candles: matches ? history.candles : [], historyAvailable: matches, stream: 'connecting' } };
      },
      merge(cache, incoming) {
        if (incoming.historyAvailable) {
          const catchUp = cache.catchUp;
          if (catchUp) {
            const retained = cache.candles.filter(candle => !catchUp.liveTimes[candle.time]);
            const newer = cache.candles.filter(candle => catchUp.liveTimes[candle.time]);
            cache.candles = addCandles(addCandles(retained, incoming.candles), newer);
            cache.catchUp = undefined;
          } else {
            cache.candles = addCandles(incoming.candles, cache.candles);
          }
          cache.historyAvailable = true;
        }
      },
      async onCacheEntryAdded(selection, { cacheDataLoaded, cacheEntryRemoved, updateCachedData, dispatch }) {
        try {
          await cacheDataLoaded;
        } catch {
          return; // Cache entry was removed before the REST response.
        }
        await watchMarket(selection, cacheEntryRemoved, updateCachedData, {
          refreshHistory: () => dispatch(rootApi.util.invalidateTags(['Market'])),
          reloadSelection: () => dispatch(rootApi.util.invalidateTags(['Strategy'])),
        });
      },
    }),
  }),
});
