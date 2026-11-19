const day = new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric' });

// Format date-only labels verbatim, not as instants in the browser's timezone.
export const calendarDay = (value: string) =>
  day.format(Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value));
