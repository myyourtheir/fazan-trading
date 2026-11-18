import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineSeries,
  LineStyle,
  createChart,
  type ISeriesApi,
  type LineData,
  type MouseEventParams,
  type Time,
} from "lightweight-charts";
import type { ChartCandle } from "../model/market-data";
import { chartTime, utc } from "./chart-format";

const axisPriceFormatter = (precision: number) =>
  new Intl.NumberFormat("ru-RU", {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  }).format;

const candlePoint = ({ time, open, high, low, close }: ChartCandle) => ({
  time: chartTime(time),
  open,
  high,
  low,
  close,
});
const samePoint = (a: LineData<Time>, b: LineData<Time>) =>
  a.time === b.time && a.value === b.value;

function sameBar(a: ChartCandle, b: ChartCandle) {
  return (
    a.time === b.time &&
    a.open === b.open &&
    a.high === b.high &&
    a.low === b.low &&
    a.close === b.close
  );
}

function confirmedSegments(candles: ChartCandle[]) {
  const segments: LineData<Time>[][] = [];
  let segment: LineData<Time>[] | undefined;
  for (const { time, confirmedEma } of candles) {
    if (confirmedEma === null) {
      segment = undefined;
    } else {
      if (!segment) segments.push((segment = []));
      segment.push({ time: chartTime(time), value: confirmedEma });
    }
  }
  return segments;
}

function previewPoints(candles: ChartCandle[]): LineData<Time>[] {
  const last = candles.at(-1);
  if (!last || last.previewEma === null) return [];
  const confirmed = candles.findLast((candle) => candle.confirmedEma !== null);
  return confirmed?.confirmedEma != null
    ? [
        { time: chartTime(confirmed.time), value: confirmed.confirmedEma },
        { time: chartTime(last.time), value: last.previewEma },
      ]
    : [];
}

