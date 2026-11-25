import { Suspense, lazy, useMemo } from 'react';
import { timeframeLabels } from '@/entities/strategy';
import { useDisplayTimeZone } from '@/shared/api';
import { displayTimeFormatter } from '@/shared/lib/display-time';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/ui';
import type { BacktestReport } from '../api/backtest-api';
import { calendarDay } from '../lib/calendar-day';
import { BacktestCoverageNotice } from './BacktestCoverageNotice';

const HistoryChart = lazy(() => import('./HistoryChart'));
const EquityChart = lazy(() => import('./EquityChart'));
const reasons = {
  entry: 'Вход',
  'add-on': 'Добор',
  'reversal-exit': 'Выход при развороте',
  'reversal-entry': 'Вход при развороте',
  gap: 'Гэп',
  stop: 'Стоп',
} as const;

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
  const { parameters, currency, result, executions, pointValue, priceStep, priceStepAmount, lot } =
    report;
  const timeZone = useDisplayTimeZone();
  const formatTime = useMemo(() => displayTimeFormatter(timeZone), [timeZone]);
  const currencyCode = currency.toUpperCase();
  const money = (value: number) => `${moneyFormat.format(value)} ${currencyCode}`;
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
          {parameters.kind === 'surfing'
            ? `Surfing · ${parameters.lots} лот.`
            : `Улучшенный серфинг · ATR ${parameters.atrPeriod}`}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <BacktestCoverageNotice coverage={report.coverage} timeZone={parameters.timeZone} />
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <Stat
            label="Доходность после комиссии"
            value={`${money(result.total)} (${percentFormat.format(result.returnPercent)}%)`}
          />
          <Stat label="Реализованный результат" value={money(result.closed)} />
          <Stat label="Нереализованный результат" value={money(result.open)} />
          <Stat label="Остаток позиции" value={`${result.position} лот.`} />
          <Stat label="Макс. просадка" value={money(result.maxDrawdown)} />
          <Stat label="Суммарная комиссия" value={money(result.commission)} />
        </dl>
        <p className="text-sm text-muted-foreground">
          Модель: EMA рассчитана по закрытиям свечей. Сигнал исполняется на первом доступном
          минутном открытии той же сессии, разворот — двумя исполнениями. Гэп исполняется по
          открытию; стоп — по уровню при касании или по открытию минуты при перескоке. Позиция в
          конце отмечается по последнему минутному закрытию без принудительного выхода.
        </p>
        <p className="text-sm text-muted-foreground">
          Минутные свечи не показывают порядок тиков; время внутриминутного стопа указывается с
          точностью до минуты. Модель не учитывает стакан, задержки, частичные исполнения, сбои и
          окно без защиты при замене стопа. Просадка оценивается на открытиях, закрытиях минут и в
          точках исполнений. Сессии определяются по свечам выбранного таймфрейма, а не по календарю
          биржи. Внутри найденных интервалов минут без свечей: {report.model.missingMinutes}. Они не
          считаются перерывами: порядок сделок и стопы в эти минуты неизвестны.
        </p>
        <p className="text-sm text-muted-foreground">
          Модельное ГО на лот равно числу пунктов цены в рублях, одинаково для покупки и продажи.
          Для сделки используется открытие минуты до проскальзывания. На конец периода:{' '}
          {money(report.model.marginPerLotAtClose)}. Это не фактическое ГО брокера.
        </p>
        <p className="text-sm text-muted-foreground">
          Стартовый капитал: {money(parameters.initialMoney)}. Комиссия{' '}
          {preciseFormat.format(parameters.commission)}% номинала, проскальзывание{' '}
          {parameters.slippage} шаг. против владельца на каждое исполнение. Деньги пересчитаны из
          пунктов цены: шаг {preciseFormat.format(priceStep)} стоит{' '}
          {moneyFormat.format(priceStepAmount)} {currencyCode}, поэтому коэффициент{' '}
          {moneyFormat.format(pointValue)} {currencyCode} за пункт на лот (лот — {lot} контракт).{' '}
          Используются параметры контракта на момент прогона.
        </p>
        <Suspense fallback={<p role="status">Загружаем график…</p>}>
          <EquityChart points={report.equity} dark={dark} timeZone={timeZone} />
          <HistoryChart
            candles={report.candles}
            executions={executions}
            dark={dark}
            timeZone={timeZone}
            timeframe={parameters.timeframe}
          />
        </Suspense>
        {executions.length === 0 ? (
          <p className="text-sm text-muted-foreground">Исполнений за период нет.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="text-left font-medium">Журнал исполнений</caption>
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1 pr-4 font-normal">Время ({timeZone})</th>
                  <th className="py-1 pr-4 font-normal">Причина</th>
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
                    <td className="py-1 pr-4">{reasons[execution.reason]}</td>
                    <td className="py-1 pr-4">
                      {execution.direction === 'buy' ? 'Покупка' : 'Продажа'}
                    </td>
                    <td className="py-1 pr-4 text-right">{execution.lots}</td>
                    <td className="py-1 pr-4 text-right">
                      {preciseFormat.format(execution.price)}
                    </td>
                    <td className="py-1 text-right">
                      {preciseFormat.format(execution.commission)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
