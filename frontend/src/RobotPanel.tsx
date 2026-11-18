import { Alert, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api, type Dashboard, type JournalEntry } from './api';
import { sandboxErrorMessage, sandboxMessageFor } from './sandbox-errors';

const modes: Record<Dashboard['mode'], string> = {
  stopped: 'Робот остановлен', starting: 'Робот запускается',
  running: 'Робот запущен', paused: 'Робот на паузе',
};

export function RobotControls({ dashboard }: { dashboard: Dashboard }) {
  const [command, { isLoading, error }] = api.useRobotCommandMutation();
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

const orderStatuses: Record<JournalEntry['status'], string> = {
  reserved: 'Намерение сохранено', confirmed: 'Позиция подтверждена',
  unconfirmed: 'Требуется сверка', 'not-sent': 'Не отправлена',
};
const brokerStatuses: Record<JournalEntry['brokerStatus'], string> = {
  filled: 'Исполнена', rejected: 'Отклонена', cancelled: 'Отменена',
  new: 'Принята', partial: 'Частично исполнена', unknown: 'Неизвестен',
};
const date = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'UTC' });
const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 9 });
const formatTime = (time: number | null) => time === null ? '—' : `${date.format(time)} UTC`;
const formatPrice = (price: number | null) => price === null ? '—' : number.format(price);

function JournalOrder({ order }: { order: JournalEntry }) {
  return (
    <article className="grid gap-3 rounded-lg border p-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold">{order.ticker}</h3>
        <Badge variant="outline">{orderStatuses[order.status]}</Badge>
        <span className="break-all text-muted-foreground">Счёт: {order.accountId}</span>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <section className="grid content-start gap-1">
          <h4 className="font-medium">Сигнал</h4>
          <span>Закрытие: {formatTime(order.signalTime)}</span>
          <span>Цена сигнала: {formatPrice(order.signalPrice)}</span>
          <span>EMA: {formatPrice(order.ema)}</span>
        </section>
        <section className="grid min-w-0 content-start gap-1">
          <h4 className="font-medium">Заявка</h4>
          <span>{order.direction === 'buy' ? 'Покупка' : 'Продажа'} по рынку, лотов: {order.lots}</span>
          <span>Позиция: {order.fromPosition} → {order.targetPosition}; факт: {order.position ?? '—'}</span>
          <span>Статус брокера: {brokerStatuses[order.brokerStatus]}</span>
          <span className="break-all text-muted-foreground">ID: {order.id}</span>
        </section>
        <section className="grid content-start gap-1">
          <h4 className="font-medium">Исполнения</h4>
          <span>Исполнено лотов: {order.executedLots ?? '—'}</span>
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
    </article>
  );
}

export function ExecutionJournal() {
  const journal = api.useJournalQuery(undefined, { refetchOnFocus: true, refetchOnReconnect: true });
  return (
    <Card>
      <CardHeader><CardTitle>Журнал заявок и исполнений</CardTitle></CardHeader>
      <CardContent className="grid gap-3">
        {journal.isLoading && <p role="status">Загружаем журнал…</p>}
        {journal.isError && <Alert variant="destructive"><AlertTitle>Не удалось загрузить журнал.</AlertTitle></Alert>}
        {journal.data?.length === 0 && <p className="text-sm text-muted-foreground">Заявок пока нет.</p>}
        {journal.data?.map(order => <JournalOrder key={order.id} order={order} />)}
      </CardContent>
    </Card>
  );
}
