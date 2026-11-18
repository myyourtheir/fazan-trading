import { ColorType, type UTCTimestamp } from 'lightweight-charts';

type Prices = { open: number; high: number; low: number; close: number };

export const chartTime = (time: number) => Math.floor(time / 1000) as UTCTimestamp;

export const candlePoint = ({ time, open, high, low, close }: Prices & { time: number }) => ({
  time: chartTime(time), open, high, low, close,
});

export const axisPriceFormatter = (precision: number) => new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: precision, maximumFractionDigits: precision,
}).format;

export function candlePricePrecision(candles: readonly Prices[]) {
  let precision = 0;
  for (const { open, high, low, close } of candles) {
    for (const price of [open, high, low, close]) {
      precision = Math.max(precision, (price.toFixed(9).split('.')[1] ?? '').replace(/0+$/, '').length);
    }
  }
  return precision;
}

export function priceChartTheme(container: HTMLElement) {
  const style = getComputedStyle(container);
  const token = (name: string) => style.getPropertyValue(name).trim();
  const border = token('--border');
  const foreground = token('--muted-foreground');
  const muted = token('--muted');
  const up = token('--primary');
  const down = token('--destructive');
  return {
    foreground,
    labelBackground: token('--foreground'),
    emaColor: token('--market-ema'),
    chart: {
      layout: { background: { type: ColorType.Solid as const, color: token('--card') }, textColor: foreground },
      grid: { vertLines: { color: muted }, horzLines: { color: muted } },
      rightPriceScale: { borderColor: border },
      timeScale: { borderColor: border },
    },
    candles: { upColor: up, downColor: down, borderVisible: false, wickUpColor: up, wickDownColor: down },
  };
}
