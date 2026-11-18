import { Wallet } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/shared/ui';
import type { SandboxStatus } from '../api/sandbox-api';
import { SandboxAccounts, type SandboxAccountActions } from './SandboxAccounts';
import { SandboxFeedback, type SandboxNotice } from './SandboxFeedback';

type Props = SandboxAccountActions & {
  connection?: SandboxStatus;
  isFetching: boolean;
  isError: boolean;
  fundingAmount: string;
  disabled: boolean;
  notice?: SandboxNotice;
};

export function SandboxAccountsCard({ connection, isFetching, isError, fundingAmount, disabled, notice, select, create, fund }: Props) {
  return (
    <Card role="region" aria-labelledby="sandbox-accounts-title" className="min-w-0 [--card-spacing:--spacing(5)]">
      <CardHeader>
        <CardTitle><h2 id="sandbox-accounts-title" className="flex items-center gap-2 font-semibold">
          <Wallet aria-hidden="true" className="size-4 text-primary" /> Виртуальные счета
        </h2></CardTitle>
        <CardDescription>Выбор, создание и пополнение счёта для робота.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {connection?.status === 'connected' && !isError ? <SandboxAccounts key={connection.accountId}
          connection={connection} fundingAmount={fundingAmount} disabled={disabled} select={select} create={create} fund={fund}
        /> : <Empty className="bg-muted/50 py-4 md:p-4">
          <EmptyHeader>
            <EmptyTitle>{isFetching ? 'Загружаем счета…'
              : connection?.status === 'unconfigured' ? 'Сначала подключите песочницу' : 'Список счетов недоступен'}</EmptyTitle>
            {connection?.accountId && <EmptyDescription className="wrap-anywhere">
              Сохранённый счёт: {connection.accountId}
            </EmptyDescription>}
          </EmptyHeader>
        </Empty>}
        <SandboxFeedback notice={notice} />
      </CardContent>
    </Card>
  );
}
