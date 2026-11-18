import { useEffect } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { hasStatus } from '@/shared/api';
import { Alert, AlertTitle, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/ui';
import { strategyApi } from '@/entities/strategy';
import { StrategyForm, type StrategyAccountProps } from './StrategyForm';

export function StrategySettings({ settingsHint, ...props }: StrategyAccountProps & { settingsHint?: string }) {
  const config = strategyApi.useStrategyQuery();
  useEffect(() => {
    if (hasStatus(config.error, 401)) props.refreshSession();
  }, [config.error, props.refreshSession]);

  return (
    <Card role="region" aria-labelledby="strategy-title" className="min-w-0 [--card-spacing:--spacing(5)]">
      <CardHeader>
        <CardTitle><h2 id="strategy-title" className="flex items-center gap-2 font-semibold">
          <SlidersHorizontal aria-hidden="true" className="size-4 text-primary" /> Настройки стратегии
        </h2></CardTitle>
        <CardDescription>Выберите фьючерс, таймфрейм, период EMA и размер позиции в лотах.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {settingsHint && <p className="text-sm text-muted-foreground">{settingsHint}</p>}
        {config.isLoading && <p role="status" className="text-sm text-muted-foreground">Загружаем настройки…</p>}
        {config.isError && <>
          <Alert variant="destructive"><AlertTitle>Не удалось загрузить настройки стратегии.</AlertTitle></Alert>
          <Button variant="outline" className="justify-self-start" onClick={() => void config.refetch()}>Повторить</Button>
        </>}
        {config.data && !config.isError && <StrategyForm config={config.data} {...props} />}
      </CardContent>
    </Card>
  );
}
