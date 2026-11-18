import { skipToken } from '@reduxjs/toolkit/query/react';
import { Alert, AlertTitle, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/ui';
import { journalApi } from '../api/journal-api';
import { robotApi, type Dashboard } from '../api/robot-api';
import { sandboxErrorMessage, sandboxMessageFor } from '@/entities/sandbox';
import { ClosePositionDialog, type CloseTarget } from './ClosePositionDialog';
import { brokerStatuses } from '../lib/order-labels';

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
  const { currentData } = journalApi.useJournalQuery(recovery && accountId ? accountId : skipToken);
  const order = currentData?.find(({ id }) => id === recovery?.orderId);
  const canReconcile = stopped || dashboard.mode === 'paused';
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
        {recovery && <div className="grid w-full min-w-0 justify-items-start gap-2 text-sm" aria-live="polite">
          <span className="font-medium">Проблемная заявка</span>
          <span className="break-all text-muted-foreground">Клиентский ID: {recovery.orderId}</span>
          {order && <>
            <span>{order.ticker} · {order.direction === 'buy' ? 'Покупка' : 'Продажа'}, лотов: {order.lots}</span>
            <span>Статус брокера: {brokerStatuses[order.brokerStatus]}. Исполнено лотов: {order.executedLots ?? '—'}</span>
          </>}
          {recovery.ready && <span>Заявка и позиция сверены. Торговля не возобновится без вашей команды.</span>}
          <Button variant="outline" disabled={isLoading || !canReconcile} onClick={() => void command('reconcile')}>
            Сверить заявку
          </Button>
          <Button disabled={isLoading || !canReconcile || !recovery.ready} onClick={() => void command('resume')}>
            Возобновить торговлю
          </Button>
        </div>}
        {error && <Alert variant="destructive"><AlertTitle>{sandboxErrorMessage(error)}</AlertTitle></Alert>}
      </CardContent>
    </Card>
  );
}
