import { useCallback, useEffect, useLayoutEffect, useState, type FormEvent } from 'react';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { api, hasStatus } from './api';
import { SandboxSettings } from './SandboxSettings';
import { toggleTheme, useAppDispatch, useAppSelector } from './store';

function Login() {
  const [password, setPassword] = useState('');
  const [login, { isLoading, error }] = api.useLoginMutation();
  const invalidPassword = hasStatus(error, 401);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if ((await login(password)).data) setPassword('');
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <Badge variant="secondary" className="justify-self-start">Панель владельца</Badge>
        <CardTitle><h1>Вход в «Сёрфинг»</h1></CardTitle>
        <CardDescription>Введите пароль, чтобы открыть панель управления.</CardDescription>
      </CardHeader>
      <CardContent>
        <form id="owner-login" onSubmit={submit}>
          <FieldGroup>
            <Field data-invalid={invalidPassword || undefined}>
              <FieldLabel htmlFor="password">Пароль</FieldLabel>
              <Input id="password" type="password" autoComplete="current-password" required maxLength={256}
                value={password} onChange={event => setPassword(event.target.value)}
                aria-invalid={invalidPassword || undefined}
                aria-describedby={invalidPassword ? 'password-error' : undefined} />
              {invalidPassword && <FieldError id="password-error">Неверный пароль.</FieldError>}
            </Field>
            {error && !invalidPassword && <Alert variant="destructive">
              <AlertTitle>{hasStatus(error, 429)
                ? 'Слишком много попыток. Подождите минуту.' : 'Не удалось войти. Попробуйте ещё раз.'}</AlertTitle>
            </Alert>}
          </FieldGroup>
        </form>
      </CardContent>
      <CardFooter>
        <Button type="submit" form="owner-login" disabled={isLoading} className="w-full">
          {isLoading && <Spinner aria-hidden="true" data-icon="inline-start" />}
          {isLoading ? 'Входим…' : 'Войти'}
        </Button>
      </CardFooter>
    </Card>
  );
}

function RecoveryCard({ message, action, onRetry }: { message: string; action: string; onRetry: () => void }) {
  return (
    <Card className="w-full max-w-md">
      <CardContent><Alert variant="destructive"><AlertTitle>{message}</AlertTitle></Alert></CardContent>
      <CardFooter><Button onClick={onRetry}>{action}</Button></CardFooter>
    </Card>
  );
}

function Dashboard({ refreshSession }: { refreshSession: () => void }) {
  const dashboard = api.useDashboardQuery();
  const [logout, { isLoading, error }] = api.useLogoutMutation();
  if (hasStatus(dashboard.error, 401)) {
    return <RecoveryCard message="Сессия истекла." action="Ко входу" onRetry={refreshSession} />;
  }
  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <Badge variant="secondary" className="justify-self-start">Песочница</Badge>
        <CardTitle><h1>Панель робота</h1></CardTitle>
        <CardDescription>Настройте подключение к песочнице. Торговые команды пока недоступны.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col items-start gap-3">
        {dashboard.isLoading && <p role="status" className="flex items-center gap-2">
          <Spinner aria-hidden="true" /> Загружаем состояние…
        </p>}
        {dashboard.isError && <Alert variant="destructive"><AlertTitle>Не удалось загрузить состояние робота.</AlertTitle></Alert>}
        {dashboard.isError && <Button variant="outline" onClick={dashboard.refetch}>Повторить</Button>}
        {dashboard.data?.mode === 'stopped' && <Badge variant="outline">Робот остановлен</Badge>}
        {dashboard.data && <SandboxSettings refreshSession={refreshSession} />}
        {error && <Alert variant="destructive"><AlertTitle>Не удалось завершить сессию. Попробуйте ещё раз.</AlertTitle></Alert>}
      </CardContent>
      <CardFooter>
        <Button variant="outline" onClick={() => void logout()} disabled={isLoading}>
          {isLoading && <Spinner aria-hidden="true" data-icon="inline-start" />}
          Выйти
        </Button>
      </CardFooter>
    </Card>
  );
}

export function App() {
  const dark = useAppSelector(state => state.ui.dark);
  const dispatch = useAppDispatch();
  const session = api.useSessionQuery(undefined, { refetchOnFocus: true, refetchOnReconnect: true });
  const [expiredCheck, setExpiredCheck] = useState<number>();
  const { data, fulfilledTimeStamp, refetch } = session;
  const refreshSession = useCallback(() => { void refetch(); }, [refetch]);
  useLayoutEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
  }, [dark]);
  useEffect(() => {
    if (!data || fulfilledTimeStamp === undefined) return;
    const timer = window.setTimeout(() => {
      setExpiredCheck(fulfilledTimeStamp);
      void refetch();
    }, Math.max(0, fulfilledTimeStamp + data.remainingMs - Date.now()));
    return () => window.clearTimeout(timer);
  }, [data, fulfilledTimeStamp, refetch]);
  return (
    <div className="min-h-dvh">
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-8 lg:px-16">
        <span className="text-lg font-extrabold">Сёрфинг</span>
        <Button variant="outline" onClick={() => dispatch(toggleTheme())}>
          {dark ? 'Светлая тема' : 'Тёмная тема'}
        </Button>
      </header>
      <main className="grid justify-items-center px-4 py-[clamp(2rem,9vh,6rem)]">
        {session.isLoading || (expiredCheck !== undefined && expiredCheck === fulfilledTimeStamp && !session.isError)
          ? <p role="status" className="flex items-center gap-2"><Spinner aria-hidden="true" /> Проверяем сессию…</p>
          : hasStatus(session.error, 401) ? <Login />
          : session.isError ? <RecoveryCard message="Сервер недоступен." action="Повторить" onRetry={refetch} />
          : data?.authenticated ? <Dashboard refreshSession={refreshSession} /> : null}
      </main>
    </div>
  );
}
