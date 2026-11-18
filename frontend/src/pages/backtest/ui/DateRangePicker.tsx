import { ru } from 'date-fns/locale';
import { useState } from 'react';
import { Button, Calendar, Popover, PopoverContent, PopoverTrigger } from '@/shared/ui';

// Wire days are pure Moscow calendar dates ("YYYY-MM-DD"); the picker holds local-midnight dates,
// so the grid marks the same day in any browser timezone.
const parseDay = (day: string) =>
  new Date(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
const toDay = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const dayLabel = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });

export function DateRangePicker({ id, from, to, describedBy, onChange }: {
  id: string; from: string; to: string; describedBy: string;
  onChange: (from: string, to: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => new Date());
  // react-day-picker completes a single-day range on the first click, so a period is shown once
  // both wire days are set.
  const caption = !from ? 'Выберите период'
    : from === to ? dayLabel.format(parseDay(from))
      : `${dayLabel.format(parseDay(from))} — ${dayLabel.format(parseDay(to))}`;
  return (
    <Popover open={open} onOpenChange={nextOpen => {
      if (nextOpen) {
        const selectedDay = to || from;
        setMonth(selectedDay ? parseDay(selectedDay) : new Date());
      }
      setOpen(nextOpen);
    }}>
      <PopoverTrigger render={
        <Button id={id} variant="outline" aria-describedby={describedBy}
          className="w-full justify-between font-normal" />
      }>
        {caption}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto">
        <Calendar
          locale={ru}
          mode="range"
          month={month}
          onMonthChange={setMonth}
          selected={{ from: from ? parseDay(from) : undefined, to: to ? parseDay(to) : undefined }}
          onSelect={range => {
            // A click before the current start restarts the range; the wire pair is always ordered.
            const [start, end] = range?.from && range.to && range.from > range.to
              ? [range.to, range.from]
              : [range?.from, range?.to];
            onChange(start ? toDay(start) : '', end ? toDay(end) : '');
            // The first click completes a single-day range; close once the pair spans more than one day.
            if (range?.from && range.to && range.from < range.to) setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
