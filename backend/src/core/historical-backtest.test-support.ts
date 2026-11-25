import { HistoricalBacktest, type FullBacktestParameters } from './historical-backtest.js';
import { minute } from './historical-simulation.js';
import type { MarketCandle } from './market-data.js';
import { timeframeMs } from './timeframe.js';

export const historyStart = Date.parse('2026-11-18T00:00:00Z');
export const moscowMidnight = historyStart - 3 * timeframeMs['1h'];
export const historyEnd = moscowMidnight + 24 * timeframeMs['1h'];
export const improvedRun = {
  kind: 'improved-surfing',
  instrumentUid: 'instrument',
  timeframe: '1h',
  emaPeriod: 2,
  atrPeriod: 1,
  stopAtrMultiplier: 2,
  addStepAtr: 1,
  maxAddOns: 3,
  tradeWeekends: false,
  from: '2026-11-18',
  to: '2026-11-18',
  initialMoney: 1000,
  commission: 0,
  slippage: 0,
} satisfies FullBacktestParameters;

export function historicalBar(
  time: number,
  open: number,
  close = open,
  low = Math.min(open, close) - 1,
  high = Math.max(open, close) + 1,
): MarketCandle {
  return { time, open, high, low, close, complete: true };
}

export function historicalFixture(
  bars: MarketCandle[],
  {
    timeframe = '1h',
    pointValue = 1,
    now = historyEnd + timeframeMs['1h'],
  }: {
    timeframe?: FullBacktestParameters['timeframe'];
    pointValue?: number;
    now?: number;
  } = {},
) {
  const interval = timeframeMs[timeframe];
  const candles = [...bars];
  const minutes: MarketCandle[] = [];
  for (const bar of candles) {
    for (let time = bar.time; time < bar.time + interval; time += minute) {
      const first = time === bar.time;
      minutes.push({
        time,
        open: first ? bar.open : bar.close,
        close: bar.close,
        high: first ? bar.high : bar.close,
        low: first ? bar.low : bar.close,
        complete: true,
      });
    }
  }
  const inRange = <T extends { time: number }>(rows: T[], from: Date, to: Date) =>
    rows.filter(({ time }) => time >= +from && time <= +to);
  const calls = { minutes: [] as [number, number][] };
  const backtest = new HistoricalBacktest(
    {
      async backtestFuture() {
        return {
          firstTrade: new Date(moscowMidnight - 3 * 24 * timeframeMs['1h']),
          lastTrade: undefined,
          currency: 'rub',
          lot: 1,
          priceStep: 0.5,
          priceStepAmount: 0.5 * pointValue,
        };
      },
      async backtestCandles(_token, _uid, _timeframe, from, to) {
        return inRange(candles, from, to);
      },
      async minuteCandles(_token, _uid, from, to) {
        calls.minutes.push([+from, +to]);
        return inRange(minutes, from, to);
      },
    },
    async () => 'test',
    () => now,
  );
  return { backtest, candles, minutes, calls };
}
