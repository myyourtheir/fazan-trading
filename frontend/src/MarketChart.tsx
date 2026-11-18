import { skipToken } from '@reduxjs/toolkit/query/react';
import { ChartCandlestick } from 'lucide-react';
import { lazy, Suspense, useEffect } from 'react';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api, hasStatus } from './api';
import type { StreamState } from './market-data';

const TradingChart = lazy(() => import('./TradingChart'));

const streamLabels: Record<StreamState, string> = {
  unconfigured: 'Поток не настроен',
  connecting: 'Подключаем поток…',
  live: 'Поток подключён',
  disconnected: 'Поток прерван',
};

export function MarketChart({ refreshSession }: { refreshSession: () => void }) {
  const config = api.useStrategyQuery();
  const settings = !config.isError && config.data?.settings;
  const market = api.useMarketQuery(settings
    ? { instrumentUid: settings.instrument.uid, emaPeriod: settings.emaPeriod }
    : skipToken);
  useEffect(() => {
    if (hasStatus(market.error, 401)) refreshSession();
  }, [market.error, refreshSession]);
  const data = market.currentData;
  const latest = data?.candles.at(-1);

  return (
    <Card role="region" aria-labelledby="market-title" className="min-w-0">
      <CardHeader>
        <CardTitle><h2 id="market-title" className="flex items-center gap-2">
          <ChartCandlestick aria-hidden="true" className="size-4 text-primary" /> Часовые свечи и EMA
        </h2></CardTitle>
        <CardDescription>{settings ? `${settings.instrument.ticker} · 1 час · EMA ${settings.emaPeriod}`
          : 'Сохраните настройки стратегии, чтобы увидеть график.'}</CardDescription>
      </CardHeader>
      {settings && <CardContent className="grid gap-4">
        {market.isLoading && <p role="status" className="text-sm text-muted-foreground">Загружаем историю…</p>}
        {(market.isError || (data && !data.historyAvailable)) && <>
          <Alert variant="destructive"><AlertTitle>Не удалось загрузить историю свечей.</AlertTitle></Alert>
          <Button variant="outline" className="justify-self-start" disabled={market.isFetching}
            onClick={() => void market.refetch()}>Повторить</Button>
        </>}
        {data && <Badge role="status" variant="outline">{streamLabels[data.stream]}</Badge>}
        {data?.historyAvailable && !latest &&
          <p className="text-sm text-muted-foreground">Нет часовых свечей за последние семь дней.</p>}
        {data && latest && <Suspense fallback={<p className="text-sm text-muted-foreground">Загружаем график…</p>}>
          <TradingChart key={JSON.stringify([data.instrumentUid, data.emaPeriod])} candles={data.candles} />
        </Suspense>}
      </CardContent>}
    </Card>
  );
}
