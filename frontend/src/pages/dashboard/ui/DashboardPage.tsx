import { hasStatus, sessionApi } from '@/shared/api';
import { Alert, AlertTitle, Button, RecoveryCard, Spinner } from '@/shared/ui';
import { robotApi } from '../api/robot-api';
import { DashboardHeader } from './DashboardHeader';
import { ExecutionJournal } from './ExecutionJournal';
import { MarketChart } from './MarketChart';
import { RobotControls } from './RobotControls';
import { SandboxSettings } from './SandboxSettings';

export function DashboardPage({ dark, refreshSession }: { dark: boolean; refreshSession: () => void }) {
  const dashboard = robotApi.useDashboardQuery(undefined, { refetchOnFocus: true, refetchOnReconnect: true });
  const [logout, { isLoading: isLoggingOut, error: logoutError }] = sessionApi.useLogoutMutation();
  if (hasStatus(dashboard.error, 401)) {
    return <RecoveryCard message="Сессия истекла." action="Ко входу" onRetry={refreshSession} />;
  }
  return (
    <div className="grid w-full min-w-0 max-w-5xl gap-6">
      <DashboardHeader logout={() => void logout()} isLoggingOut={isLoggingOut} />
      {dashboard.isLoading && <p role="status" className="flex items-center gap-2 text-sm">
        <Spinner aria-hidden="true" /> Загружаем состояние…
      </p>}
      {dashboard.isError && <div className="grid justify-items-start gap-3">
        <Alert variant="destructive"><AlertTitle>Не удалось загрузить состояние робота.</AlertTitle></Alert>
        <Button variant="outline" onClick={dashboard.refetch}>Повторить</Button>
      </div>}
      {logoutError && <Alert variant="destructive"><AlertTitle>Не удалось завершить сессию. Попробуйте ещё раз.</AlertTitle></Alert>}
      {dashboard.data && <RobotControls dashboard={dashboard.data} />}
      {dashboard.data && <SandboxSettings refreshSession={refreshSession} />}
      {dashboard.data && <MarketChart dark={dark} refreshSession={refreshSession} />}
      {dashboard.data && <ExecutionJournal />}
    </div>
  );
}
