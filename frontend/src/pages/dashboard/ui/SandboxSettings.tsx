import { useEffect, useState } from 'react';
import { useDispatch } from 'react-redux';
import { hasStatus, rootApi } from '@/shared/api';
import { sandboxApi, saveSandboxToken } from '../api/sandbox-api';
import { sandboxErrorMessage } from '../lib/sandbox-errors';
import { SandboxAccountsCard } from './SandboxAccountsCard';
import { SandboxConnectionCard } from './SandboxConnectionCard';
import type { SandboxNotice } from './SandboxFeedback';
import { StrategySettings } from './StrategySettings';

const rubles = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 });
type Notice = SandboxNotice & { section: 'connection' | 'accounts' };

export function SandboxSettings({ refreshSession }: { refreshSession: () => void }) {
  const dispatch = useDispatch();
  const sandbox = sandboxApi.useSandboxQuery();
  const [selectAccount] = sandboxApi.useSelectSandboxAccountMutation();
  const [createAccount] = sandboxApi.useCreateSandboxAccountMutation();
  const [fundAccount] = sandboxApi.useFundSandboxAccountMutation();
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  const connection = sandbox.data;
  const fundingAmount = connection?.status === 'connected' ? rubles.format(connection.virtualFundingRubles) : '';
  const disabled = pending || sandbox.isFetching;
  const selectedAccountId = !sandbox.isError && connection?.status === 'connected'
    && connection.accounts.some(account => account.id === connection.accountId) ? connection.accountId : null;

  useEffect(() => {
    if (hasStatus(sandbox.error, 401)) refreshSession();
  }, [sandbox.error, refreshSession]);

  async function apply(section: Notice['section'], action: () => Promise<unknown>, success: string) {
    setPending(true);
    setNotice(undefined);
    try {
      await action();
      setNotice({ kind: 'success', text: success, section });
    } catch (error) {
      if (hasStatus(error, 401)) refreshSession();
      else setNotice({ kind: 'error', text: sandboxErrorMessage(error), section });
    } finally {
      setPending(false);
    }
  }

  function submitToken(token: string) {
    void apply('connection', async () => {
      const problem = await saveSandboxToken(token);
      if (problem) throw problem;
      dispatch(rootApi.util.invalidateTags(['Sandbox']));
    }, 'Токен проверен и сохранён.');
  }

  const sandboxState = { connection, isFetching: sandbox.isFetching, isError: sandbox.isError, disabled };

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <SandboxConnectionCard {...sandboxState} saveToken={submitToken} refresh={() => void sandbox.refetch()}
        notice={notice?.section === 'connection' ? notice : undefined} />
      <SandboxAccountsCard {...sandboxState} fundingAmount={fundingAmount}
        notice={notice?.section === 'accounts' ? notice : undefined}
        select={id => void apply('accounts', () => selectAccount(id).unwrap(), 'Счёт выбран.')}
        create={() => void apply('accounts', () => createAccount().unwrap(), 'Виртуальный счёт создан и выбран.')}
        fund={id => void apply('accounts', () => fundAccount(id).unwrap(), `Виртуальный счёт пополнен на ${fundingAmount}.`)} />
      <StrategySettings accountId={selectedAccountId} disabled={disabled} refreshSession={refreshSession} />
    </div>
  );
}
