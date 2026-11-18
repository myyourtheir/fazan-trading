import { sandboxApi, sandboxMessageFor, selectedSandboxAccount } from '@/entities/sandbox';
import { hasStatus } from '@/shared/api';
import { Alert, AlertTitle, Button, RecoveryCard, Spinner } from '@/shared/ui';
import { robotApi } from '../api/robot-api';
import { strategyApi } from '../api/strategy-api';
import { DashboardHeader } from './DashboardHeader';
import { ExecutionJournal } from './ExecutionJournal';
import { MarketChart } from './MarketChart';
import { RobotControls } from './RobotControls';
import { StrategySettings } from './StrategySettings';

export function DashboardPage({ dark, refreshSession }: { dark: boolean; refreshSession: () => void }) {
  const dashboard = robotApi.useDashboardQuery(undefined, { refetchOnFocus: true, refetchOnReconnect: true });
  const sandbox = sandboxApi.useSandboxQuery();
  const strategy = strategyApi.useStrategyQuery();
  const accountId = selectedSandboxAccount(sandbox.isError ? undefined : sandbox.currentData)?.id ?? null;
  const instrument = strategy.isError ? undefined : strategy.currentData?.settings?.instrument;
  const closeTarget = accountId && instrument && !sandbox.isFetching && !strategy.isFetching
    ? { accountId, instrumentUid: instrument.uid, ticker: instrument.ticker } : undefined;
  const robot = dashboard.isError ? undefined : dashboard.currentData;
  const settingsLock = robot?.recovery || robot?.reason === 'ROBOT_ORDER_UNRESOLVED' ? sandboxMessageFor('ROBOT_ORDER_UNRESOLVED')
    : robot && robot.mode !== 'stopped' ? 'Остановите робота, чтобы изменить счёт или стратегию.' : undefined;
  const settingsHint = settingsLock ?? (robot?.position
    ? 'Последняя сверка показала открытую позицию. Перед изменением настроек сервер снова проверит счёт.' : undefined);
  if (hasStatus(dashboard.error, 401)) {
    return <RecoveryCard message="Сессия истекла." action="Ко входу" onRetry={refreshSession} />;
  }
  return (
    <div className="grid w-full min-w-0 max-w-screen-2xl gap-6">
      <DashboardHeader refreshSession={refreshSession} settingsDisabled={Boolean(settingsLock)} settingsHint={settingsHint} />
      {dashboard.isLoading && <p role="status" className="flex items-center gap-2 text-sm">
        <Spinner aria-hidden="true" /> Загружаем состояние…
      </p>}
      {dashboard.isError && <div className="grid justify-items-start gap-3">
        <Alert variant="destructive"><AlertTitle>Не удалось загрузить состояние робота.</AlertTitle></Alert>
        <Button variant="outline" onClick={dashboard.refetch}>Повторить</Button>
      </div>}
      <div className="grid min-w-0 items-start gap-4 xl:grid-cols-[17rem_minmax(0,1fr)_19rem]">
        <div className="grid min-w-0 gap-4">
          {robot && <RobotControls dashboard={robot} closeTarget={closeTarget} accountId={accountId} />}
          <StrategySettings accountId={accountId} disabled={sandbox.isFetching || Boolean(settingsLock)}
            settingsHint={settingsHint} refreshSession={refreshSession} />
        </div>
        <MarketChart dark={dark} refreshSession={refreshSession} />
        <ExecutionJournal accountId={accountId} />
      </div>
    </div>
  );
}
