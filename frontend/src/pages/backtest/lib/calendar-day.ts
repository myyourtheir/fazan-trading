const day = new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric' });

// Calendar dates travel as UTC-midnight timestamps, so the day is formatted in UTC: the value
// names the exact calendar day regardless of the browser timezone.
export const calendarDay = (value: string) =>
  day.format(Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value));
