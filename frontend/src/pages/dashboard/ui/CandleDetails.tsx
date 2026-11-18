import { emaPrice, price, utc } from "../lib/chart-format";
import type { ChartCandle } from "../model/market-data";

export function CandleDetails({ candle, hovered }: { candle: ChartCandle; hovered: boolean }) {
  const fields = [
    ["Открытие", price.format(candle.open)],
    ["Максимум", price.format(candle.high)],
    ["Минимум", price.format(candle.low)],
    [
      candle.complete ? "Закрытие" : "Закрытие (текущее)",
      price.format(candle.close),
    ],
    [
      candle.previewEma !== null ? "Предварительная EMA" : "Подтверждённая EMA",
      candle.confirmedEma !== null
        ? emaPrice.format(candle.confirmedEma)
        : candle.previewEma !== null
          ? emaPrice.format(candle.previewEma)
          : "Нет подтверждения",
    ],
  ];
  return (
    <dl
      aria-label={hovered ? "Выбранная свеча" : "Последняя свеча"}
      className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs"
    >
      <div className="flex gap-1">
        <dt className="sr-only">Начало свечи</dt>
        <dd className="font-medium tabular-nums">
          {utc.format(candle.time)} UTC
        </dd>
      </div>
      {fields.map(([label, value]) => (
        <div key={label} className="flex gap-1">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
