export type MarketSelection = { instrumentUid: string; emaPeriod: number };
export type ChartCandle = {
  time: number; open: number; high: number; low: number; close: number; complete: boolean;
  confirmedEma: number | null; previewEma: number | null;
};
export type StreamState = 'unconfigured' | 'connecting' | 'live' | 'disconnected';
export type MarketHistory = MarketSelection & { candles: ChartCandle[] };
export type MarketChartData = MarketHistory & { stream: StreamState; historyAvailable: boolean };
type MarketUpdate = {
  stream: StreamState;
  history?: MarketHistory;
  tick?: MarketSelection & { candle: ChartCandle };
};

export function addCandles(candles: ChartCandle[], updates: ChartCandle[]) {
  const byTime = new Map(candles.map(candle => [candle.time, candle]));
  for (const candle of updates) {
    if (candle.complete || !byTime.get(candle.time)?.complete) byTime.set(candle.time, candle);
  }
  const sorted = [...byTime.values()].sort((a, b) => a.time - b.time);
  return sorted.map((candle, index) =>
    index === sorted.length - 1 || candle.previewEma === null ? candle : { ...candle, previewEma: null });
}

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
  let socket: WebSocket | undefined;
  let retry: number | undefined;
  const url = new URL('/api/market/live', window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

  function connect() {
    update(data => { data.stream = 'connecting'; });
    const ws = socket = new WebSocket(url);
    ws.onmessage = ({ data }) => {
      try {
        const message = JSON.parse(data) as MarketUpdate;
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
      } catch { /* Ignore invalid messages. */ }
    };
    ws.onclose = ({ code }) => {
      update(data => setStream(data, 'disconnected'));
      if (code === 1012) onReload();
      if (code !== 1008) retry = window.setTimeout(connect, 2_000);
    };
  }

  connect();
  await removed;
  window.clearTimeout(retry);
  if (socket) {
    socket.onmessage = socket.onclose = null;
    socket.close();
  }
}
