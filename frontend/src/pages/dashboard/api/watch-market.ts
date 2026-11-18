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
  onReload: () => void,
) {
  await watchSocket('/api/market/live', removed, {
    onConnect: () => update(data => { data.stream = 'connecting'; }),
    onMessage(message: MarketUpdate) {
      const payload = message.history ?? message.tick;
      if (payload && (payload.instrumentUid !== selection.instrumentUid || payload.emaPeriod !== selection.emaPeriod)) return;
      update(cache => {
        if (message.history) {
          cache.candles = message.history.candles;
          cache.historyAvailable = true;
        } else if (message.tick) {
          cache.candles = addCandles(cache.candles, [message.tick.candle]);
        }
        setStream(cache, message.stream);
      });
    },
    onClose(code) {
      update(data => setStream(data, 'disconnected'));
      if (code === 1012) onReload();
    },
  });
}
