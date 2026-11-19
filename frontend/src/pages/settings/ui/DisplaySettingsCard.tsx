import { useEffect } from 'react';
import { displaySettingsApi, hasStatus } from '@/shared/api';
import { defaultTimeZone } from '@/shared/lib/display-time';
import {
  Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Label, NativeSelect, NativeSelectOption,
} from '@/shared/ui';

const moscow = 'Europe/Moscow';
const timeZones = [...new Set([defaultTimeZone, moscow, ...(Intl.supportedValuesOf?.('timeZone') ?? [])])];

export function DisplaySettingsCard({ refreshSession }: { refreshSession: () => void }) {
  const settings = displaySettingsApi.useDisplaySettingsQuery();
  const [save, { isLoading, isError, isSuccess, error, originalArgs }] = displaySettingsApi.useSetTimeZoneMutation();
  const saved = settings.data?.timeZone;

  useEffect(() => {
    if (hasStatus(settings.error, 401) || hasStatus(error, 401)) refreshSession();
  }, [settings.error, error, refreshSession]);

  return (
    <Card role="region" aria-labelledby="display-settings-title">
      <CardHeader>
        <CardTitle><h2 id="display-settings-title">Отображение</h2></CardTitle>
        <CardDescription>Один часовой пояс для графиков, журнала, отчётов и выбора дат бэктеста.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2">
        <Label htmlFor="display-time-zone">Часовой пояс</Label>
        <NativeSelect id="display-time-zone" className="w-full max-w-xs"
          value={(isLoading ? originalArgs : saved) ?? ''} disabled={!saved || isLoading}
          onChange={event => void save(event.target.value)}>
          {!saved && <NativeSelectOption value="">Не загружен</NativeSelectOption>}
          {saved && !timeZones.includes(saved) && <NativeSelectOption value={saved}>{saved}</NativeSelectOption>}
          {timeZones.map(zone => (
            <NativeSelectOption key={zone} value={zone}>{zone === moscow ? 'Москва (Europe/Moscow)' : zone}</NativeSelectOption>
          ))}
        </NativeSelect>
        {settings.isError && <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="text-sm">Не удалось загрузить часовой пояс.</p>
          <Button size="sm" variant="outline" onClick={() => void settings.refetch()}>Повторить загрузку</Button>
        </div>}
        {isError && <p role="alert" className="text-sm">Не удалось сохранить часовой пояс.</p>}
        {(isLoading || isSuccess) && <p role="status" className="text-sm text-muted-foreground">
          {isLoading ? 'Сохраняем…' : 'Часовой пояс сохранён.'}
        </p>}
      </CardContent>
    </Card>
  );
}