export function createPriceChart(
  container: HTMLDivElement,
  onHover: (time: number | undefined) => void,
) {
  const chart = createChart(container, {
    autoSize: true,
    layout: { attributionLogo: false },
    crosshair: { mode: CrosshairMode.Normal },
    rightPriceScale: { visible: true },
    timeScale: {
      visible: true,
      timeVisible: true,
      secondsVisible: false,
      rightOffset: 2,
      fixLeftEdge: true,
      lockVisibleTimeRangeOnResize: true,
    },
    localization: {
      locale: "ru-RU",
      // Both price ticks and the crosshair label use this formatter.
      priceFormatter: axisPriceFormatter(0),
      timeFormatter: (time: Time) =>
        typeof time === "number" ? `${utc.format(time * 1000)} UTC` : "",
    },
  });
  const bars = chart.addSeries(CandlestickSeries);
  const emaOptions = {
    lastValueVisible: false,
    priceLineVisible: false,
    lineWidth: 1 as const,
  };
  const preview = chart.addSeries(LineSeries, {
    ...emaOptions,
    pointMarkersRadius: 0,
    lineStyle: LineStyle.Dashed,
  });
  const confirmed: ISeriesApi<"Line">[] = [];
  let emaColor = "";
  let previous: ChartCandle[] = [];
  let previousPreview: LineData<Time>[] = [];
  let pricePrecision = 0;
  const scale = chart.timeScale();

  function hover({ time, seriesData }: MouseEventParams<Time>) {
    onHover(
      typeof time === "number" && seriesData.has(bars) ? time : undefined,
    );
  }
  chart.subscribeCrosshairMove(hover);

  function updateConfirmed(candles: ChartCandle[]) {
    // The built-in LineSeries connects across whitespace, so each confirmed run gets its own series.
    const segments = confirmedSegments(candles);
    while (confirmed.length > segments.length)
      chart.removeSeries(confirmed.pop()!);
    segments.forEach((points, index) => {
      const series =
        confirmed[index] ??
        (confirmed[index] = chart.addSeries(LineSeries, {
          ...emaOptions,
          color: emaColor,
          pointMarkersVisible: false,
          crosshairMarkerVisible: false,
        }));
      const old = series.data() as readonly LineData<Time>[];
      if (
        points.length >= old.length &&
        old.every((point, i) => samePoint(point, points[i]))
      ) {
        for (const point of points.slice(old.length)) series.update(point);
      } else {
        series.setData(points);
      }
    });
  }

  return {
    setCandles(candles: ChartCandle[]) {
      const precision = Math.max(
        0,
        ...candles.flatMap(({ open, high, low, close }) =>
          [open, high, low, close].map(
            (value) =>
              (value.toFixed(9).split(".")[1] ?? "").replace(/0+$/, "").length,
          ),
        ),
      );
      if (precision !== pricePrecision) {
        const seriesPrecision = Math.max(2, precision);
        if (seriesPrecision !== Math.max(2, pricePrecision)) {
          bars.applyOptions({
            priceFormat: {
              type: "price",
              precision: seriesPrecision,
              minMove: 10 ** -seriesPrecision,
            },
          });
        }
        pricePrecision = precision;
        chart.applyOptions({
          localization: { priceFormatter: axisPriceFormatter(precision) },
        });
      }
      const tail = previous.length - 1;
      let restoreViewport: (() => void) | undefined;
      if (
        tail >= 0 &&
        previous.length <= candles.length &&
        previous[tail].time === candles[tail].time &&
        previous
          .slice(0, tail)
          .every((bar, index) => sameBar(bar, candles[index]))
      ) {
        // Update the forming bar or append to the right without resetting the viewport.
        for (let index = tail; index < candles.length; index++) {
          if (index === tail && sameBar(previous[tail], candles[index]))
            continue;
          bars.update(candlePoint(candles[index]));
        }
      } else {
        // Keep horizontal zoom unchanged. If old bars shift indices, compensate in bar offsets.
        const range = scale.getVisibleLogicalRange();
        const position = scale.scrollPosition();
        const indices = new Map(
          candles.map(({ time }, index) => [time, index]),
        );
        const middle = range ? (range.from + range.to) / 2 : 0;
        const anchor = previous
          .map(({ time }, oldIndex) => ({
            oldIndex,
            newIndex: indices.get(time),
          }))
          .filter((item) => item.newIndex !== undefined)
          .sort(
            (a, b) =>
              Math.abs(a.oldIndex - middle) - Math.abs(b.oldIndex - middle),
          )[0];
        bars.setData(candles.map(candlePoint));
        if (!range) restoreViewport = () => scale.fitContent();
        else if (range.to >= tail)
          restoreViewport = () => scale.scrollToPosition(position, false);
        else if (anchor?.newIndex !== undefined) {
          const offset =
            position +
            anchor.newIndex -
            anchor.oldIndex -
            (candles.length - previous.length);
          restoreViewport = () => scale.scrollToPosition(offset, false);
        }
      }
      updateConfirmed(candles);
      const points = previewPoints(candles);
      if (
        points.length !== previousPreview.length ||
        points.some((point, i) => !samePoint(point, previousPreview[i]))
      ) {
        preview.setData(points);
        previousPreview = points;
      }
      restoreViewport?.();
      previous = candles;
    },
    setTheme() {
      const style = getComputedStyle(container);
      const token = (name: string) => style.getPropertyValue(name).trim();
      const border = token("--border");
      const foreground = token("--muted-foreground");
      const card = token("--card");
      chart.applyOptions({
        layout: {
          background: { type: ColorType.Solid, color: card },
          textColor: foreground,
        },
        grid: {
          vertLines: { color: token("--muted") },
          horzLines: { color: token("--muted") },
        },
        rightPriceScale: { borderColor: border },
        timeScale: { borderColor: border },
        crosshair: {
          vertLine: {
            color: foreground,
            labelBackgroundColor: token("--foreground"),
          },
          horzLine: {
            color: foreground,
            labelBackgroundColor: token("--foreground"),
          },
        },
      });
      const up = token("--primary");
      const down = token("--destructive");
      bars.applyOptions({
        upColor: up,
        downColor: down,
        borderVisible: false,
        wickUpColor: up,
        wickDownColor: down,
      });
      emaColor = token("--market-ema");
      for (const series of [...confirmed, preview])
        series.applyOptions({ color: emaColor });
    },
    goToLatest: () => scale.scrollToRealTime(),
    dispose() {
      chart.unsubscribeCrosshairMove(hover);
      chart.remove();
    },
  };
}
