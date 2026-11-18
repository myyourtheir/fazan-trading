import { skipToken } from '@reduxjs/toolkit/query/react';
import { Alert, AlertTitle, Card, CardContent, CardHeader, CardTitle } from '@/shared/ui';
import { journalApi } from '../api/journal-api';
import { JournalOrder } from './JournalOrder';

export function ExecutionJournal({ accountId }: { accountId: string | null }) {
  const journal = journalApi.useJournalQuery(accountId ?? skipToken, { refetchOnFocus: true, refetchOnReconnect: true });
  return (
    <Card role="region" aria-labelledby="journal-title" className="min-w-0">
      <CardHeader><CardTitle><h2 id="journal-title">Журнал заявок и исполнений</h2></CardTitle></CardHeader>
      <CardContent className="grid gap-3">
        {!accountId && <p className="text-sm text-muted-foreground">Выберите счёт, чтобы увидеть журнал.</p>}
        {accountId && journal.isFetching && !journal.currentData && <p role="status">Загружаем журнал…</p>}
        {journal.isError && <Alert variant="destructive"><AlertTitle>Не удалось загрузить журнал.</AlertTitle></Alert>}
        {journal.currentData?.length === 0 && <p className="text-sm text-muted-foreground">Заявок пока нет.</p>}
        {journal.currentData?.map(order => <JournalOrder key={order.id} order={order} />)}
      </CardContent>
    </Card>
  );
}
