import { skipToken } from '@reduxjs/toolkit/query/react';
import { useEffect, useState } from 'react';
import { sandboxErrorMessage } from '@/entities/sandbox';
import { FuturesSearchForm, strategyApi, timeframeLabels, timeframes } from '@/entities/strategy';
import { hasStatus } from '@/shared/api';
import {
  Alert, AlertTitle, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field,
  FieldGroup, FieldLabel, Input, NativeSelect, NativeSelectOption,
} from '@/shared/ui';
import { backtestApi } from '../api/backtest-api';
import { BacktestReportCard } from './BacktestReportCard';

const runErrors = {
  BACKTEST_PERIOD_TOO_LONG: 'Сократите диапазон до указанного лимита.',
  BACKTEST_CONTRACT_PERIOD: 'Диапазон выходит за период торгов выбранного контракта.',
  BACKTEST_CANDLES_MISSING: 'Не хватает завершённых свечей. Сократите или сдвиньте период.',
  BACKTEST_EMA_MISSING: 'Брокер не вернул EMA для всех завершённых свечей. Сократите или сдвиньте период.',
  BACKTEST_BASELINE_MISSING: 'Не удалось определить сторону EMA до начала периода. Сдвиньте начало периода.',
  BACKTEST_HISTORY_CONFLICT: 'Данные брокера не совпали на стыке диапазонов. Сократите или сдвиньте период.',
  BACKTEST_CONTRACT_PARAMS_MISSING: 'Нет параметров контракта для пересчёта цены в деньги. Выберите другой контракт.',
  SANDBOX_OPERATION_REJECTED: 'Песочница отклонила запрос истории. Проверьте контракт и период.',
} as const;

function errorMessage(error: unknown) {
  const data = typeof error === 'object' && error && 'data' in error ? error.data : null;
  const code = typeof data === 'object' && data && 'code' in data ? data.code : undefined;
  return typeof code === 'string' && Object.hasOwn(runErrors, code)
    ? runErrors[code as keyof typeof runErrors] : sandboxErrorMessage(error);
}

export function BacktestPage({ dark, refreshSession }: { dark: boolean; refreshSession: () => void }) {
  const [query, setQuery] = useState('');
  const [instrumentUid, setInstrumentUid] = useState('');
  const futures = strategyApi.useSearchFuturesQuery(query || skipToken);
  const limits = backtestApi.useBacktestLimitsQuery();
  const [run, result] = backtestApi.useRunBacktestMutation();
  const contracts = futures.currentData ?? [];
  const selected = contracts.find(contract => contract.uid === instrumentUid);
  const errors = futures.error ?? limits.error ?? result.error;
  useEffect(() => {
    if ([futures.error, limits.error, result.error].some(error => hasStatus(error, 401))) refreshSession();
  }, [futures.error, limits.error, result.error, refreshSession]);

  return (
    <div className="grid w-full min-w-0 max-w-screen-xl gap-4">
      <Card>
        <CardHeader>
          <CardTitle><h1>Бэктест</h1></CardTitle>
          <CardDescription>Исторический прогон стратегии «Сёрфинг» на завершённых свечах. Заявки не отправляются, торговля не меняется.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <FuturesSearchForm initialTicker="" disabled={result.isLoading} isFetching={futures.isFetching}
            search={term => {
              if (term === query) void futures.refetch();
              else { setInstrumentUid(''); setQuery(term); }
            }} />
          {futures.isFetching && <p role="status" className="text-sm text-muted-foreground">Ищем фьючерсы…</p>}
          {futures.currentData?.length === 0 && !futures.isFetching &&
            <p className="text-sm text-muted-foreground">Подходящих фьючерсов нет.</p>}
          {errors && <Alert variant="destructive"><AlertTitle>{errorMessage(errors)}</AlertTitle></Alert>}
          <form className="grid gap-4" onSubmit={event => {
            event.preventDefault();
            if (!limits.data || !selected || futures.isFetching || futures.isError || result.isLoading) return;
            const form = new FormData(event.currentTarget);
            const timeframe = timeframes.find(value => value === form.get('timeframe'));
            if (!timeframe) return;
            void run({
              instrumentUid: selected.uid, timeframe, emaPeriod: Number(form.get('emaPeriod')), lots: Number(form.get('lots')),
              from: String(form.get('from')), to: String(form.get('to')),
            });
          }}>
            <fieldset className="min-w-0" disabled={result.isLoading}>
              <FieldGroup className="grid gap-4 sm:grid-cols-3">
                <Field className="min-w-0 sm:col-span-3">
                  <FieldLabel htmlFor="backtest-contract">Контракт</FieldLabel>
                  <NativeSelect id="backtest-contract" className="w-full" value={selected?.uid ?? ''} required
                    onChange={event => setInstrumentUid(event.target.value)}>
                    <NativeSelectOption value="" disabled>Выберите контракт</NativeSelectOption>
                    {contracts.map(contract =>
                      <NativeSelectOption key={contract.uid} value={contract.uid}>
                        {contract.ticker} · {contract.exchange}{contract.expirationDate ? ` · ${contract.expirationDate.slice(0, 10)}` : ''}
                      </NativeSelectOption>)}
                  </NativeSelect>
                </Field>
                <Field>
                  <FieldLabel htmlFor="backtest-timeframe">Таймфрейм</FieldLabel>
                  <NativeSelect id="backtest-timeframe" name="timeframe" defaultValue="1h">
                    {timeframes.map(value =>
                      <NativeSelectOption key={value} value={value}>{timeframeLabels[value]}</NativeSelectOption>)}
                  </NativeSelect>
                </Field>
                <Field>
                  <FieldLabel htmlFor="backtest-ema">Период EMA</FieldLabel>
                  <Input id="backtest-ema" name="emaPeriod" type="number" placeholder="55" required
                    min={1} max={limits.data?.maxEmaPeriod} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="backtest-lots">Объём, лотов</FieldLabel>
                  <Input id="backtest-lots" name="lots" type="number" min={1} max={2_147_483_647} required />
                </Field>
                <Field>
                  <FieldLabel htmlFor="backtest-from">С даты</FieldLabel>
                  <Input id="backtest-from" name="from" type="date" required aria-describedby="backtest-period" />
                </Field>
                <Field>
                  <FieldLabel htmlFor="backtest-to">По дату</FieldLabel>
                  <Input id="backtest-to" name="to" type="date" required aria-describedby="backtest-period" />
                </Field>
              </FieldGroup>
            </fieldset>
            <p id="backtest-period" className="text-sm text-muted-foreground">
              Обе даты включительно, часовой пояс — Москва. {limits.data && `Лимит прогона: ${limits.data.maxDays} календарных дней. `}
              Доступность истории зависит от контракта и параметров EMA.
            </p>
            <Button type="submit" className="justify-self-start"
              disabled={!limits.data || !selected || futures.isFetching || futures.isError || result.isLoading}>
              {result.isLoading ? 'Считаем…' : 'Запустить бэктест'}
            </Button>
          </form>
        </CardContent>
      </Card>
      {result.data && <BacktestReportCard report={result.data} dark={dark} />}
    </div>
  );
}
