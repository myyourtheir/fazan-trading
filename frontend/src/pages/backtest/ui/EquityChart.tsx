import { LineSeries, createChart } from 'lightweight-charts';
import { useEffect, useRef } from 'react';
import { chartTime, chartTimeOptions, priceChartTheme } from '@/shared/lib/price-chart';
import type { EquityPoint } from '../api/backtest-api';

export default function EquityChart({
  points,
  dark,
  timeZone,
}: {
  points: EquityPoint[];
  dark: boolean;
  timeZone: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!container.current) return;
    const theme = priceChartTheme(container.current);
    const chart = createChart(container.current, {
      ...theme.chart,
      ...chartTimeOptions(timeZone),
      autoSize: true,
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        ...chartTimeOptions(timeZone).timeScale,
      },
      layout: { ...theme.chart.layout, attributionLogo: false },
    });
    const series = chart.addSeries(LineSeries, { color: theme.emaColor });
    series.setData(points.map(({ time, value }) => ({ time: chartTime(time), value })));
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [points, dark, timeZone]);
  return (
    <figure className="min-w-0">
      <figcaption className="font-medium">Стоимость счёта, ₽</figcaption>
      <div ref={container} className="h-64 w-full" role="img" aria-label="График стоимости счёта" />
    </figure>
  );
}
