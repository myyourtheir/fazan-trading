import { ru } from 'date-fns/locale';
import { useState } from 'react';
import { Button, Calendar, Popover, PopoverContent, PopoverTrigger } from '@/shared/ui';
import { calendarDay } from '../lib/calendar-day';

// The grid uses UTC as a neutral representation of date-only labels, not as the backtest range.
// Only "today" needs an instant-to-date conversion here; the server resolves the actual boundaries.
const parseDay = (day: string) => new Date(`${day}T00:00:00Z`);
const toDay = (date: Date) =>
  `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

export function DateRangePicker({
  id,
  from,
  to,
  describedBy,
  timeZone,
  onChange,
}: {
  id: string;
  from: string;
  to: string;
  describedBy: string;
  timeZone: string | undefined;
  onChange: (from: string, to: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState<Date>();
  const today = timeZone
    ? parseDay(
        new Intl.DateTimeFormat('sv-SE', {
          timeZone,
          dateStyle: 'short',
        }).format(Date.now()),
      )
    : undefined;
  // react-day-picker completes a single-day range on the first click, so a period is shown once
  // both wire days are set.
  const caption = !from
    ? 'Выберите период'
    : from === to
      ? calendarDay(from)
      : `${calendarDay(from)} — ${calendarDay(to)}`;
  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          const selectedDay = to || from;
          setMonth(selectedDay ? parseDay(selectedDay) : undefined);
        }
        setOpen(nextOpen);
      }}
    >
      <PopoverTrigger
        render={
          <Button
            id={id}
            variant="outline"
            aria-describedby={describedBy}
            disabled={!today}
            className="w-full justify-between font-normal"
          />
        }
      >
        {caption}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto">
        <Calendar
          locale={ru}
          timeZone="UTC"
          today={today}
          disabled={today ? { after: today } : undefined}
          mode="range"
          month={month ?? today}
          onMonthChange={setMonth}
          selected={{
            from: from ? parseDay(from) : undefined,
            to: to ? parseDay(to) : undefined,
          }}
          onSelect={(range) => {
            // A click before the current start restarts the range; the wire pair is always ordered.
            const [start, end] =
              range?.from && range.to && range.from > range.to
                ? [range.to, range.from]
                : [range?.from, range?.to];
            onChange(start ? toDay(start) : '', end ? toDay(end) : '');
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
