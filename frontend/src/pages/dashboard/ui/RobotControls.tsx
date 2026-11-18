import { Alert, AlertTitle, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/ui';
import { robotApi, type Dashboard } from '../api/robot-api';
import { sandboxErrorMessage, sandboxMessageFor } from '@/entities/sandbox';

const modes: Record<Dashboard['mode'], string> = {
  stopped: 'Робот остановлен', starting: 'Робот запускается',
  running: 'Робот запущен', paused: 'Робот на паузе',
};

export function RobotControls({ dashboard }: { dashboard: Dashboard }) {
  const [command, { isLoading, error }] = robotApi.useRobotCommandMutation();
  const stopped = dashboard.mode === 'stopped';
  return (
    <Card role="region" aria-labelledby="robot-controls-title">
      <CardHeader>
        <CardTitle><h2 id="robot-controls-title">Управление роботом</h2></CardTitle>
        <CardDescription>Остановка не закрывает позицию.</CardDescription>
      </CardHeader>
      <CardContent className="grid justify-items-start gap-3">
        <Button disabled={isLoading} onClick={() => void command(stopped ? 'start' : 'stop')}>
          {stopped ? 'Запустить робота' : 'Остановить робота'}
        </Button>
        <div className="flex flex-wrap items-center gap-3" aria-live="polite">
          <Badge variant="outline">{modes[dashboard.mode]}</Badge>
          <span className="text-sm">Подтверждённая позиция: {dashboard.position ?? 'неизвестна'}</span>
        </div>
        {dashboard.reason && <Alert variant="destructive"><AlertTitle>{sandboxMessageFor(dashboard.reason)}</AlertTitle></Alert>}
        {error && <Alert variant="destructive"><AlertTitle>{sandboxErrorMessage(error)}</AlertTitle></Alert>}
      </CardContent>
    </Card>
  );
}
