import { skipToken } from '@reduxjs/toolkit/query/react';
import { ChartCandlestick } from 'lucide-react';
import { useEffect } from 'react';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api, hasStatus } from './api';
import type { ChartCandle, StreamState } from './market-data';

const streamLabels: Record<StreamState, string> = {
  unconfigured: 'Поток не настроен',
  connecting: 'Подключаем поток…',
  live: 'Поток подключён',
  disconnected: 'Поток прерван',
};
const price = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 9 });
const utc = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short', timeZone: 'UTC' });

function PricePlot({ candles }: { candles: ChartCandle[] }) {
  const width = 900;
  const height = 220;
  const values = candles.flatMap(candle =>
    [candle.low, candle.high, candle.confirmedEma ?? candle.low, candle.previewEma ?? candle.low]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const step = width / candles.length;
  const x = (index: number) => (index + 0.5) * step;
  const y = (value: number) => max === min ? height / 2 : 10 + (max - value) / (max - min) * (height - 20);
  const bodyWidth = Math.min(step * 0.65, 18);
  const confirmedLine = candles.map(({ confirmedEma }, index) => {
    if (confirmedEma === null) return '';
    return `${candles[index - 1]?.confirmedEma != null ? 'L' : 'M'} ${x(index)} ${y(confirmedEma)}`;
  }).join(' ');
  const lastIndex = candles.length - 1;
  const preview = candles[lastIndex].previewEma;
  const lastConfirmed = candles.findLastIndex(candle => candle.confirmedEma !== null);
  const confirmed = candles[lastConfirmed]?.confirmedEma;
  return (
    <figure className="grid gap-2">
      <svg role="img" aria-label="Часовые свечи и EMA" viewBox={`0 0 ${width} ${height}`}
        className="w-full rounded-md bg-muted/40">
        <g stroke="currentColor" className="text-muted-foreground">
          {candles.map(({ time, open, high, low, close }, index) => (
            <g key={time}>
              <line x1={x(index)} x2={x(index)} y1={y(high)} y2={y(low)} />
              <rect x={x(index) - bodyWidth / 2} y={y(Math.max(open, close))}
                width={bodyWidth} height={Math.max(1, Math.abs(y(open) - y(close)))}
                fill={close >= open ? 'var(--background)' : 'currentColor'} />
            </g>
          ))}
        </g>
        <g className="text-primary">
          <path d={confirmedLine} stroke="currentColor" strokeWidth="2" fill="none" />
          {candles.map(({ time, confirmedEma }, index) => confirmedEma !== null &&
            <circle key={time} cx={x(index)} cy={y(confirmedEma)} r="1.5" fill="currentColor" />)}
          {preview !== null && confirmed != null && <>
            <line x1={x(lastConfirmed)} x2={x(lastIndex)} y1={y(confirmed)} y2={y(preview)}
              stroke="currentColor" strokeWidth="2" strokeDasharray="4 4" />
            <circle cx={x(lastIndex)} cy={y(preview)} r="3" fill="var(--background)" stroke="currentColor" />
          </>}
        </g>
      </svg>
      <figcaption className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
        <span>{utc.format(candles[0].time)} — {utc.format(candles[lastIndex].time)} UTC</span>
        <span>{candles.length} св. · {price.format(min)} — {price.format(max)}</span>
      </figcaption>
    </figure>
  );
}

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
        {data && latest && <>
          <PricePlot candles={data.candles} />
          <p className="text-xs text-muted-foreground">
            Сплошная линия — EMA брокера · Пунктир — предварительная EMA
          </p>
          <dl aria-label="Последняя свеча" className="grid gap-2 text-sm sm:grid-cols-3">
            <div><dt className="text-muted-foreground">{latest.complete ? 'Закрытая свеча' : 'Свеча не подтверждена'}</dt>
              <dd>{utc.format(latest.time)} UTC</dd></div>
            <div><dt className="text-muted-foreground">{latest.complete ? 'Цена закрытия' : 'Текущая цена'}</dt>
              <dd>{price.format(latest.close)}</dd></div>
            <div><dt className="text-muted-foreground">
              {latest.previewEma !== null ? 'Предварительная EMA' : 'Подтверждённая EMA'}
            </dt><dd>{latest.confirmedEma !== null ? price.format(latest.confirmedEma)
              : latest.previewEma !== null ? price.format(latest.previewEma) : 'Нет подтверждения'}</dd></div>
          </dl>
        </>}
      </CardContent>}
    </Card>
  );
}
