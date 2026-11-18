import { useState } from 'react';
import { Alert, AlertTitle, Button, Empty, EmptyHeader, EmptyTitle, Field, FieldGroup, FieldLabel, NativeSelect, NativeSelectOption, Separator } from '@/shared/ui';
import type { SandboxStatus } from '../api/sandbox-api';

export type SandboxAccountActions = {
  select: (accountId: string) => void;
  create: () => void;
  fund: (accountId: string) => void;
};

export function SandboxAccounts({ connection, fundingAmount, disabled, select, create, fund }: SandboxAccountActions & {
  connection: SandboxStatus;
  fundingAmount: string;
  disabled: boolean;
}) {
  const { accounts, accountId } = connection;
  const selectedAccount = accounts.find(account => account.id === accountId);
  const [choice, setChoice] = useState(accountId ?? '');
  return (
    <div className="grid min-w-0 gap-4">
      {accountId && !selectedAccount && <Alert variant="destructive">
        <AlertTitle className="wrap-anywhere">Сохранённый счёт ({accountId}) недоступен. Выберите другой счёт.</AlertTitle>
      </Alert>}
      {accounts.length > 0 && <form className="flex flex-wrap items-end gap-2" onSubmit={event => {
        event.preventDefault();
        select(choice);
      }}>
        <FieldGroup className="min-w-0 flex-[1_1_12rem]">
          <Field data-disabled={disabled || undefined}>
            <FieldLabel htmlFor="sandbox-account">Виртуальный счёт</FieldLabel>
            <NativeSelect id="sandbox-account" className="w-full" disabled={disabled}
              value={accounts.some(account => account.id === choice) ? choice : ''} onChange={event => setChoice(event.target.value)}>
              <NativeSelectOption value="" disabled>Выберите счёт</NativeSelectOption>
              {accounts.map(account => <NativeSelectOption key={account.id} value={account.id}>
                {account.name ? `${account.name} (${account.id})` : account.id}
              </NativeSelectOption>)}
            </NativeSelect>
          </Field>
        </FieldGroup>
        <Button type="submit" variant="outline"
          disabled={disabled || choice === accountId || !accounts.some(account => account.id === choice)}>
          Выбрать счёт
        </Button>
      </form>}
      {!accounts.length && <Empty className="py-4 md:p-4">
        <EmptyHeader><EmptyTitle>Нет открытых виртуальных счетов.</EmptyTitle></EmptyHeader>
      </Empty>}
      {selectedAccount && <p className="rounded-lg bg-muted px-3 py-2 text-sm wrap-anywhere" role="status">
        <span className="font-medium">Выбран счёт:</span> {selectedAccount.id}
      </p>}
      <Separator />
      <div className="flex flex-wrap items-center gap-2">
        <Button variant={selectedAccount ? 'outline' : 'default'} disabled={disabled} onClick={create}>Создать виртуальный счёт</Button>
        {selectedAccount && <Button disabled={disabled} onClick={() => fund(selectedAccount.id)}>
          Пополнить на {fundingAmount}
        </Button>}
      </div>
    </div>
  );
}
