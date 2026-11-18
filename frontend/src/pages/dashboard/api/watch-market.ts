import { watchSocket } from '@/shared/api';
import { addCandles, type ChartCandle, type MarketChartData, type MarketHistory, type MarketSelection, type StreamState } from '../model/market-data';

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
    onConnect: () => update(data => { data.stream = 'connecting'; }),
    onReconnect: refreshHistory,
    onMessage(message: MarketUpdate) {
      const payload = message.history ?? message.tick;
      if (payload && (payload.instrumentUid !== selection.instrumentUid || payload.emaPeriod !== selection.emaPeriod)) return;
      update(cache => {
        if (message.history) {
          const snapshot = message.history.candles;
          const from = snapshot[0]?.time ?? -Infinity;
          cache.candles = addCandles(cache.candles.filter(candle => candle.time >= from), snapshot);
          cache.historyAvailable = true;
        } else if (message.tick) {
          cache.candles = addCandles(cache.candles, [message.tick.candle]);
        }
        setStream(cache, message.stream);
      });
    },
    onClose(code) {
      update(data => setStream(data, 'disconnected'));
      if (code === 1012) reloadSelection();
    },
  });
}
