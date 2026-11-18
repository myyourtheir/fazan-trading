import { useEffect, useState, type FormEvent } from 'react';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Empty, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Separator } from '@/components/ui/separator';
import { api, hasStatus, saveSandboxToken, type SandboxStatus } from './api';
import { useAppDispatch } from './store';

const errors: Record<string, string> = {
  SANDBOX_TOKEN_REJECTED: 'Песочница отклонила токен. Проверьте, что токен действителен и даёт доступ к песочнице.',
  SANDBOX_UNREACHABLE: 'Не удалось связаться с песочницей. Попробуйте позже.',
  SANDBOX_TOKEN_UNREADABLE: 'Не удалось прочитать сохранённый токен. Проверьте ключ сервера или введите токен заново.',
  SANDBOX_ACCOUNT_UNAVAILABLE: 'Счёт недоступен или больше не выбран. Обновите список счетов.',
  SANDBOX_OPERATION_REJECTED: 'Песочница отклонила операцию. Проверьте состояние счёта в песочнице.',
  SANDBOX_BUSY: 'Другое изменение ещё выполняется. Попробуйте позже.',
  SANDBOX_NOT_CONFIGURED: 'Сначала подключите песочницу.',
  SANDBOX_CREATION_UNCERTAIN: 'Создание счёта не подтверждено. Обновите список счетов перед повторной попыткой.',
  SANDBOX_FUNDING_UNCERTAIN: 'Пополнение не подтверждено. Проверьте баланс в песочнице перед повторной попыткой.',
  INVALID_REQUEST: 'Проверьте введённые данные.',
};

function messageFor(code: string) {
  return Object.hasOwn(errors, code) ? errors[code] : 'Не удалось выполнить запрос. Попробуйте позже.';
}

function errorMessage(error: unknown) {
  const data = typeof error === 'object' && error && 'data' in error ? error.data : null;
  return messageFor(typeof data === 'object' && data && 'code' in data && typeof data.code === 'string' ? data.code : '');
}

const rubles = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 });

function Accounts({ connection, fundingAmount, disabled, select, create, fund }: {
  connection: SandboxStatus;
  fundingAmount: string;
  disabled: boolean;
  select: (accountId: string) => void;
  create: () => void;
  fund: (accountId: string) => void;
}) {
  const { accounts, accountId } = connection;
  const selectedAccount = accounts.find(account => account.id === accountId);
  const [choice, setChoice] = useState(accountId ?? '');
  return (
    <div className="flex flex-col items-start gap-3">
      {accountId && !selectedAccount && <Alert variant="destructive">
        <AlertTitle>Сохранённый счёт ({accountId}) недоступен. Выберите другой счёт.</AlertTitle>
      </Alert>}
      {accounts.length > 0 && <form className="flex w-full flex-col items-start gap-2" onSubmit={event => {
        event.preventDefault();
        select(choice);
      }}>
        <FieldGroup>
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
      {selectedAccount && <p className="text-sm" role="status">Выбран счёт: {selectedAccount.id}</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={disabled} onClick={create}>Создать виртуальный счёт</Button>
        {selectedAccount && <Button variant="outline" disabled={disabled} onClick={() => fund(selectedAccount.id)}>
          Пополнить на {fundingAmount}
        </Button>}
      </div>
    </div>
  );
}

export function SandboxSettings({ refreshSession }: { refreshSession: () => void }) {
  const dispatch = useAppDispatch();
  const sandbox = api.useSandboxQuery();
  const [selectAccount] = api.useSelectSandboxAccountMutation();
  const [createAccount] = api.useCreateSandboxAccountMutation();
  const [fundAccount] = api.useFundSandboxAccountMutation();
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; text: string }>();
  const connection = sandbox.data;
  const fundingAmount = connection?.status === 'connected' ? rubles.format(connection.virtualFundingRubles) : '';
  const disabled = pending || sandbox.isFetching;

  useEffect(() => {
    if (hasStatus(sandbox.error, 401)) refreshSession();
  }, [sandbox.error, refreshSession]);

  async function apply(action: () => Promise<unknown>, success: string) {
    setPending(true);
    setNotice(undefined);
    try {
      await action();
      setNotice({ kind: 'success', text: success });
    } catch (error) {
      if (hasStatus(error, 401)) refreshSession();
      else setNotice({ kind: 'error', text: errorMessage(error) });
    } finally {
      setPending(false);
    }
  }

  function submitToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = String(new FormData(event.currentTarget).get('token') ?? '').trim();
    event.currentTarget.reset();
    void apply(async () => {
      const problem = await saveSandboxToken(token);
      if (problem) throw problem;
      dispatch(api.util.invalidateTags(['Sandbox']));
    }, 'Токен проверен и сохранён.');
  }

  return (
    <section aria-labelledby="sandbox-title" className="flex w-full min-w-0 flex-col gap-3">
      <Separator />
      <h2 id="sandbox-title" className="font-semibold">Песочница Т‑Инвестиций</h2>
      {sandbox.isFetching && <p role="status" className="text-sm">Проверяем подключение…</p>}
      {sandbox.isError ? <Alert variant="destructive"><AlertTitle>Не удалось загрузить подключение.</AlertTitle></Alert>
        : connection?.status === 'unavailable' ? <Alert variant="destructive">
          <AlertTitle>{messageFor(connection.code)}</AlertTitle>
        </Alert>
        : connection && <p className="text-sm" role="status">
          {connection.status === 'connected' ? 'Песочница подключена.' : 'Песочница не подключена.'}
        </p>}
      {connection?.status === 'unavailable' && connection.accountId && <p className="text-sm text-muted-foreground">
        Сохранённый счёт: {connection.accountId}
      </p>}
      <form className="flex flex-col items-start gap-2" autoComplete="off" onSubmit={submitToken}>
        <FieldGroup>
          <Field data-disabled={disabled || undefined}>
            <FieldLabel htmlFor="sandbox-token">Токен песочницы</FieldLabel>
            <Input id="sandbox-token" name="token" type="password" autoComplete="off" spellCheck={false}
              required maxLength={2048} disabled={disabled} />
          </Field>
        </FieldGroup>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={disabled}>Проверить и сохранить</Button>
          <Button type="button" variant="outline" disabled={disabled} onClick={() => void sandbox.refetch()}>
            Обновить подключение и счета
          </Button>
        </div>
      </form>
      {connection?.status === 'connected' && !sandbox.isError && <Accounts key={connection.accountId}
        connection={connection} fundingAmount={fundingAmount} disabled={disabled}
        select={id => void apply(() => selectAccount(id).unwrap(), 'Счёт выбран.')}
        create={() => void apply(() => createAccount().unwrap(), 'Виртуальный счёт создан и выбран.')}
        fund={id => void apply(() => fundAccount(id).unwrap(), `Виртуальный счёт пополнен на ${fundingAmount}.`)} />}
      {notice?.kind === 'error' && <Alert variant="destructive"><AlertTitle>{notice.text}</AlertTitle></Alert>}
      {notice?.kind === 'success' && <p role="status" className="text-sm">{notice.text}</p>}
    </section>
  );
}
