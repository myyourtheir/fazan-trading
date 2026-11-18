import { Badge } from '@/shared/ui';
import { SandboxAccountSelector } from './SandboxAccountSelector';

export function DashboardHeader({ refreshSession, settingsDisabled, settingsHint }: {
  refreshSession: () => void; settingsDisabled: boolean; settingsHint?: string;
}) {
  return (
    <header className="flex min-w-0 flex-wrap items-start justify-between gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Панель робота</h1>
        <Badge variant="secondary">Песочница</Badge>
      </div>
      <SandboxAccountSelector refreshSession={refreshSession} disabled={settingsDisabled} settingsHint={settingsHint} />
    </header>
  );
}
