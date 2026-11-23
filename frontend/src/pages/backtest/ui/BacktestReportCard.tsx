import { Suspense, lazy, useMemo } from 'react';
import { timeframeLabels } from '@/entities/strategy';
import { useDisplayTimeZone } from '@/shared/api';
import { displayTimeFormatter } from '@/shared/lib/display-time';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/ui';
import type { BacktestReport } from '../api/backtest-api';
import { calendarDay } from '../lib/calendar-day';

const HistoryChart = lazy(() => import('./HistoryChart'));

const moneyFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const preciseFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 4 });
const percentFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-muted/30 px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

export function BacktestReportCard({
  report,
  stale,
  dark,
}: {
  report: BacktestReport;
  stale: boolean;
  dark: boolean;
}) {
  const {
    parameters,
    currency,
    result,
    executions,
    finalSignal,
    pointValue,
    priceStep,
    priceStepAmount,
    lot,
  } = report;
  const timeZone = useDisplayTimeZone();
  const formatTime = useMemo(() => displayTimeFormatter(timeZone), [timeZone]);
  const currencyCode = currency.toUpperCase();
  const money = (value: number) => `${moneyFormat.format(value)} ${currencyCode}`;
  const noCosts = parameters.commission === 0 && parameters.slippage === 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <h2>Отчёт по стратегии</h2>
          {stale && <Badge variant="secondary">Параметры изменены</Badge>}
        </CardTitle>
        <CardDescription>
          {calendarDay(parameters.from)} — {calendarDay(parameters.to)} ({parameters.timeZone}) ·{' '}
          {timeframeLabels[parameters.timeframe]} · EMA {parameters.emaPeriod}
          {' · '}
          {parameters.lots} лот.
          {report.cutoff !== null && (
            <> Последний день ещё не закончился: прогон до {formatTime(report.cutoff)}.</>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Результат" value={money(result.total)} />
          <Stat label="Закрытые сделки" value={money(result.closed)} />
          <Stat label="Открытая позиция" value={money(result.open)} />
          <Stat label="Остаток позиции" value={`${result.position} лот.`} />
          <Stat label="Макс. просадка" value={money(result.maxDrawdown)} />
          <Stat label="Исполнений" value={String(executions.length)} />
        </dl>
        <p className="text-sm text-muted-foreground">
          EMA рассчитана по закрытиям свечей с прогревом до начала диапазона. Сигнал определяется по
          завершённой свече, исполнение моделируется по цене открытия следующей свечи внутри
          периода.
        </p>
        <p className="text-sm text-muted-foreground">
          {noCosts
            ? 'Комиссия и проскальзывание не учитываются.'
            : `Комиссия ${preciseFormat.format(parameters.commission)}%, проскальзывание ${percentFormat.format(parameters.slippage)}%` +
              ' от цены исполнения против владельца.'}{' '}
          Деньги пересчитаны из пунктов цены: шаг {preciseFormat.format(priceStep)} стоит{' '}
          {moneyFormat.format(priceStepAmount)} {currencyCode}, поэтому коэффициент{' '}
          {moneyFormat.format(pointValue)} {currencyCode} за пункт на лот (лот — {lot} контракт).{' '}
          Используются параметры контракта на момент прогона.
        </p>
        {finalSignal && (
          <p className="text-sm text-muted-foreground">
            Последний сигнал без следующей свечи —{' '}
            {finalSignal.direction === 'buy' ? 'покупка' : 'продажа'} на{' '}
            {formatTime(finalSignal.candleTime)} — не исполнен и не меняет позицию.
          </p>
        )}
        <Suspense fallback={<p role="status">Загружаем график…</p>}>
          <HistoryChart
            candles={report.candles}
            executions={executions}
            dark={dark}
            timeZone={timeZone}
          />
        </Suspense>
        {executions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Пересечений за период не было — исполнений нет.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-1 pr-4 font-normal">Время ({timeZone})</th>
                <th className="py-1 pr-4 font-normal">Направление</th>
                <th className="py-1 pr-4 text-right font-normal">Лоты</th>
                <th className="py-1 pr-4 text-right font-normal">Цена</th>
                <th className="py-1 text-right font-normal">Комиссия</th>
              </tr>
            </thead>
            <tbody>
              {executions.map((execution, index) => (
                <tr key={index} className="border-t">
                  <td className="py-1 pr-4">{formatTime(execution.time)}</td>
                  <td className="py-1 pr-4">
                    {execution.direction === 'buy' ? 'Покупка' : 'Продажа'}
                  </td>
                  <td className="py-1 pr-4 text-right">{execution.lots}</td>
                  <td className="py-1 pr-4 text-right">{preciseFormat.format(execution.price)}</td>
                  <td className="py-1 text-right">{preciseFormat.format(execution.commission)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}
