import { skipToken } from '@reduxjs/toolkit/query/react';
import { ChartCandlestick } from 'lucide-react';
import { lazy, Suspense, useEffect } from 'react';
import { hasStatus } from '@/shared/api';
import {
  Alert,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/shared/ui';
import { marketApi } from '../api/market-api';
import { strategyApi, timeframeLabels } from '@/entities/strategy';
import type { StreamState } from '../model/market-data';

const TradingChart = lazy(() => import('./TradingChart'));

const streamLabels: Record<StreamState, string> = {
  unconfigured: 'Поток не настроен',
  connecting: 'Подключаем поток…',
  live: 'Поток подключён',
  disconnected: 'Поток прерван',
};

export function MarketChart({
  dark,
  refreshSession,
}: {
  dark: boolean;
  refreshSession: () => void;
}) {
  const config = strategyApi.useStrategyQuery();
  const settings = !config.isError && config.data?.settings;
  const market = marketApi.useMarketQuery(
    settings
      ? {
          instrumentUid: settings.instrument.uid,
          emaPeriod: settings.emaPeriod,
          timeframe: settings.timeframe,
        }
      : skipToken,
  );
  useEffect(() => {
    if (hasStatus(market.error, 401)) refreshSession();
  }, [market.error, refreshSession]);
  const data = market.currentData;
  const latest = data?.candles.at(-1);

  return (
    <Card role="region" aria-labelledby="market-title" className="min-w-0">
      <CardHeader>
        <CardTitle>
          <h2 id="market-title" className="flex items-center gap-2">
            <ChartCandlestick aria-hidden="true" className="size-4 text-primary" /> Свечи и EMA
          </h2>
        </CardTitle>
        <CardDescription>
          {settings
            ? `${settings.instrument.ticker} · ${timeframeLabels[settings.timeframe]} · EMA ${settings.emaPeriod}`
            : 'Сохраните настройки стратегии, чтобы увидеть график.'}
        </CardDescription>
      </CardHeader>
      {settings && (
        <CardContent className="grid gap-4">
          {market.isLoading && (
            <p role="status" className="text-sm text-muted-foreground">
              Загружаем историю…
            </p>
          )}
          {(market.isError || (data && !data.historyAvailable)) && (
            <>
              <Alert variant="destructive">
                <AlertTitle>Не удалось загрузить историю свечей.</AlertTitle>
              </Alert>
              <Button
                variant="outline"
                className="justify-self-start"
                disabled={market.isFetching}
                onClick={() => void market.refetch()}
              >
                Повторить
              </Button>
            </>
          )}
          {data && (
            <Badge role="status" variant="outline">
              {streamLabels[data.stream]}
            </Badge>
          )}
          {data?.historyAvailable && !latest && (
            <p className="text-sm text-muted-foreground">Нет свечей за последние семь дней.</p>
          )}
          {data && latest && (
            <Suspense fallback={<p className="text-sm text-muted-foreground">Загружаем график…</p>}>
              <TradingChart
                key={JSON.stringify([data.instrumentUid, data.emaPeriod, data.timeframe])}
                candles={data.candles}
                dark={dark}
              />
            </Suspense>
          )}
        </CardContent>
      )}
    </Card>
  );
}
