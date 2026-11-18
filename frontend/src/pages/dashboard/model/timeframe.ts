export const timeframes = ['5m', '15m', '30m', '1h'] as const;
export type Timeframe = (typeof timeframes)[number];

export const timeframeLabels: Record<Timeframe, string> = {
  '5m': '5 минут',
  '15m': '15 минут',
  '30m': '30 минут',
  '1h': '1 час',
};
