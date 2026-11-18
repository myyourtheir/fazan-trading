import { KeyRound } from 'lucide-react';
import {
  Alert, AlertTitle, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle,
  Field, FieldGroup, FieldLabel, Input,
} from '@/shared/ui';
import type { SandboxStatus } from '../api/sandbox-api';
import { sandboxMessageFor } from '../lib/sandbox-errors';
import { SandboxFeedback, type SandboxNotice } from './SandboxFeedback';

type Props = {
  connection?: SandboxStatus;
  isFetching: boolean;
  isError: boolean;
  disabled: boolean;
  notice?: SandboxNotice;
  refresh: () => void;
  saveToken: (token: string) => void;
};

export function SandboxConnectionCard({ connection, isFetching, isError, disabled, notice, refresh, saveToken }: Props) {
  return (
    <Card role="region" aria-labelledby="sandbox-connection-title" className="min-w-0 [--card-spacing:--spacing(5)]">
      <CardHeader>
        <CardTitle><h2 id="sandbox-connection-title" className="flex items-center gap-2 font-semibold">
          <KeyRound aria-hidden="true" className="size-4 text-primary" /> Подключение
        </h2></CardTitle>
        <CardDescription>Токен для доступа к песочнице Т‑Инвестиций.</CardDescription>
      </CardHeader>
      <CardContent className="grid justify-items-start gap-4">
        {isFetching ? <Badge role="status" variant="secondary">Проверяем подключение…</Badge>
          : isError ? <Alert variant="destructive"><AlertTitle>Не удалось загрузить подключение.</AlertTitle></Alert>
          : connection?.status === 'unavailable' ? <Alert variant="destructive">
            <AlertTitle>{sandboxMessageFor(connection.code)}</AlertTitle>
          </Alert>
          : connection && <Badge role="status" variant="secondary"
            className={connection.status === 'connected' ? 'bg-primary/10 text-primary' : undefined}>
            {connection.status === 'connected' ? 'Песочница подключена.' : 'Песочница не подключена.'}
          </Badge>}
        <form className="grid w-full gap-3" autoComplete="off" onSubmit={event => {
          event.preventDefault();
          const token = String(new FormData(event.currentTarget).get('token') ?? '').trim();
          event.currentTarget.reset();
          saveToken(token);
        }}>
          <FieldGroup>
            <Field data-disabled={disabled || undefined}>
              <FieldLabel htmlFor="sandbox-token">Токен песочницы</FieldLabel>
              <Input id="sandbox-token" name="token" type="password" autoComplete="off" spellCheck={false}
                required maxLength={2048} disabled={disabled} />
            </Field>
          </FieldGroup>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={disabled}>Проверить и сохранить</Button>
            <Button type="button" variant="outline" disabled={disabled} onClick={refresh}>Обновить статус</Button>
          </div>
        </form>
        <SandboxFeedback notice={notice} />
      </CardContent>
    </Card>
  );
}
