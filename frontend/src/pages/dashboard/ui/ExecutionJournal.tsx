import { Alert, AlertTitle, Card, CardContent, CardHeader, CardTitle } from '@/shared/ui';
import { journalApi } from '../api/journal-api';
import { JournalOrder } from './JournalOrder';

export function ExecutionJournal() {
  const journal = journalApi.useJournalQuery(undefined, { refetchOnFocus: true, refetchOnReconnect: true });
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
