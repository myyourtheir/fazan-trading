export const defaultTimeZone = 'UTC';

export function displayTimeFormatter(timeZone: string, seconds = false) {
  const date = new Intl.DateTimeFormat('ru-RU', {
    timeZone, dateStyle: 'short', timeStyle: seconds ? 'medium' : 'short',
  });
  const offset = timeZone === 'UTC' ? undefined : new Intl.DateTimeFormat('ru-RU', {
    timeZone, timeZoneName: 'shortOffset',
  });
  return (time: number) => {
    const suffix = offset?.formatToParts(time).find(part => part.type === 'timeZoneName')?.value ?? 'UTC';
    return `${date.format(time)} ${suffix}`;
  };
}
