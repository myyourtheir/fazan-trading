import { useMemo } from 'react';
import type { BacktestReport } from '../api/backtest-api';
import { linkBacktestCharts } from '../lib/link-backtest-charts';
import EquityChart from './EquityChart';
import HistoryChart from './HistoryChart';

export default function BacktestCharts({
  report,
  dark,
  timeZone,
}: {
  report: BacktestReport;
  dark: boolean;
  timeZone: string;
}) {
  const link = useMemo(
    () =>
      report.parameters.kind === 'improved-surfing'
        ? linkBacktestCharts(report.equity, report.candles)
        : undefined,
    [report],
  );

  return (
    <>
      <EquityChart points={report.equity} dark={dark} timeZone={timeZone} link={link} />
      <HistoryChart
        candles={report.candles}
        executions={report.executions}
        dark={dark}
        timeZone={timeZone}
        timeframe={report.parameters.timeframe}
        link={link}
      />
    </>
  );
}
