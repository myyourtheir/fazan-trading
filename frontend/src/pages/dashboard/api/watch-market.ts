import { watchSocket } from '@/shared/api';
import { addCandles, sameCandle, sameMarketSelection, type ChartCandle, type MarketChartData, type MarketHistory, type MarketSelection, type StreamState } from '../model/market-data';

type MarketUpdate = {
  stream: StreamState;
  history?: MarketHistory;
  tick?: MarketSelection & { candle: ChartCandle };
};

function setStream(data: MarketChartData, stream: StreamState) {
  data.stream = stream;
  if (stream === 'disconnected') {
    for (const candle of data.candles) candle.previewEma = null;
  }
}

export async function watchMarket(
  selection: MarketSelection,
  removed: Promise<void>,
  update: (recipe: (data: MarketChartData) => void) => void,
  { refreshHistory, reloadSelection }: { refreshHistory: () => void; reloadSelection: () => void },
) {
  await watchSocket('/api/market/live', removed, {
    onConnecting: () => update(data => { data.stream = 'connecting'; }),
    onReconnect() {
      update(cache => { cache.catchUp = { receivedSnapshot: false, liveTimes: {} }; });
      refreshHistory();
    },
    onMessage(message: MarketUpdate) {
      const payload = message.history ?? message.tick;
      if (payload && !sameMarketSelection(payload, selection)) return;
      update(cache => {
        if (message.history) {
          const snapshot = message.history.candles;
          if (cache.catchUp) {
            // The initial socket snapshot can predate the new REST request. Protect only subsequent changes.
            if (cache.catchUp.receivedSnapshot) {
              const previous = new Map(cache.candles.map(candle => [candle.time, candle]));
              for (const candle of snapshot) {
                if (!sameCandle(previous.get(candle.time), candle)) cache.catchUp.liveTimes[candle.time] = true;
              }
            }
            cache.catchUp.receivedSnapshot = true;
          }
          const from = snapshot[0]?.time ?? -Infinity;
          cache.candles = addCandles(cache.candles.filter(candle => candle.time >= from), snapshot);
          cache.historyAvailable = true;
        } else if (message.tick) {
          const candle = message.tick.candle;
          if (cache.catchUp) cache.catchUp.liveTimes[candle.time] = true;
          cache.candles = addCandles(cache.candles, [candle]);
        }
        setStream(cache, message.stream);
      });
    },
    onClose(code) {
      update(data => {
        data.catchUp = undefined;
        setStream(data, 'disconnected');
      });
      if (code === 1012) reloadSelection();
    },
  });
}
