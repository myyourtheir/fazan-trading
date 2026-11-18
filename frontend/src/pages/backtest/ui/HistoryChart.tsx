import {
  CandlestickSeries, LineSeries, TickMarkType, createChart, createSeriesMarkers,
  type ISeriesApi, type ISeriesMarkersPluginApi, type Time,
} from 'lightweight-charts';
import { useEffect, useRef } from 'react';
import { axisPriceFormatter, candlePoint, candlePricePrecision, chartTime, priceChartTheme } from '@/shared/lib/price-chart';
import type { BacktestExecution, HistoricalCandle } from '../api/backtest-api';

const zone = 'Europe/Moscow';
const day = new Intl.DateTimeFormat('ru-RU', { timeZone: zone, day: 'numeric', month: 'short' });
const clock = new Intl.DateTimeFormat('ru-RU', { timeZone: zone, hour: '2-digit', minute: '2-digit' });
const full = new Intl.DateTimeFormat('ru-RU', { timeZone: zone, dateStyle: 'short', timeStyle: 'short' });

export default function HistoryChart({ candles, executions, dark }: {
  candles: HistoricalCandle[]; executions: BacktestExecution[]; dark: boolean;
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
      timeScale: {
        timeVisible: true, secondsVisible: false,
        tickMarkFormatter: (time: Time, type: TickMarkType) => typeof time === 'number'
          ? (type <= TickMarkType.DayOfMonth ? day : clock).format(time * 1000) : null,
      },
      localization: {
        locale: 'ru-RU',
        timeFormatter: (time: Time) => typeof time === 'number' ? `${full.format(time * 1000)} МСК` : '',
      },
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
    const precision = candlePricePrecision(candles);
    const seriesPrecision = Math.max(2, precision);
    barsRef.current?.applyOptions({ priceFormat: { type: 'price', precision: seriesPrecision, minMove: 10 ** -seriesPrecision } });
    chartRef.current?.applyOptions({ localization: { priceFormatter: axisPriceFormatter(precision) } });
    barsRef.current?.setData(candles.map(candlePoint));
    emaRef.current?.setData(candles.map(({ time, ema }) => ({ time: chartTime(time), value: ema })));
    chartRef.current?.timeScale().fitContent();
  }, [candles]);
  useEffect(() => {
    markersRef.current?.setMarkers(executions.map(({ time, direction }) => ({
      time: chartTime(time),
      position: direction === 'buy' ? 'belowBar' as const : 'aboveBar' as const,
      shape: direction === 'buy' ? 'arrowUp' as const : 'arrowDown' as const,
      color: direction === 'buy' ? '#22c55e' : '#ef4444',
    })));
  }, [executions]);
  useEffect(() => {
    if (!container.current) return;
    const theme = priceChartTheme(container.current);
    chartRef.current?.applyOptions(theme.chart);
    barsRef.current?.applyOptions(theme.candles);
    emaRef.current?.applyOptions({ color: theme.emaColor });
  }, [dark]);

  return <div ref={container} className="h-96 w-full" role="img" aria-label="График исторических свечей и EMA" />;
}
