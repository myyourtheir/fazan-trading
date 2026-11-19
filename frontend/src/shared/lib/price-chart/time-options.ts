import { TickMarkType, type ChartOptions, type DeepPartial, type Time } from 'lightweight-charts';
import { displayTimeFormatter } from '@/shared/lib/display-time';

export function chartTimeOptions(timeZone: string): DeepPartial<ChartOptions> {
  const tick = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('ru-RU', { timeZone, ...options });
  const year = tick({ year: 'numeric' });
  const day = tick({ day: 'numeric', month: 'short' });
  const clock = tick({ hour: '2-digit', minute: '2-digit' });
  const full = displayTimeFormatter(timeZone);
  return {
    timeScale: {
      tickMarkFormatter: (time: Time, type: TickMarkType) => typeof time === 'number'
        ? (type === TickMarkType.Year ? year : type <= TickMarkType.DayOfMonth ? day : clock).format(time * 1000)
        : null,
    },
    localization: {
      timeFormatter: (time: Time) => typeof time === 'number' ? full(time * 1000) : '',
    },
  };
}
