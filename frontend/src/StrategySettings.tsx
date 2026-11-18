import { useEffect, useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { api, hasStatus, type FutureContract } from './api';
import { sandboxErrorMessage } from './sandbox-errors';

const maxInt = 2_147_483_647;
const dateFormat = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeZone: 'UTC' });

function label(contract: FutureContract) {
  const expiration = contract.expirationDate && dateFormat.format(new Date(contract.expirationDate));
  return [contract.ticker, contract.name, contract.exchange, contract.classCode, expiration, contract.uid]
    .filter(Boolean).join(' · ');
}

type AccountProps = { accountId: string | null; disabled: boolean; refreshSession: () => void };
type Config = NonNullable<ReturnType<typeof api.useStrategyQuery>['data']>;

function StrategyForm({ config, accountId, disabled, refreshSession }: AccountProps & { config: Config }) {
  const initialTicker = config.settings?.instrument.ticker ?? config.defaults.ticker;
  const [input, setInput] = useState(initialTicker);
  const [query, setQuery] = useState(initialTicker);
  const [contract, setContract] = useState(config.settings?.instrument);
  const [emaPeriod, setEmaPeriod] = useState(String(config.settings?.emaPeriod ?? config.defaults.emaPeriod));
  const [lots, setLots] = useState(config.settings ? String(config.settings.lots) : '');
  const futures = api.useSearchFuturesQuery(query, { skip: !accountId || !query });
  const [save, { isLoading, isSuccess, error, reset }] = api.useSaveStrategyMutation();

  useEffect(() => {
    if (hasStatus(futures.error, 401) || hasStatus(error, 401)) refreshSession();
  }, [futures.error, error, refreshSession]);

  const canEdit = Boolean(accountId) && !disabled && !isLoading;
  const results = futures.currentData ?? [];
  const selectedMatch = results.find(result => result.uid === contract?.uid);
  const canSave = canEdit && !futures.isFetching && !futures.isError && selectedMatch && emaPeriod && lots;

  return (
    <>
      {!accountId && <p className="text-sm text-muted-foreground">Выберите доступный виртуальный счёт, чтобы изменить настройки.</p>}
      <form className="flex flex-wrap items-end gap-2" onSubmit={event => {
        event.preventDefault();
        const term = input.trim();
        if (!canEdit || !term) return;
        if (term === query) void futures.refetch();
        else setQuery(term);
      }}>
        <FieldGroup className="min-w-0 flex-[1_1_12rem]">
          <Field>
            <FieldLabel htmlFor="strategy-search">Поиск фьючерса</FieldLabel>
            <Input id="strategy-search" value={input} onChange={event => setInput(event.target.value)}
              placeholder="Тикер или название" maxLength={128} required disabled={!canEdit} />
          </Field>
        </FieldGroup>
        <Button type="submit" variant="outline" disabled={!canEdit || !input.trim() || futures.isFetching}>Найти</Button>
      </form>
      {futures.isFetching && <p role="status" className="text-sm text-muted-foreground">Ищем фьючерсы…</p>}
      {futures.isError && <Alert variant="destructive"><AlertTitle>{sandboxErrorMessage(futures.error)}</AlertTitle></Alert>}
      {accountId && !futures.isFetching && futures.currentData?.length === 0 &&
        <p role="status" className="text-sm text-muted-foreground">Подходящих фьючерсов нет.</p>}
      <form className="grid justify-items-start gap-4" onSubmit={event => {
        event.preventDefault();
        if (!canSave || !accountId) return;
        void save({ accountId, instrumentUid: selectedMatch.uid, emaPeriod: Number(emaPeriod), lots: Number(lots) });
      }}>
        <FieldGroup className="min-w-0 gap-4">
          <Field className="min-w-0">
            <FieldLabel htmlFor="strategy-contract">Контракт</FieldLabel>
            <NativeSelect id="strategy-contract" className="w-full" value={selectedMatch?.uid ?? ''}
              disabled={!canEdit || futures.isFetching || !results.length || futures.isError}
              onChange={event => { setContract(results.find(result => result.uid === event.target.value)); reset(); }}>
              <NativeSelectOption value="" disabled>Выберите контракт</NativeSelectOption>
              {results.map(result => <NativeSelectOption key={result.uid} value={result.uid}>{label(result)}</NativeSelectOption>)}
            </NativeSelect>
          </Field>
          {contract && <p className="wrap-anywhere text-sm">
            <span className="font-medium">Выбран контракт:</span> {label(contract)}
          </p>}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="strategy-ema">Период EMA</FieldLabel>
              <Input id="strategy-ema" type="number" min={1} max={maxInt} step={1} required disabled={!canEdit}
                value={emaPeriod} onChange={event => { setEmaPeriod(event.target.value); reset(); }} />
            </Field>
            <Field>
              <FieldLabel htmlFor="strategy-lots">Объём, лотов</FieldLabel>
              <Input id="strategy-lots" type="number" min={1} max={maxInt} step={1} required disabled={!canEdit}
                value={lots} onChange={event => { setLots(event.target.value); reset(); }} />
            </Field>
          </div>
        </FieldGroup>
        <Button type="submit" disabled={!canSave}>
          {isLoading ? 'Сохраняем…' : 'Сохранить настройки'}
        </Button>
        {isSuccess && <p role="status" className="text-sm text-primary">Настройки сохранены.</p>}
        {error && <Alert variant="destructive"><AlertTitle>{sandboxErrorMessage(error)}</AlertTitle></Alert>}
      </form>
    </>
  );
}

export function StrategySettings(props: AccountProps) {
  const config = api.useStrategyQuery();
  useEffect(() => {
    if (hasStatus(config.error, 401)) props.refreshSession();
  }, [config.error, props.refreshSession]);

  return (
    <Card role="region" aria-labelledby="strategy-title" className="min-w-0 [--card-spacing:--spacing(5)] md:col-span-2">
      <CardHeader>
        <CardTitle><h2 id="strategy-title" className="flex items-center gap-2 font-semibold">
          <SlidersHorizontal aria-hidden="true" className="size-4 text-primary" /> Настройки стратегии
        </h2></CardTitle>
        <CardDescription>Выберите фьючерс, период EMA и размер позиции в лотах.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
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
