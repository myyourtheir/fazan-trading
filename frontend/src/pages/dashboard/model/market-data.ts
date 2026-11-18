export type MarketSelection = { instrumentUid: string; emaPeriod: number };
export type ChartCandle = {
  time: number; open: number; high: number; low: number; close: number; complete: boolean;
  confirmedEma: number | null; previewEma: number | null;
};
export type StreamState = 'unconfigured' | 'connecting' | 'live' | 'disconnected';
export type MarketHistory = MarketSelection & { candles: ChartCandle[] };
export type MarketChartData = MarketHistory & { stream: StreamState; historyAvailable: boolean };

export function addCandles(candles: ChartCandle[], updates: ChartCandle[]) {
  const byTime = new Map(candles.map(candle => [candle.time, candle]));
  for (const candle of updates) {
    if (candle.complete || !byTime.get(candle.time)?.complete) byTime.set(candle.time, candle);
  }
  const sorted = [...byTime.values()].sort((a, b) => a.time - b.time);
  return sorted.map((candle, index) =>
    index === sorted.length - 1 || candle.previewEma === null ? candle : { ...candle, previewEma: null });
}
