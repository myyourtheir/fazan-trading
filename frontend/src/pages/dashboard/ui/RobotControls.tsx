import { Alert, AlertTitle, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/ui';
import { robotApi, type Dashboard } from '../api/robot-api';
import { sandboxErrorMessage, sandboxMessageFor } from '@/entities/sandbox';
import { ClosePositionDialog, type CloseTarget } from './ClosePositionDialog';
import { OrderRecovery } from './OrderRecovery';

const modes: Record<Dashboard['mode'], string> = {
  stopped: 'Робот остановлен', starting: 'Робот запускается',
  running: 'Робот запущен', paused: 'Робот на паузе',
};

export function RobotControls({ dashboard, closeTarget, accountId }: {
  dashboard: Dashboard; closeTarget?: CloseTarget; accountId: string | null;
}) {
  const [command, { isLoading, error }] = robotApi.useRobotCommandMutation();
  const stopped = dashboard.mode === 'stopped';
  const recovery = dashboard.recovery;
  return (
    <Card role="region" aria-labelledby="robot-controls-title">
      <CardHeader>
        <CardTitle><h2 id="robot-controls-title">Управление роботом</h2></CardTitle>
        <CardDescription>Остановка не закрывает позицию.</CardDescription>
      </CardHeader>
      <CardContent className="grid justify-items-start gap-3">
        {(!stopped || !recovery || recovery.ready) &&
          <Button disabled={isLoading && dashboard.mode !== 'starting'}
            onClick={() => void command(stopped && !recovery ? 'start' : 'stop')}>
            {stopped ? recovery ? 'Оставить робота остановленным' : 'Запустить робота' : 'Остановить робота'}
          </Button>}
        {stopped && !recovery && closeTarget && <ClosePositionDialog
          key={JSON.stringify([closeTarget.accountId, closeTarget.instrumentUid])} target={closeTarget}
          disabled={isLoading || dashboard.reason === 'ROBOT_ORDER_UNRESOLVED'}
          close={selection => void command(selection)}
        />}
        <div className="flex flex-wrap items-center gap-3" aria-live="polite">
          <Badge variant="outline">{modes[dashboard.mode]}</Badge>
          <span className="text-sm">Подтверждённая позиция: {dashboard.position ?? 'неизвестна'}</span>
        </div>
        {dashboard.reason && <Alert variant="destructive"><AlertTitle>{sandboxMessageFor(dashboard.reason)}</AlertTitle></Alert>}
        {recovery && <OrderRecovery recovery={recovery} accountId={accountId}
          disabled={isLoading || (!stopped && dashboard.mode !== 'paused')}
          onReconcile={() => void command('reconcile')} onResume={() => void command('resume')} />}
        {error && <Alert variant="destructive"><AlertTitle>{sandboxErrorMessage(error)}</AlertTitle></Alert>}
      </CardContent>
    </Card>
  );
}
