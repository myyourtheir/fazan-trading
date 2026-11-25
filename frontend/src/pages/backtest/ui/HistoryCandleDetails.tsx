import { useMemo } from 'react';
import { displayTimeFormatter } from '@/shared/lib/display-time';
import type { HistoricalCandle } from '../api/backtest-api';

const price = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 9 });
const ema = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 4 });

export function HistoryCandleDetails({
  candle,
  timeZone,
}: {
  candle: HistoricalCandle | undefined;
  timeZone: string;
}) {
  const formatTime = useMemo(() => displayTimeFormatter(timeZone), [timeZone]);
  const fields = [
    ['Свеча под курсором', candle && formatTime(candle.time)],
    ['Открытие', candle && price.format(candle.open)],
    ['Максимум', candle && price.format(candle.high)],
    ['Минимум', candle && price.format(candle.low)],
    ['Закрытие', candle && price.format(candle.close)],
    ['EMA', candle?.ema != null ? ema.format(candle.ema) : undefined],
  ];

  return (
    <dl
      aria-label="Свеча под курсором"
      className="grid grid-cols-2 gap-x-4 gap-y-2 py-2 text-xs sm:grid-cols-[2fr_repeat(5,1fr)]"
    >
      {fields.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="break-words font-medium tabular-nums">{value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}
