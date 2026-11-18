import { ChevronDown } from 'lucide-react';
import { Badge } from '@/shared/ui';
import type { JournalEntry } from '../api/journal-api';
import { brokerStatuses } from '../lib/order-labels';

const orderStatuses: Record<JournalEntry['status'], string> = {
  reserved: 'Намерение сохранено', confirmed: 'Позиция подтверждена', reconciled: 'Заявка и позиция сверены',
  unconfirmed: 'Требуется сверка', 'stopped-before-send': 'Робот остановлен до отправки',
  'feed-lost-before-send': 'Поток потерян до отправки',
  'account-check-failed-before-send': 'Счёт не прошёл проверку до отправки',
};
const date = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'UTC' });
const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 9 });
const formatTime = (time: number | null) => time === null ? '—' : `${date.format(time)} UTC`;
const formatPrice = (price: number | null) => price === null ? '—' : number.format(price);

export function JournalOrder({ order }: { order: JournalEntry }) {
  const direction = order.direction === 'buy' ? 'Покупка' : 'Продажа';
  const manual = order.action === 'manual-close';
  return (
    <article className="min-w-0 rounded-lg border text-sm">
      <details className="group">
        <summary className="flex cursor-pointer list-none items-start gap-2 rounded-lg p-3 hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
          <div className="grid min-w-0 flex-1 gap-1">
            <span className="text-xs text-muted-foreground">{formatTime(manual ? order.manualCloseTime : order.signalTime)}</span>
            <span className="font-semibold wrap-anywhere">{manual ? 'Ручное закрытие' : direction} · {order.ticker}</span>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Badge variant="outline" className="h-auto text-wrap">{orderStatuses[order.status]}</Badge>
              <span className="text-xs text-muted-foreground">Исполнено лотов: {order.executedLots ?? '—'}</span>
            </div>
          </div>
          <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground group-open:rotate-180" />
        </summary>
        <div className="grid gap-3 border-t p-3">
          {!manual && <section className="grid content-start gap-1">
            <h3 className="font-medium">Сигнал</h3>
            <span>Закрытие: {formatTime(order.signalTime)}</span>
            <span>Цена сигнала: {formatPrice(order.signalPrice)}</span>
            <span>EMA: {formatPrice(order.ema)}</span>
          </section>}
          <section className="grid min-w-0 content-start gap-1">
            <h3 className="font-medium">Заявка</h3>
            <span>{direction} по рынку, лотов: {order.lots}</span>
            <span>Позиция: {order.fromPosition} → {order.targetPosition}; факт: {order.position ?? '—'}</span>
            <span>Статус брокера: {brokerStatuses[order.brokerStatus]}</span>
            <span className="break-all text-muted-foreground">ID: {order.id}</span>
          </section>
          <section className="grid content-start gap-1">
            <h3 className="font-medium">Исполнения</h3>
            {order.executions.length === 0
              ? <span className="text-muted-foreground">Нет подтверждённых исполнений.</span>
              : <ul className="space-y-2">{order.executions.map((fill, index) => (
                <li key={`${fill.tradeId}-${index}`}>
                  <div>Лотов: {fill.lots}; цена сделки: {formatPrice(fill.price)}</div>
                  <div className="text-muted-foreground">{formatTime(fill.time)}</div>
                </li>
              ))}</ul>}
          </section>
        </div>
      </details>
    </article>
  );
}
