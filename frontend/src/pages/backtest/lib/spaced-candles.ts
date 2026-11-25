import {
  customSeriesDefaultOptions,
  type CustomSeriesOptions,
  type IChartApi,
  type ICustomSeriesPaneRenderer,
  type ICustomSeriesPaneView,
  type Time,
} from 'lightweight-charts';
import type { candlePoint } from '@/shared/lib/price-chart';

type Candle = ReturnType<typeof candlePoint>;
type CandleOptions = CustomSeriesOptions & { upColor: string; downColor: string };

export function addSpacedCandles(chart: IChartApi, timeframeMinutes: number) {
  const renderer: ICustomSeriesPaneRenderer = { draw: () => {} };
  let candleAt: (x: number) => number | undefined = () => undefined;

  const view: ICustomSeriesPaneView<Time, Candle, CandleOptions> = {
    priceValueBuilder: ({ low, high, close }) => [low, high, close],
    isWhitespace: (point): point is { time: Time } => !('close' in point),
    defaultOptions: () => ({
      ...customSeriesDefaultOptions,
      upColor: '#26a69a',
      downColor: '#ef5350',
    }),
    renderer: () => renderer,
    update: ({ bars, visibleRange, barSpacing }, { upColor, downColor }) => {
      function bodyWidthAt(i: number) {
        const { time } = bars[i]!;
        // Time slots are minutes, not candles. Missing minutes can bring openings closer.
        const slots = Math.min(
          timeframeMinutes,
          time - (bars[i - 1]?.time ?? -Infinity),
          (bars[i + 1]?.time ?? Infinity) - time,
        );
        return Math.min(24, 0.8 * barSpacing * slots);
      }

      candleAt = (x) => {
        if (!visibleRange) return;
        let from = visibleRange.from;
        let to = visibleRange.to;
        while (from < to) {
          const middle = Math.floor((from + to) / 2);
          if (bars[middle]!.x < x) from = middle + 1;
          else to = middle;
        }
        const i =
          from === visibleRange.to ||
          (from > visibleRange.from && x - bars[from - 1]!.x < bars[from]!.x - x)
            ? from - 1
            : from;
        if (i < visibleRange.from) return;
        const bar = bars[i]!;
        if (Math.abs(bar.x - x) <= Math.max(1, bodyWidthAt(i)) / 2) {
          const time = chart.timeScale().coordinateToTime(bar.x);
          if (typeof time === 'number') return time;
        }
      };

      renderer.draw = (target, priceToCoordinate) => {
        if (!visibleRange) return;
        target.useBitmapCoordinateSpace(({ context, horizontalPixelRatio, verticalPixelRatio }) => {
          const wickWidth = Math.max(1, Math.floor(horizontalPixelRatio));
          for (let i = visibleRange.from; i < visibleRange.to; i++) {
            const { x, originalData: candle } = bars[i]!;
            const open = priceToCoordinate(candle.open);
            const close = priceToCoordinate(candle.close);
            const high = priceToCoordinate(candle.high);
            const low = priceToCoordinate(candle.low);
            if (open === null || close === null || high === null || low === null) continue;

            const bodyWidth = Math.max(
              wickWidth,
              Math.floor(bodyWidthAt(i) * horizontalPixelRatio),
            );
            const center = Math.round(x * horizontalPixelRatio);
            const top = Math.round(Math.min(open, close) * verticalPixelRatio);
            const bottom = Math.round(Math.max(open, close) * verticalPixelRatio);
            const wickTop = Math.round(high * verticalPixelRatio);
            const wickBottom = Math.round(low * verticalPixelRatio);

            context.fillStyle = candle.close >= candle.open ? upColor : downColor;
            // Keep the body distinct from the wick even when both are one pixel wide.
            if (bodyWidth === wickWidth) context.globalAlpha = 0.55;
            context.fillRect(
              center - Math.floor(wickWidth / 2),
              Math.min(wickTop, wickBottom),
              wickWidth,
              Math.abs(wickBottom - wickTop) + 1,
            );
            context.globalAlpha = 1;
            context.fillRect(center - Math.floor(bodyWidth / 2), top, bodyWidth, bottom - top + 1);
          }
        });
      };
    },
  };
  return { series: chart.addCustomSeries(view), candleAt: (x: number) => candleAt(x) };
}
