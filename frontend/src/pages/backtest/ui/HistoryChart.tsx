import {
  CandlestickSeries,
  LineSeries,
  createChart,
  createSeriesMarkers,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type Time,
} from 'lightweight-charts';
import { useEffect, useRef } from 'react';
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
}: {
  candles: HistoricalCandle[];
  executions: BacktestExecution[];
  dark: boolean;
  timeZone: string;
  timeframe: Timeframe;
}) {
  const container = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ReturnType<typeof createChart> | null>(null);
  const barsRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const emaRef = useRef<ISeriesApi<'Line'> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  useEffect(() => {
    if (!container.current) return;
    const chart = createChart(container.current, {
      autoSize: true,
      layout: { attributionLogo: false },
      timeScale: { timeVisible: true, secondsVisible: false },
      localization: { locale: 'ru-RU' },
    });
    chartRef.current = chart;
    barsRef.current = chart.addSeries(CandlestickSeries, { borderVisible: false });
    emaRef.current = chart.addSeries(LineSeries, { priceLineVisible: false });
    markersRef.current = createSeriesMarkers(barsRef.current, []);
    return () => {
      chartRef.current = barsRef.current = emaRef.current = markersRef.current = null;
      chart.remove();
    };
  }, []);
  useEffect(() => {
    chartRef.current?.applyOptions(chartTimeOptions(timeZone));
  }, [timeZone]);
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
      candles.map(({ time, ema }) => ({ time: chartTime(time), value: ema })),
    );
    chartRef.current?.timeScale().fitContent();
  }, [candles]);
  useEffect(() => {
    markersRef.current?.setMarkers(
      executions.map(({ time, direction }) => ({
        time: chartTime(Math.floor(time / intervalMs[timeframe]) * intervalMs[timeframe]),
        position: direction === 'buy' ? ('belowBar' as const) : ('aboveBar' as const),
        shape: direction === 'buy' ? ('arrowUp' as const) : ('arrowDown' as const),
        color: direction === 'buy' ? '#22c55e' : '#ef4444',
      })),
    );
  }, [executions, timeframe]);
  useEffect(() => {
    if (!container.current) return;
    const theme = priceChartTheme(container.current);
    chartRef.current?.applyOptions(theme.chart);
    barsRef.current?.applyOptions(theme.candles);
    emaRef.current?.applyOptions({ color: theme.emaColor });
  }, [dark]);

  return (
    <figure className="min-w-0">
      <div
        ref={container}
        className="h-96 w-full"
        role="img"
        aria-label="График исторических свечей и EMA"
      />
      <figcaption className="text-xs text-muted-foreground">Время: {timeZone}</figcaption>
    </figure>
  );
}
