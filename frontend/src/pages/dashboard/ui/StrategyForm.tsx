import { useEffect, useState } from "react";
import { hasStatus } from "@/shared/api";
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
} from "@/shared/ui";
import {
  strategyApi,
  type FutureContract,
  type StrategyConfig,
} from "../api/strategy-api";
import { sandboxErrorMessage } from "@/entities/sandbox";
import { timeframeLabels, timeframes } from "../model/timeframe";
import { FuturesSearchForm } from "./FuturesSearchForm";

const maxInt = 2_147_483_647;
const dateFormat = new Intl.DateTimeFormat("ru-RU", {
  dateStyle: "short",
  timeZone: "UTC",
});

function label(contract: FutureContract) {
  const expiration =
    contract.expirationDate &&
    dateFormat.format(new Date(contract.expirationDate));
  return [contract.ticker, expiration, contract.uid].filter(Boolean).join(" · ");
}

export type StrategyAccountProps = {
  accountId: string | null;
  disabled: boolean;
  refreshSession: () => void;
};

export function StrategyForm({
  config,
  accountId,
  disabled,
  refreshSession,
}: StrategyAccountProps & { config: StrategyConfig }) {
  const initialTicker =
    config.settings?.instrument.ticker ?? config.defaults.ticker;
  const [query, setQuery] = useState(initialTicker);
  const [contract, setContract] = useState(config.settings?.instrument);
  const [timeframe, setTimeframe] = useState(
    config.settings?.timeframe ?? config.defaults.timeframe,
  );
  const [emaPeriod, setEmaPeriod] = useState(
    String(config.settings?.emaPeriod ?? config.defaults.emaPeriod),
  );
  const [lots, setLots] = useState(
    config.settings ? String(config.settings.lots) : "",
  );
  const futures = strategyApi.useSearchFuturesQuery(query, {
    skip: !accountId || !query,
  });
  const [save, { isLoading, isSuccess, error, reset }] =
    strategyApi.useSaveStrategyMutation();

  useEffect(() => {
    if (hasStatus(futures.error, 401) || hasStatus(error, 401))
      refreshSession();
  }, [futures.error, error, refreshSession]);

  const canEdit = Boolean(accountId) && !disabled && !isLoading;
  const results = futures.currentData ?? [];
  const selectedMatch = results.find((result) => result.uid === contract?.uid);
  const canSave =
    canEdit &&
    !futures.isFetching &&
    !futures.isError &&
    selectedMatch &&
    emaPeriod &&
    lots;

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
      {accountId &&
        !futures.isFetching &&
        futures.currentData?.length === 0 && (
          <p role="status" className="text-sm text-muted-foreground">
            Подходящих фьючерсов нет.
          </p>
        )}
      <form
        className="grid justify-items-start gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSave || !accountId) return;
          void save({
            accountId,
            instrumentUid: selectedMatch.uid,
            timeframe,
            emaPeriod: Number(emaPeriod),
            lots: Number(lots),
          });
        }}
      >
        <FieldGroup className="min-w-0 gap-4">
          <Field className="min-w-0">
            <FieldLabel htmlFor="strategy-contract">Контракт</FieldLabel>
            <NativeSelect
              id="strategy-contract"
              className="w-full"
              value={selectedMatch?.uid ?? ""}
              disabled={
                !canEdit ||
                futures.isFetching ||
                !results.length ||
                futures.isError
              }
              onChange={(event) => {
                setContract(
                  results.find((result) => result.uid === event.target.value),
                );
                reset();
              }}
            >
              <NativeSelectOption value="" disabled>
                Выберите контракт
              </NativeSelectOption>
              {results.map((result) => (
                <NativeSelectOption key={result.uid} value={result.uid}>
                  {label(result)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          {contract && (
            <p className="wrap-anywhere text-sm">
              <span className="font-medium">Выбран контракт:</span>{" "}
              {label(contract)}
            </p>
          )}
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
                  <NativeSelectOption key={value} value={value}>{timeframeLabels[value]}</NativeSelectOption>
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
          </div>
        </FieldGroup>
        <Button type="submit" disabled={!canSave}>
          {isLoading ? "Сохраняем…" : "Сохранить настройки"}
        </Button>
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
