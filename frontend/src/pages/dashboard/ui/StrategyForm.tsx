import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { hasStatus } from '@/shared/api';
import {
  Alert,
  AlertTitle,
  Button,
  Field,
  FieldGroup,
  FieldLabel,
  Input,
  NativeSelect,
  NativeSelectOption,
} from '@/shared/ui';
import {
  FuturesSearchForm,
  strategyApi,
  timeframeLabels,
  timeframes,
  type BacktestDraft,
  type StrategyProfiles,
  type StrategyKind,
} from '@/entities/strategy';
import { sandboxErrorMessage } from '@/entities/sandbox';

const maxInt = 2_147_483_647;

export type StrategyAccountProps = {
  accountId: string | null;
  disabled: boolean;
  refreshSession: () => void;
};

export function StrategyForm({
  config,
  kind,
  accountId,
  disabled,
  refreshSession,
}: StrategyAccountProps & {
  config: StrategyProfiles['profiles'][StrategyKind];
  kind: StrategyKind;
}) {
  const initialTicker = config.settings?.instrument.ticker ?? config.defaults.ticker;
  const [query, setQuery] = useState(initialTicker);
  const [contractUid, setContractUid] = useState(config.settings?.instrument.uid);
  const [defaultSelectionAllowed, setDefaultSelectionAllowed] = useState(true);
  const [timeframe, setTimeframe] = useState(
    config.settings?.timeframe ?? config.defaults.timeframe,
  );
  const [emaPeriod, setEmaPeriod] = useState(
    String(config.settings?.parameters.emaPeriod ?? config.defaults.emaPeriod),
  );
  const [lots, setLots] = useState(
    config.settings && 'lots' in config.settings.parameters
      ? String(config.settings.parameters.lots)
      : '',
  );
  const improved =
    config.settings?.parameters && 'atrPeriod' in config.settings.parameters
      ? config.settings.parameters
      : 'atrPeriod' in config.defaults
        ? config.defaults
        : undefined;
  const [atrPeriod, setAtrPeriod] = useState(String(improved?.atrPeriod ?? 20));
  const [stopAtrMultiplier, setStopAtrMultiplier] = useState(
    String(improved?.stopAtrMultiplier ?? 2),
  );
  const [addStepAtr, setAddStepAtr] = useState(String(improved?.addStepAtr ?? 1));
  const [maxAddOns, setMaxAddOns] = useState(String(improved?.maxAddOns ?? 3));
  const [tradeWeekends, setTradeWeekends] = useState(improved?.tradeWeekends ?? false);
  const futures = strategyApi.useSearchFuturesQuery(query, {
    skip: !accountId || !query,
  });
  const [save, { isLoading, isSuccess, error, reset }] = strategyApi.useSaveProfileMutation();
  const navigate = useNavigate();

  useEffect(() => {
    if (hasStatus(futures.error, 401) || hasStatus(error, 401)) refreshSession();
  }, [futures.error, error, refreshSession]);

  const canEdit = Boolean(accountId) && !disabled && !isLoading;
  const results = futures.currentData ?? [];
  const exactDefaults = results.filter((result) => result.ticker === config.defaults.ticker);
  const defaultMatch =
    kind === 'improved-surfing' &&
    !config.settings &&
    defaultSelectionAllowed &&
    query === config.defaults.ticker &&
    exactDefaults.length === 1
      ? exactDefaults[0]
      : undefined;
  const selectedMatch = results.find((result) => result.uid === contractUid) ?? defaultMatch;
  const canSave =
    canEdit &&
    !futures.isFetching &&
    !futures.isError &&
    selectedMatch &&
    emaPeriod &&
    (kind === 'surfing' ? lots : atrPeriod && stopAtrMultiplier && addStepAtr && maxAddOns !== '');

  // The backtest hand-off carries a snapshot of the current draft, including unsaved edits, and does
  // not inherit the save restrictions tied to the robot or account state.
  const openBacktest = () => {
    void navigate({
      to: '/backtest',
      state: {
        backtestDraft: {
          instrumentUid: selectedMatch?.uid ?? '',
          ticker: selectedMatch?.ticker ?? initialTicker,
          timeframe,
          emaPeriod,
          lots,
        } satisfies BacktestDraft,
      },
    });
  };

  return (
    <>
      {!accountId && (
        <p className="text-sm text-muted-foreground">
          Выберите доступный виртуальный счёт, чтобы изменить настройки.
        </p>
      )}
      <FuturesSearchForm
        initialTicker={initialTicker}
        disabled={!canEdit}
        isFetching={futures.isFetching}
        search={(term) => {
          setDefaultSelectionAllowed(false);
          if (term === query) void futures.refetch();
          else setQuery(term);
        }}
      />
      {futures.isFetching && (
        <p role="status" className="text-sm text-muted-foreground">
          Ищем фьючерсы…
        </p>
      )}
      {futures.isError && (
        <Alert variant="destructive">
          <AlertTitle>{sandboxErrorMessage(futures.error)}</AlertTitle>
        </Alert>
      )}
      {accountId && !futures.isFetching && futures.currentData?.length === 0 && (
        <p role="status" className="text-sm text-muted-foreground">
          Подходящих фьючерсов нет.
        </p>
      )}
      <form
        className="grid justify-items-start gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSave || !accountId) return;
          setContractUid(selectedMatch.uid);
          void save({
            accountId,
            instrumentUid: selectedMatch.uid,
            timeframe,
            kind,
            parameters:
              kind === 'surfing'
                ? { emaPeriod: Number(emaPeriod), lots: Number(lots) }
                : {
                    emaPeriod: Number(emaPeriod),
                    atrPeriod: Number(atrPeriod),
                    stopAtrMultiplier: Number(stopAtrMultiplier),
                    addStepAtr: Number(addStepAtr),
                    maxAddOns: Number(maxAddOns),
                    tradeWeekends,
                  },
          });
        }}
      >
        <FieldGroup className="min-w-0 gap-4">
          <Field className="min-w-0">
            <FieldLabel htmlFor="strategy-contract">Контракт</FieldLabel>
            <NativeSelect
              id="strategy-contract"
              className="w-full"
              value={selectedMatch?.uid ?? ''}
              disabled={!canEdit || futures.isFetching || !results.length || futures.isError}
              onChange={(event) => {
                setDefaultSelectionAllowed(false);
                setContractUid(event.target.value);
                reset();
              }}
            >
              <NativeSelectOption value="" disabled>
                Выберите контракт
              </NativeSelectOption>
              {results.map((result) => (
                <NativeSelectOption key={result.uid} value={result.uid}>
                  {[
                    result.ticker,
                    result.name,
                    result.classCode,
                    result.exchange,
                    result.expirationDate?.slice(0, 10) ?? 'Бессрочный',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,6rem),1fr))] gap-4">
            <Field>
              <FieldLabel htmlFor="strategy-timeframe">Таймфрейм</FieldLabel>
              <NativeSelect
                id="strategy-timeframe"
                className="w-full"
                value={timeframe}
                disabled={!canEdit}
                onChange={(event) => {
                  const selected = timeframes.find((value) => value === event.target.value);
                  if (selected) setTimeframe(selected);
                  reset();
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
              <FieldLabel htmlFor="strategy-ema">Период EMA</FieldLabel>
              <Input
                id="strategy-ema"
                type="number"
                min={1}
                max={maxInt}
                step={1}
                required
                disabled={!canEdit}
                value={emaPeriod}
                onChange={(event) => {
                  setEmaPeriod(event.target.value);
                  reset();
                }}
              />
            </Field>
            {kind === 'surfing' && (
              <Field>
                <FieldLabel htmlFor="strategy-lots">Объём, лотов</FieldLabel>
                <Input
                  id="strategy-lots"
                  type="number"
                  min={1}
                  max={maxInt}
                  step={1}
                  required
                  disabled={!canEdit}
                  value={lots}
                  onChange={(event) => {
                    setLots(event.target.value);
                    reset();
                  }}
                />
              </Field>
            )}
          </div>
          {kind === 'improved-surfing' && (
            <>
              {(
                [
                  ['Период ATR', atrPeriod, setAtrPeriod, 1, 1],
                  ['Множитель стопа ATR', stopAtrMultiplier, setStopAtrMultiplier, 0.01, 'any'],
                  ['Шаг добора ATR', addStepAtr, setAddStepAtr, 0.01, 'any'],
                  ['Лимит доборов', maxAddOns, setMaxAddOns, 0, 1],
                ] as const
              ).map(([label, value, setValue, min, step]) => (
                <Field key={label}>
                  <FieldLabel>
                    {label}
                    <Input
                      type="number"
                      min={min}
                      step={step}
                      required
                      disabled={!canEdit}
                      value={value}
                      onChange={(event) => {
                        setValue(event.target.value);
                        reset();
                      }}
                    />
                  </FieldLabel>
                </Field>
              ))}
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={tradeWeekends}
                  disabled={!canEdit}
                  onChange={(event) => {
                    setTradeWeekends(event.target.checked);
                    reset();
                  }}
                />{' '}
                Торговать по выходным
              </label>
            </>
          )}
        </FieldGroup>
        <Button type="submit" disabled={!canSave}>
          {isLoading ? 'Сохраняем…' : 'Сохранить настройки'}
        </Button>
        {kind === 'surfing' && (
          <Button type="button" variant="outline" onClick={openBacktest}>
            Бэктест
          </Button>
        )}
        {isSuccess && (
          <p role="status" className="text-sm text-primary">
            Настройки сохранены.
          </p>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertTitle>{sandboxErrorMessage(error)}</AlertTitle>
          </Alert>
        )}
      </form>
    </>
  );
}
