import { useEffect, useState } from 'react';
import { useDispatch } from 'react-redux';
import { hasStatus, rootApi } from '@/shared/api';
import { sandboxApi, sandboxErrorMessage, saveSandboxToken } from '@/entities/sandbox';
import { SandboxAccountsCard } from './SandboxAccountsCard';
import { SandboxConnectionCard } from './SandboxConnectionCard';
import { DisplaySettingsCard } from './DisplaySettingsCard';
import type { SandboxNotice } from './SandboxFeedback';

const rubles = new Intl.NumberFormat('ru-RU', {
  style: 'currency',
  currency: 'RUB',
  maximumFractionDigits: 0,
});
type Notice = SandboxNotice & { section: 'connection' | 'accounts' };

export function SettingsPage({ refreshSession }: { refreshSession: () => void }) {
  const dispatch = useDispatch();
  const sandbox = sandboxApi.useSandboxQuery();
  const [createAccount] = sandboxApi.useCreateSandboxAccountMutation();
  const [fundAccount] = sandboxApi.useFundSandboxAccountMutation();
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  const connection = sandbox.data;
  const fundingAmount =
    connection?.status === 'connected' ? rubles.format(connection.virtualFundingRubles) : '';
  const disabled = pending || sandbox.isFetching;

  useEffect(() => {
    if (hasStatus(sandbox.error, 401)) refreshSession();
  }, [sandbox.error, refreshSession]);

  async function apply(
    section: Notice['section'],
    action: () => Promise<unknown>,
    success: string,
  ) {
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
    void apply(
      'connection',
      async () => {
        const problem = await saveSandboxToken(token);
        if (problem) throw problem;
        dispatch(rootApi.util.invalidateTags(['Sandbox', 'SandboxBalance', 'Dashboard']));
      },
      'Токен проверен и сохранён.',
    );
  }

  const sandboxState = {
    connection,
    isFetching: sandbox.isFetching,
    isError: sandbox.isError,
    disabled,
  };

  return (
    <div className="grid w-full min-w-0 max-w-5xl gap-6">
      <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Настройки</h1>
      <DisplaySettingsCard refreshSession={refreshSession} />
      <div className="grid items-start gap-4 md:grid-cols-2">
        <SandboxConnectionCard
          {...sandboxState}
          saveToken={submitToken}
          refresh={() => void sandbox.refetch()}
          notice={notice?.section === 'connection' ? notice : undefined}
        />
        <SandboxAccountsCard
          {...sandboxState}
          fundingAmount={fundingAmount}
          notice={notice?.section === 'accounts' ? notice : undefined}
          create={() =>
            void apply(
              'accounts',
              () => createAccount().unwrap(),
              'Виртуальный счёт создан и выбран.',
            )
          }
          fund={(id) =>
            void apply(
              'accounts',
              () => fundAccount(id).unwrap(),
              `Виртуальный счёт пополнен на ${fundingAmount}.`,
            )
          }
        />
      </div>
    </div>
  );
}
