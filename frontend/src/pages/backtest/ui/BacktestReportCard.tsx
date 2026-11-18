import { Suspense, lazy } from 'react';
import { timeframeLabels } from '@/entities/strategy';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/ui';
import type { BacktestReport } from '../api/backtest-api';

const HistoryChart = lazy(() => import('./HistoryChart'));

const moscowTime = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' });
const moneyFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const priceFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 4 });

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-muted/30 px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

export function BacktestReportCard({ report, dark }: { report: BacktestReport; dark: boolean }) {
  const { parameters, currency, result, executions, finalSignal, pointValue, priceStep, priceStepAmount, lot } = report;
  const currencyCode = currency.toUpperCase();
  const money = (value: number) => `${moneyFormat.format(value)} ${currencyCode}`;
  return (
    <Card>
      <CardHeader>
        <CardTitle><h2>Отчёт по стратегии</h2></CardTitle>
        <CardDescription>
          {parameters.from} — {parameters.to} · {timeframeLabels[parameters.timeframe]} · EMA {parameters.emaPeriod}
          {' · '}{parameters.lots} лот.
          {report.cutoff !== null && <> Последний день ещё не закончился: прогон до {moscowTime.format(report.cutoff)} МСК.</>}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          <Stat label="Результат" value={money(result.total)} />
          <Stat label="Закрытые сделки" value={money(result.closed)} />
          <Stat label="Открытая позиция" value={money(result.open)} />
          <Stat label="Остаток позиции" value={`${result.position} лот.`} />
          <Stat label="Исполнений" value={String(executions.length)} />
        </dl>
        <p className="text-sm text-muted-foreground">
          EMA — брокерская (по закрытиям свечей). Сигнал определяется по завершённой свече, исполнение
          {' '}моделируется по цене открытия следующей свечи внутри периода.
        </p>
        <p className="text-sm text-muted-foreground">
          Комиссия и проскальзывание не учитываются. Деньги пересчитаны из пунктов цены: шаг {priceFormat.format(priceStep)}{' '}
          стоит {moneyFormat.format(priceStepAmount)} {currencyCode}, поэтому коэффициент{' '}
          {moneyFormat.format(pointValue)} {currencyCode} за пункт на лот (лот — {lot} контракт).
          {' '}Используются параметры контракта на момент прогона.
        </p>
        {finalSignal && (
          <p className="text-sm text-muted-foreground">
            Последний сигнал без следующей свечи — {finalSignal.direction === 'buy' ? 'покупка' : 'продажа'}{' '}
            на {moscowTime.format(finalSignal.candleTime)} МСК — не исполнен и не меняет позицию.
          </p>
        )}
        <Suspense fallback={<p role="status">Загружаем график…</p>}>
          <HistoryChart candles={report.candles} executions={executions} dark={dark} />
        </Suspense>
        {executions.length === 0 ? (
          <p className="text-sm text-muted-foreground">Пересечений за период не было — исполнений нет.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-1 pr-4 font-normal">Время (МСК)</th>
                <th className="py-1 pr-4 font-normal">Направление</th>
                <th className="py-1 pr-4 text-right font-normal">Лоты</th>
                <th className="py-1 text-right font-normal">Цена</th>
              </tr>
            </thead>
            <tbody>
              {executions.map((execution, index) => (
                <tr key={index} className="border-t">
                  <td className="py-1 pr-4">{moscowTime.format(execution.time)}</td>
                  <td className="py-1 pr-4">{execution.direction === 'buy' ? 'Покупка' : 'Продажа'}</td>
                  <td className="py-1 pr-4 text-right">{execution.lots}</td>
                  <td className="py-1 text-right">{priceFormat.format(execution.price)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}
