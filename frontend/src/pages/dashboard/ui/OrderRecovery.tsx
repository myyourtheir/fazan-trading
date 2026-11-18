import { skipToken } from '@reduxjs/toolkit/query/react';
import { Button } from '@/shared/ui';
import { journalApi } from '../api/journal-api';
import type { Dashboard } from '../api/robot-api';
import { brokerStatuses } from '../lib/order-labels';

export function OrderRecovery({ recovery, accountId, disabled, onReconcile, onResume }: {
  recovery: NonNullable<Dashboard['recovery']>;
  accountId: string | null;
  disabled: boolean;
  onReconcile: () => void;
  onResume: () => void;
}) {
  const { currentData } = journalApi.useJournalQuery(accountId ?? skipToken);
  const order = currentData?.find(({ id }) => id === recovery.orderId);
  return (
    <div className="grid w-full min-w-0 justify-items-start gap-2 text-sm" aria-live="polite">
      <span className="font-medium">Проблемная заявка</span>
      <span className="break-all text-muted-foreground">Клиентский ID: {recovery.orderId}</span>
      {order && <>
        <span>{order.ticker} · {order.direction === 'buy' ? 'Покупка' : 'Продажа'}, лотов: {order.lots}</span>
        <span>Статус брокера: {brokerStatuses[order.brokerStatus]}. Исполнено лотов: {order.executedLots ?? '—'}</span>
      </>}
      {recovery.ready && <span>Заявка и позиция сверены. Торговля не возобновится без вашей команды.</span>}
      <Button variant="outline" disabled={disabled} onClick={onReconcile}>Сверить заявку</Button>
      <Button disabled={disabled || !recovery.ready} onClick={onResume}>Возобновить торговлю</Button>
    </div>
  );
}
