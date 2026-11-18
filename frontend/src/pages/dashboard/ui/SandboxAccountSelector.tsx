import { skipToken } from '@reduxjs/toolkit/query/react';
import { useEffect } from 'react';
import { sandboxApi, sandboxErrorMessage, selectedSandboxAccount } from '@/entities/sandbox';
import { hasStatus } from '@/shared/api';
import { NativeSelect, NativeSelectOption } from '@/shared/ui';

const rubles = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB' });

export function SandboxAccountSelector({ refreshSession, disabled, settingsHint }: {
  refreshSession: () => void; disabled: boolean; settingsHint?: string;
}) {
  const sandbox = sandboxApi.useSandboxQuery(undefined, { refetchOnFocus: true, refetchOnReconnect: true });
  const connection = sandbox.isError ? undefined : sandbox.currentData;
  const accounts = connection?.status === 'connected' ? connection.accounts : [];
  const selected = selectedSandboxAccount(connection);
  const [select, selection] = sandboxApi.useSelectSandboxAccountMutation();
  const balance = sandboxApi.useSandboxBalanceQuery(selected?.id ?? skipToken, {
    pollingInterval: 30_000, skipPollingIfUnfocused: true, refetchOnFocus: true, refetchOnReconnect: true,
  });
  const unauthorized = [sandbox.error, selection.error, balance.error].some(error => hasStatus(error, 401));
  useEffect(() => {
    if (unauthorized) refreshSession();
  }, [unauthorized, refreshSession]);

  const unavailable = sandbox.isError || connection?.status === 'unavailable' || Boolean(connection?.accountId && !selected);
  const placeholder = sandbox.isLoading ? 'Загружаем счета…' : unavailable ? 'Счёт недоступен'
    : accounts.length ? 'Выберите счёт' : 'Нет счетов';
  const amount = balance.currentData?.accountId === selected?.id ? balance.currentData?.rubles : null;
  const balanceText = !selected ? (unavailable ? 'Недоступно' : 'Выберите счёт')
    : balance.isError ? 'Недоступно'
      : amount != null ? rubles.format(amount) : balance.isFetching ? 'Загружаем…' : 'Недоступно';
  const error = selection.error && !unauthorized ? sandboxErrorMessage(selection.error) : undefined;

  return (
    <div role="group" aria-label="Счёт песочницы" className="grid w-full min-w-0 gap-1 sm:w-auto">
      <div className="flex min-w-0 flex-wrap items-end gap-x-4 gap-y-2">
        <div className="grid min-w-0 flex-[1_1_9rem] gap-1 sm:w-64">
          <label htmlFor="sandbox-account" className="text-xs text-muted-foreground">Виртуальный счёт</label>
          <NativeSelect id="sandbox-account" className="w-full"
            value={selected?.id ?? ''} disabled={!accounts.length || selection.isLoading || sandbox.isFetching || disabled}
            aria-describedby={[settingsHint && 'sandbox-account-hint', error && 'sandbox-account-error'].filter(Boolean).join(' ') || undefined}
            onChange={event => void select(event.target.value)}>
            <NativeSelectOption value="" disabled>{placeholder}</NativeSelectOption>
            {accounts.map(({ id, name }) => <NativeSelectOption key={id} value={id}>
              {name ? `${name} (${id})` : id}
            </NativeSelectOption>)}
          </NativeSelect>
        </div>
        <div className="grid min-w-0 gap-1">
          <span id="sandbox-balance-label" className="text-xs text-muted-foreground">Деньги на счёте</span>
          <output aria-labelledby="sandbox-balance-label" className="flex h-8 items-center text-sm font-medium tabular-nums">
            {balanceText}
          </output>
        </div>
      </div>
      {settingsHint && <p id="sandbox-account-hint" className="text-sm text-muted-foreground">{settingsHint}</p>}
      {error && <p id="sandbox-account-error" role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
