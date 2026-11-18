import { Alert, AlertTitle, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/ui';
import { robotApi, type Dashboard } from '../api/robot-api';
import { sandboxErrorMessage, sandboxMessageFor } from '../lib/sandbox-errors';

const modes: Record<Dashboard['mode'], string> = {
  stopped: 'Робот остановлен', starting: 'Робот запускается',
  running: 'Робот запущен', paused: 'Робот на паузе',
};

export function RobotControls({ dashboard }: { dashboard: Dashboard }) {
  const [command, { isLoading, error }] = robotApi.useRobotCommandMutation();
  const stopped = dashboard.mode === 'stopped';
  return (
    <Card>
      <CardHeader>
        <CardTitle>Управление роботом</CardTitle>
        <CardDescription>Робот открывает первую позицию по подтверждённому пересечению EMA. Остановка не закрывает позицию.</CardDescription>
      </CardHeader>
      <CardContent className="grid justify-items-start gap-3">
        <div className="flex flex-wrap items-center gap-3" aria-live="polite">
          <Badge variant="outline">{modes[dashboard.mode]}</Badge>
          <span className="text-sm">Подтверждённая позиция: {dashboard.position ?? 'неизвестна'}</span>
        </div>
        {dashboard.reason && <Alert variant="destructive"><AlertTitle>{sandboxMessageFor(dashboard.reason)}</AlertTitle></Alert>}
        {error && <Alert variant="destructive"><AlertTitle>{sandboxErrorMessage(error)}</AlertTitle></Alert>}
        <Button disabled={isLoading} onClick={() => void command(stopped ? 'start' : 'stop')}>
          {stopped ? 'Запустить робота' : 'Остановить робота'}
        </Button>
      </CardContent>
    </Card>
  );
}
