import { skipToken } from '@reduxjs/toolkit/query/react';
import { useEffect, useState } from 'react';
import { sandboxErrorMessage } from '@/entities/sandbox';
import {
  FuturesSearchForm,
  strategyApi,
  timeframeLabels,
  timeframes,
  type StrategyKind,
  type StrategyProfiles,
  type Timeframe,
} from '@/entities/strategy';
import { hasStatus } from '@/shared/api';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  FieldGroup,
  FieldLabel,
  Input,
  NativeSelect,
  NativeSelectOption,
} from '@/shared/ui';
import {
  backtestApi,
  backtestTimeZone,
  type BacktestRequest,
  type BacktestReport,
} from '../api/backtest-api';
import { calendarDay } from '../lib/calendar-day';
import { BacktestReportCard } from './BacktestReportCard';
import { DateRangePicker } from './DateRangePicker';
import { ImprovedBacktestFields, type ImprovedDraft } from './ImprovedBacktestFields';

const runErrors = {
  INVALID_REQUEST: 'Проверьте параметры и даты прогона.',
  BACKTEST_PERIOD_UNFINISHED: 'Выберите полностью завершившиеся дни по Москве.',
  BACKTEST_HISTORY_EMPTY: 'За выбранный период нет свечей',
  BACKTEST_CANDLES_LOAD_FAILED: 'Не удалось загрузить свечи',
  BACKTEST_CANDLES_MISSING: 'За выбранный период нет пригодных для прогона свечей.',
  BACKTEST_NO_CONFIRMED_INTERVALS:
    'За выбранный период нет свечей стратегии, подтверждённых минутными свечами.',
  BACKTEST_WARMUP_MISSING: 'Недостаточно пригодных свечей для прогрева индикаторов.',
  BACKTEST_UNAVAILABLE: 'Бэктест сейчас недоступен.',
  BACKTEST_EXECUTION_PRICE_INVALID: 'Условия исполнения не дают корректной цены или суммы сделки.',
  BACKTEST_HISTORY_CONFLICT: 'Источник вернул разные свечи с одним временем открытия.',
  BACKTEST_CONTRACT_PARAMS_MISSING:
    'Нет параметров контракта для пересчёта цены в деньги. Выберите другой контракт.',
  SANDBOX_OPERATION_REJECTED: 'Песочница отклонила запрос истории. Проверьте контракт и период.',
} as const;

function errorData(error: unknown) {
  return typeof error === 'object' && error && 'data' in error ? error.data : null;
}

function errorCode(data: unknown) {
  return typeof data === 'object' && data && 'code' in data ? data.code : undefined;
}

function errorMessage(error: unknown) {
  const data = errorData(error);
  const code = errorCode(data);
  if (code === 'BACKTEST_WARMUP_MISSING' && data && typeof data === 'object' && 'details' in data) {
    const details = data.details;
    if (
      details &&
      typeof details === 'object' &&
      'required' in details &&
      'available' in details &&
      'searchedFrom' in details &&
      typeof details.required === 'number' &&
      typeof details.available === 'number' &&
      typeof details.searchedFrom === 'string' &&
      Number.isFinite(Date.parse(details.searchedFrom))
    ) {
      return (
        `Для прогрева нужно завершённых свечей: ${details.required}. ` +
        `Найдено: ${details.available} (поиск с ${calendarDay(details.searchedFrom)}, включая выбранный диапазон). ` +
        'Выберите другой диапазон или уменьшите периоды индикаторов.'
      );
    }
  }
  return typeof code === 'string' && Object.hasOwn(runErrors, code)
    ? runErrors[code as keyof typeof runErrors]
    : sandboxErrorMessage(error);
}

function profileDraft(profiles: StrategyProfiles['profiles'], kind: StrategyKind) {
  const { settings, defaults } = profiles[kind];
  return {
    instrument: settings?.instrument,
    ticker: settings?.instrument.ticker ?? defaults.ticker,
    timeframe: settings?.timeframe ?? defaults.timeframe,
    emaPeriod: String(settings?.parameters.emaPeriod ?? defaults.emaPeriod),
    lots: settings && 'lots' in settings.parameters ? String(settings.parameters.lots) : '',
  };
}

