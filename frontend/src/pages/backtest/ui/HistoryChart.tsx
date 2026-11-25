import {
  CandlestickSeries,
  LineSeries,
  createChart,
  createSeriesMarkers,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type MouseEventParams,
  type Time,
} from 'lightweight-charts';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  axisPriceFormatter,
  candlePoint,
  candlePricePrecision,
  chartTime,
  chartTimeOptions,
  priceChartTheme,
} from '@/shared/lib/price-chart';
import type { BacktestExecution, HistoricalCandle } from '../api/backtest-api';
import type { Timeframe } from '@/entities/strategy';
import type { BacktestChartLink } from '../lib/link-backtest-charts';
import { addSpacedCandles } from '../lib/spaced-candles';
import { HistoryCandleDetails } from './HistoryCandleDetails';

const intervalMs: Record<Timeframe, number> = {
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
};

export default function HistoryChart({
  candles,
  executions,
  dark,
  timeZone,
  timeframe,
  link,
}: {
  candles: HistoricalCandle[];
  executions: BacktestExecution[];
  dark: boolean;
  timeZone: string;
  timeframe: Timeframe;
  link?: BacktestChartLink;
}) {
  const container = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ReturnType<typeof createChart> | null>(null);
  const barsRef = useRef<
    ISeriesApi<'Candlestick'> | ReturnType<typeof addSpacedCandles>['series'] | null
  >(null);
  const emaRef = useRef<ISeriesApi<'Line'> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const candleMinutes = link ? intervalMs[timeframe] / 60_000 : undefined;
  const lastCandle = candles.at(-1);
  const lastCandleDown = lastCandle !== undefined && lastCandle.close < lastCandle.open;
  const [hover, setHover] = useState<{ link: BacktestChartLink; time: number }>();
  const candlesByTime = useMemo(
    () =>
      link ? new Map<number, HistoricalCandle>(candles.map((c) => [chartTime(c.time), c])) : null,
    [candles, link],
  );
  const hovered = hover && hover.link === link ? candlesByTime?.get(hover.time) : undefined;
  useEffect(() => {
    if (!container.current) return;
    const chart = createChart(container.current, {
      autoSize: true,
      layout: { attributionLogo: false },
      timeScale: { timeVisible: true, secondsVisible: false },
      localization: { locale: 'ru-RU' },
    });
    chartRef.current = chart;
    const spaced = candleMinutes ? addSpacedCandles(chart, candleMinutes) : undefined;
    barsRef.current =
      spaced?.series ?? chart.addSeries(CandlestickSeries, { borderVisible: false });
    emaRef.current = chart.addSeries(LineSeries, { priceLineVisible: false });
    markersRef.current = createSeriesMarkers(barsRef.current, []);
    const disconnect = link?.connect(chart, barsRef.current);
    const onHover = ({ point }: MouseEventParams<Time>) => {
      const time = point && spaced?.candleAt(point.x);
      setHover((current) => {
        if (time === undefined || !link) return undefined;
        return current?.link === link && current.time === time ? current : { link, time };
      });
    };
    if (spaced) chart.subscribeCrosshairMove(onHover);
    return () => {
      if (spaced) chart.unsubscribeCrosshairMove(onHover);
      disconnect?.();
      chartRef.current = barsRef.current = emaRef.current = markersRef.current = null;
      chart.remove();
    };
  }, [link, candleMinutes]);
  useEffect(() => {
    chartRef.current?.applyOptions(chartTimeOptions(timeZone));
  }, [timeZone, link, candleMinutes]);
  useEffect(() => {
    const precision = candlePricePrecision(candles);
    const seriesPrecision = Math.max(2, precision);
    barsRef.current?.applyOptions({
      priceFormat: { type: 'price', precision: seriesPrecision, minMove: 10 ** -seriesPrecision },
    });
    chartRef.current?.applyOptions({
      localization: { priceFormatter: axisPriceFormatter(precision) },
    });
    barsRef.current?.setData(candles.map(candlePoint));
    emaRef.current?.setData(
      candles.map(({ time, ema }) =>
        ema === null ? { time: chartTime(time) } : { time: chartTime(time), value: ema },
      ),
    );
    if (!link) chartRef.current?.timeScale().fitContent();
  }, [candles, link, candleMinutes]);
  useEffect(() => {
    markersRef.current?.setMarkers(
      executions.map(({ time, direction }) => ({
        time: chartTime(Math.floor(time / intervalMs[timeframe]) * intervalMs[timeframe]),
        position: direction === 'buy' ? ('belowBar' as const) : ('aboveBar' as const),
        shape: direction === 'buy' ? ('arrowUp' as const) : ('arrowDown' as const),
        color: direction === 'buy' ? '#22c55e' : '#ef4444',
      })),
    );
  }, [executions, timeframe, link]);
  useEffect(() => {
    if (!container.current) return;
    const theme = priceChartTheme(container.current);
    chartRef.current?.applyOptions(theme.chart);
    const color = lastCandleDown ? theme.candles.downColor : theme.candles.upColor;
    barsRef.current?.applyOptions({ ...theme.candles, ...(link && { color }) });
    emaRef.current?.applyOptions({ color: theme.emaColor });
  }, [dark, link, candleMinutes, lastCandleDown]);

  return (
    <figure className="min-w-0">
      <div
        ref={container}
        className="h-96 w-full"
        role="img"
        aria-label="График исторических свечей и EMA"
      />
      {link && <HistoryCandleDetails candle={hovered} timeZone={timeZone} />}
      <figcaption className="text-xs text-muted-foreground">Время: {timeZone}</figcaption>
    </figure>
  );
}
