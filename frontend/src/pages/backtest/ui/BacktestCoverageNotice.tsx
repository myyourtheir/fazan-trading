import { displayTimeFormatter } from '@/shared/lib/display-time';
import { Alert, AlertDescription, AlertTitle } from '@/shared/ui';
import type { BacktestCoverage } from '../api/backtest-api';
import { calendarDay } from '../lib/calendar-day';

export function BacktestCoverageNotice({
  coverage,
  timeZone,
}: {
  coverage: BacktestCoverage;
  timeZone: string;
}) {
  const { requested, actual, uncoveredStart, uncoveredEnd, excludedIntervals, readyAt } = coverage;
  const partial = uncoveredStart || uncoveredEnd || Boolean(excludedIntervals?.length);
  if (!partial && readyAt === undefined) return null;
  const format = displayTimeFormatter(timeZone);
  return (
    <Alert>
      <AlertTitle>{partial ? 'Частичная история' : 'Прогрев индикаторов'}</AlertTitle>
      <AlertDescription>
        {(uncoveredStart || uncoveredEnd) && (
          <p>
            На границе диапазона нет свечей (
            {uncoveredStart && uncoveredEnd
              ? 'в начале и в конце'
              : uncoveredStart
                ? 'в начале'
                : 'в конце'}
            ).
          </p>
        )}
        <p>
          Запрошенный диапазон: {calendarDay(requested.from)} — {calendarDay(requested.to)}.
        </p>
        <p>
          Фактический диапазон: {format(actual.from)} — {format(actual.to)}.
        </p>
        {!!excludedIntervals?.length && (
          <details>
            <summary className="cursor-pointer">
              Исключено интервалов из-за расхождения свечей стратегии и минутных свечей:{' '}
              {excludedIntervals.length}
            </summary>
            <ul
              aria-label="Время открытия исключённых интервалов"
              className="my-1 max-h-40 overflow-auto"
            >
              {excludedIntervals.map((time) => (
                <li key={time}>{format(time)}</li>
              ))}
            </ul>
          </details>
        )}
        {readyAt !== undefined && (
          <p>
            Индикаторы прогреты внутри диапазона. Стратегия готова к торговле с {format(readyAt)}.
          </p>
        )}
      </AlertDescription>
    </Alert>
  );
}