function improvedDraft(profiles: StrategyProfiles['profiles']): ImprovedDraft {
  const { settings, defaults } = profiles['improved-surfing'];
  const values = settings?.parameters ?? defaults;
  return {
    atrPeriod: String(values.atrPeriod),
    stopAtrMultiplier: String(values.stopAtrMultiplier),
    addStepAtr: String(values.addStepAtr),
    maxAddOns: String(values.maxAddOns),
    tradeWeekends: values.tradeWeekends,
  };
}

export function BacktestForm({
  dark,
  refreshSession,
  config,
}: {
  dark: boolean;
  refreshSession: () => void;
  config: StrategyProfiles;
}) {
  const [kind, setKind] = useState(config.selected);
  const [profile, setProfile] = useState(() => profileDraft(config.profiles, kind));
  const [instrumentUid, setInstrumentUid] = useState(profile.instrument?.uid ?? '');
  const [query, setQuery] = useState(profile.ticker);
  const [timeframe, setTimeframe] = useState<Timeframe>(profile.timeframe);
  const [emaPeriod, setEmaPeriod] = useState(profile.emaPeriod);
  const [lots, setLots] = useState(profile.lots);
  const [improved, setImproved] = useState(() => improvedDraft(config.profiles));
  const [initialMoney, setInitialMoney] = useState('100000');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [commission, setCommission] = useState('0');
  const [slippage, setSlippage] = useState('0');

  const futures = strategyApi.useSearchFuturesQuery(query || skipToken);
  const limits = backtestApi.useBacktestLimitsQuery();
  const [run, result] = backtestApi.useRunBacktestMutation();
  const [lastReport, setLastReport] = useState<BacktestReport | null>(null);

  const matches = futures.currentData ?? [];
  const contracts =
    profile.instrument &&
    profile.ticker === query &&
    !matches.some(({ uid }) => uid === profile.instrument?.uid)
      ? [profile.instrument, ...matches]
      : matches;
  const defaultMatches = matches.filter(({ ticker }) => ticker === profile.ticker);
  const defaultMatch =
    kind === 'improved-surfing' &&
    !profile.instrument &&
    query === profile.ticker &&
    !instrumentUid &&
    defaultMatches.length === 1
      ? defaultMatches[0]
      : undefined;
  const selected = contracts.find((contract) => contract.uid === instrumentUid) ?? defaultMatch;
  const errors = futures.error ?? limits.error ?? result.error;
  const code = errorCode(errorData(errors));
  const historyWarning =
    code === 'BACKTEST_HISTORY_EMPTY' ||
    code === 'BACKTEST_CANDLES_MISSING' ||
    code === 'BACKTEST_NO_CONFIRMED_INTERVALS' ||
    code === 'BACKTEST_WARMUP_MISSING';
  useEffect(() => {
    if ([futures.error, limits.error, result.error].some((error) => hasStatus(error, 401))) {
      refreshSession();
    }
  }, [futures.error, limits.error, result.error, refreshSession]);

  const changeStrategy = (next: StrategyKind) => {
    setKind(next);
    const draft = profileDraft(config.profiles, next);
    setProfile(draft);
    setInstrumentUid(draft.instrument?.uid ?? '');
    setQuery(draft.ticker);
    setTimeframe(draft.timeframe);
    setEmaPeriod(draft.emaPeriod);
    setLots(draft.lots);
    setImproved(improvedDraft(config.profiles));
    result.reset();
  };

  const currentParameters = (): BacktestRequest | null => {
    if (!selected || !limits.data) return null;
    const ema = Number(emaPeriod);
    const maxPeriod = limits.data.maxEmaPeriod;
    const costs = Number(commission);
    const steps = Number(slippage);
    const money = Number(initialMoney);
    const int = (value: number, min: number, max = 2_147_483_647) =>
      Number.isInteger(value) && value >= min && value <= max;
    if (
      !int(ema, 1, maxPeriod) ||
      !from ||
      !to ||
      commission === '' ||
      slippage === '' ||
      !Number.isFinite(costs) ||
      costs < 0 ||
      costs > 100 ||
      !int(steps, 0) ||
      !Number.isFinite(money) ||
      money < 0.01 ||
      money > Number.MAX_SAFE_INTEGER
    )
      return null;
    const base = {
      instrumentUid: selected.uid,
      timeframe,
      emaPeriod: ema,
      from,
      to,
      initialMoney: money,
      commission: costs,
      slippage: steps,
    };
    if (kind === 'surfing')
      return int(Number(lots), 1) ? { ...base, kind, lots: Number(lots) } : null;
    const atrPeriod = Number(improved.atrPeriod);
    const stopAtrMultiplier = Number(improved.stopAtrMultiplier);
    const addStepAtr = Number(improved.addStepAtr);
    const maxAddOns = Number(improved.maxAddOns);
    if (
      !int(atrPeriod, 1, maxPeriod) ||
      !int(maxAddOns, 0) ||
      improved.maxAddOns === '' ||
      ![stopAtrMultiplier, addStepAtr].every((value) => Number.isFinite(value) && value > 0)
    )
      return null;
    return {
      ...base,
      kind,
      atrPeriod,
      stopAtrMultiplier,
      addStepAtr,
      maxAddOns,
      tradeWeekends: improved.tradeWeekends,
    };
  };

  const stale =
    lastReport !== null &&
    (() => {
      const current = currentParameters();
      return (
        current === null ||
        Object.entries(current).some(
          ([key, value]) => lastReport.parameters[key as keyof typeof current] !== value,
        )
      );
    })();

  const submit = async () => {
    const current = currentParameters();
    if (!current) return;
    try {
      setLastReport(await run(current).unwrap());
    } catch {
      // Keep the last successful report; the error is surfaced without passing it off as the new result.
    }
  };

  const canRun =
    Boolean(limits.data && selected && currentParameters()) &&
    !futures.isFetching &&
    !futures.isError &&
    !result.isLoading;

  return (
    <div className="grid w-full min-w-0 max-w-screen-xl gap-4">
      <Card>
        <CardHeader>
          <CardTitle>
            <h1>Бэктест</h1>
          </CardTitle>
          <CardDescription>
            Историческая симуляция. Заявки не отправляются, изменения формы не сохраняются в
            профиле.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <FuturesSearchForm
            key={kind}
            initialTicker={profile.ticker}
            disabled={result.isLoading}
            isFetching={futures.isFetching}
            search={(term) => {
              if (term === query) void futures.refetch();
              else {
                setInstrumentUid('');
                setQuery(term);
              }
            }}
          />
          {futures.isFetching && (
            <p role="status" className="text-sm text-muted-foreground">
              Ищем фьючерсы…
            </p>
          )}
          {futures.currentData?.length === 0 && !futures.isFetching && (
            <p className="text-sm text-muted-foreground">Подходящих фьючерсов нет.</p>
          )}
          {errors && (
            <Alert variant={historyWarning ? 'default' : 'destructive'}>
              <AlertTitle>{errorMessage(errors)}</AlertTitle>
              {result.error && lastReport && (
                <AlertDescription>Ниже показан предыдущий успешный отчёт.</AlertDescription>
              )}
            </Alert>
          )}
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <fieldset className="min-w-0" disabled={result.isLoading}>
              <FieldGroup className="grid gap-4 sm:grid-cols-3">
                <Field className="min-w-0 sm:col-span-3">
                  <FieldLabel htmlFor="backtest-contract">Контракт</FieldLabel>
                  <NativeSelect
                    id="backtest-contract"
                    className="w-full"
                    value={selected?.uid ?? ''}
                    required
                    onChange={(event) => setInstrumentUid(event.target.value)}
                  >
                    <NativeSelectOption value="" disabled>
                      Выберите контракт
                    </NativeSelectOption>
                    {contracts.map((contract) => (
                      <NativeSelectOption key={contract.uid} value={contract.uid}>
                        {contract.ticker} · {contract.exchange}
                        {contract.expirationDate
                          ? ` · ${calendarDay(contract.expirationDate)}`
                          : ''}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
                <Field className="sm:col-span-3">
                  <FieldLabel htmlFor="backtest-strategy">Стратегия</FieldLabel>
                  <NativeSelect
                    id="backtest-strategy"
                    value={kind}
                    onChange={(event) => {
                      const next = event.target.value;
                      if (next === 'surfing' || next === 'improved-surfing') changeStrategy(next);
                    }}
                  >
                    <NativeSelectOption value="surfing">Surfing</NativeSelectOption>
                    <NativeSelectOption value="improved-surfing">
                      Улучшенный серфинг
                    </NativeSelectOption>
                  </NativeSelect>
                </Field>
                <Field>
                  <FieldLabel htmlFor="backtest-timeframe">Таймфрейм</FieldLabel>
                  <NativeSelect
                    id="backtest-timeframe"
                    value={timeframe}
                    onChange={(event) => {
                      const next = timeframes.find((value) => value === event.target.value);
                      if (next) setTimeframe(next);
                    }}
                  >
                    {timeframes.map((value) => (
                      <NativeSelectOption key={value} value={value}>
                        {timeframeLabels[value]}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
                <Field>
                  <FieldLabel htmlFor="backtest-ema">Период EMA</FieldLabel>
                  <Input
                    id="backtest-ema"
                    type="number"
                    placeholder="55"
                    required
                    min={1}
                    max={limits.data?.maxEmaPeriod}
                    value={emaPeriod}
                    onChange={(event) => setEmaPeriod(event.target.value)}
                  />
                </Field>
                {kind === 'surfing' ? (
                  <Field>
                    <FieldLabel htmlFor="backtest-lots">Объём, лотов</FieldLabel>
                    <Input
                      id="backtest-lots"
                      type="number"
                      min={1}
                      max={2_147_483_647}
                      required
                      value={lots}
                      onChange={(event) => setLots(event.target.value)}
                    />
                  </Field>
                ) : (
                  <ImprovedBacktestFields
                    draft={improved}
                    maxPeriod={limits.data?.maxEmaPeriod}
                    onChange={setImproved}
                  />
                )}
                <Field>
                  <FieldLabel htmlFor="backtest-capital">Начальные свободные деньги, ₽</FieldLabel>
                  <Input
                    id="backtest-capital"
                    type="number"
                    min={0.01}
                    max={Number.MAX_SAFE_INTEGER}
                    step="0.01"
                    required
                    value={initialMoney}
                    onChange={(event) => setInitialMoney(event.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="backtest-range">Диапазон дат</FieldLabel>
                  <DateRangePicker
                    id="backtest-range"
                    describedBy="backtest-period"
                    from={from}
                    to={to}
                    timeZone={backtestTimeZone}
                    onChange={(nextFrom, nextTo) => {
                      setFrom(nextFrom);
                      setTo(nextTo);
                    }}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="backtest-commission">Комиссия, %</FieldLabel>
                  <Input
                    id="backtest-commission"
                    type="number"
                    min={0}
                    max={100}
                    step="any"
                    required
                    value={commission}
                    onChange={(event) => setCommission(event.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="backtest-slippage">Проскальзывание, шагов цены</FieldLabel>
                  <Input
                    id="backtest-slippage"
                    type="number"
                    min={0}
                    max={2_147_483_647}
                    step="1"
                    required
                    value={slippage}
                    onChange={(event) => setSlippage(event.target.value)}
                  />
                </Field>
              </FieldGroup>
            </fieldset>
            <p id="backtest-period" className="text-sm text-muted-foreground">
              Обе даты включительно по Москве; сегодня и будущие даты недоступны. Свечи до начала
              диапазона используются только для прогрева индикаторов.
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
