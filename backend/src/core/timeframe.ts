export const timeframeMs = {
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
} as const;

export type Timeframe = keyof typeof timeframeMs;
export const defaultTimeframe: Timeframe = '1h';

export function isTimeframe(value: unknown): value is Timeframe {
  return typeof value === 'string' && Object.hasOwn(timeframeMs, value);
}
