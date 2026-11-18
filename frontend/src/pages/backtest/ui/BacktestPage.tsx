import { skipToken } from '@reduxjs/toolkit/query/react';
import { useEffect, useState } from 'react';
import { sandboxErrorMessage } from '@/entities/sandbox';
import { FuturesSearchForm, strategyApi, timeframeLabels, timeframes, type BacktestDraft, type Timeframe } from '@/entities/strategy';
import { hasStatus } from '@/shared/api';
import {
  Alert, AlertTitle, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field,
  FieldGroup, FieldLabel, Input, NativeSelect, NativeSelectOption,
} from '@/shared/ui';
import { backtestApi, type BacktestParameters, type BacktestReport } from '../api/backtest-api';
import { calendarDay } from '../lib/calendar-day';
import { BacktestReportCard } from './BacktestReportCard';
import { DateRangePicker } from './DateRangePicker';

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

function sameParameters(a: BacktestParameters, b: BacktestParameters) {
  return a.instrumentUid === b.instrumentUid && a.timeframe === b.timeframe && a.emaPeriod === b.emaPeriod
    && a.lots === b.lots && a.from === b.from && a.to === b.to
    && a.commission === b.commission && a.slippage === b.slippage;
}

function isNonNegativeCost(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0;
}

export function BacktestPage({ dark, refreshSession, initialDraft }: {
  dark: boolean; refreshSession: () => void; initialDraft: BacktestDraft | null;
}) {
  const [instrumentUid, setInstrumentUid] = useState(initialDraft?.instrumentUid ?? '');
  const [query, setQuery] = useState(initialDraft?.ticker ?? '');
  const [timeframe, setTimeframe] = useState<Timeframe>(initialDraft?.timeframe ?? '1h');
  const [emaPeriod, setEmaPeriod] = useState(initialDraft?.emaPeriod ?? '55');
  const [lots, setLots] = useState(initialDraft?.lots ?? '');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [commission, setCommission] = useState('0');
  const [slippage, setSlippage] = useState('0');

  const futures = strategyApi.useSearchFuturesQuery(query || skipToken);
  const strategy = strategyApi.useStrategyQuery();
  const limits = backtestApi.useBacktestLimitsQuery();
  const [run, result] = backtestApi.useRunBacktestMutation();
  const [lastReport, setLastReport] = useState<BacktestReport | null>(null);

  const contracts = futures.currentData ?? [];
  const selected = contracts.find(contract => contract.uid === instrumentUid);
  const errors = futures.error ?? strategy.error ?? limits.error ?? result.error;
  useEffect(() => {
    if ([futures.error, strategy.error, limits.error, result.error].some(error => hasStatus(error, 401))) refreshSession();
  }, [futures.error, strategy.error, limits.error, result.error, refreshSession]);

  // A draft snapshot takes precedence; otherwise a direct entry or refresh starts from the last saved settings.
  useEffect(() => {
    const settings = strategy.data?.settings;
    if (initialDraft || !settings) return;
    setInstrumentUid(settings.instrument.uid);
    setQuery(settings.instrument.ticker);
    setTimeframe(settings.timeframe);
    setEmaPeriod(String(settings.emaPeriod));
    setLots(String(settings.lots));
  }, [strategy.data, initialDraft]);

  const currentParameters = (): BacktestParameters | null => {
    if (!selected) return null;
    const ema = Number(emaPeriod);
    const lot = Number(lots);
    if (!Number.isInteger(ema) || ema < 1 || !Number.isInteger(lot) || lot < 1 || !from || !to) return null;
    if (!isNonNegativeCost(commission) || !isNonNegativeCost(slippage)) return null;
    return {
      instrumentUid: selected.uid, timeframe, emaPeriod: ema, lots: lot, from, to,
      commission: Number(commission), slippage: Number(slippage),
    };
  };

  const stale = lastReport !== null && (() => {
    const current = currentParameters();
    return current === null || !sameParameters(current, lastReport.parameters);
  })();

  const submit = async () => {
    const parameters = currentParameters();
    if (!parameters) return;
    try {
      setLastReport(await run(parameters).unwrap());
    } catch {
      // Keep the last successful report; the error is surfaced without passing it off as the new result.
    }
  };

  const canRun = Boolean(limits.data && selected && currentParameters())
    && !futures.isFetching && !futures.isError && !result.isLoading;

  return (
    <div className="grid w-full min-w-0 max-w-screen-xl gap-4">
      <Card>
        <CardHeader>
          <CardTitle><h1>Бэктест</h1></CardTitle>
          <CardDescription>Исторический прогон стратегии «Сёрфинг» на завершённых свечах. Заявки не отправляются, торговля не меняется.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <FuturesSearchForm initialTicker={initialDraft?.ticker ?? ''} disabled={result.isLoading} isFetching={futures.isFetching}
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
            void submit();
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
                        {contract.ticker} · {contract.exchange}{contract.expirationDate ? ` · ${calendarDay(contract.expirationDate)}` : ''}
                      </NativeSelectOption>)}
                  </NativeSelect>
                </Field>
                <Field>
                  <FieldLabel htmlFor="backtest-timeframe">Таймфрейм</FieldLabel>
                  <NativeSelect id="backtest-timeframe" value={timeframe}
                    onChange={event => {
                      const next = timeframes.find(value => value === event.target.value);
                      if (next) setTimeframe(next);
                    }}>
                    {timeframes.map(value =>
                      <NativeSelectOption key={value} value={value}>{timeframeLabels[value]}</NativeSelectOption>)}
                  </NativeSelect>
                </Field>
                <Field>
                  <FieldLabel htmlFor="backtest-ema">Период EMA</FieldLabel>
                  <Input id="backtest-ema" type="number" placeholder="55" required min={1} max={limits.data?.maxEmaPeriod}
                    value={emaPeriod} onChange={event => setEmaPeriod(event.target.value)} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="backtest-lots">Объём, лотов</FieldLabel>
                  <Input id="backtest-lots" type="number" min={1} max={2_147_483_647} required
                    value={lots} onChange={event => setLots(event.target.value)} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="backtest-range">Диапазон дат</FieldLabel>
                  <DateRangePicker id="backtest-range" describedBy="backtest-period" from={from} to={to}
                    onChange={(nextFrom, nextTo) => { setFrom(nextFrom); setTo(nextTo); }} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="backtest-commission">Комиссия, %</FieldLabel>
                  <Input id="backtest-commission" type="number" min={0} step="0.0001" value={commission}
                    onChange={event => setCommission(event.target.value)} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="backtest-slippage">Проскальзывание, %</FieldLabel>
                  <Input id="backtest-slippage" type="number" min={0} step="0.01" value={slippage}
                    onChange={event => setSlippage(event.target.value)} />
                </Field>
              </FieldGroup>
            </fieldset>
            <p id="backtest-period" className="text-sm text-muted-foreground">
              Обе даты включительно, часовой пояс — Москва. {limits.data && `Лимит прогона: ${limits.data.maxDays} календарных дней. `}
              Доступность истории зависит от контракта и параметров EMA.
            </p>
            <Button type="submit" className="justify-self-start" disabled={!canRun}>
              {result.isLoading ? 'Считаем…' : 'Запустить бэктест'}
            </Button>
          </form>
        </CardContent>
      </Card>
      {lastReport && <BacktestReportCard report={lastReport} stale={stale} dark={dark} />}
    </div>
  );
}
