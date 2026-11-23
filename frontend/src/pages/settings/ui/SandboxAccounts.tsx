import { Button, Empty, EmptyHeader, EmptyTitle } from '@/shared/ui';
import { selectedSandboxAccount, type SandboxStatus } from '@/entities/sandbox';

export type SandboxAccountActions = {
  create: () => void;
  fund: (accountId: string) => void;
};

export function SandboxAccounts({
  connection,
  fundingAmount,
  disabled,
  create,
  fund,
}: SandboxAccountActions & {
  connection: SandboxStatus;
  fundingAmount: string;
  disabled: boolean;
}) {
  const selectedAccount = selectedSandboxAccount(connection);
  return (
    <div className="grid min-w-0 gap-4">
      {!connection.accounts.length && (
        <Empty className="py-4 md:p-4">
          <EmptyHeader>
            <EmptyTitle>Нет открытых виртуальных счетов.</EmptyTitle>
          </EmptyHeader>
        </Empty>
      )}
      {selectedAccount && (
        <p className="rounded-lg bg-muted px-3 py-2 text-sm wrap-anywhere" role="status">
          <span className="font-medium">Выбран счёт:</span> {selectedAccount.id}
        </p>
      )}
      {!selectedAccount && connection.accounts.length > 0 && (
        <p className="text-sm text-muted-foreground">
          Выберите счёт на панели робота, чтобы пополнить его.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant={selectedAccount ? 'outline' : 'default'}
          disabled={disabled}
          onClick={create}
        >
          Создать виртуальный счёт
        </Button>
        {selectedAccount && (
          <Button disabled={disabled} onClick={() => fund(selectedAccount.id)}>
            Пополнить на {fundingAmount}
          </Button>
        )}
      </div>
    </div>
  );
}
