import { useEffect, useState, type FormEvent } from 'react';
import { api } from './api';
import { toggleTheme, useAppDispatch, useAppSelector } from './store';

function hasStatus(error: unknown, status: number) {
  return typeof error === 'object' && error !== null && 'status' in error && error.status === status;
}

function Login() {
  const [password, setPassword] = useState('');
  const [login, { isLoading, error }] = api.useLoginMutation();
  async function submit(event: FormEvent) {
    event.preventDefault();
    if ((await login(password)).data) setPassword('');
  }

  return (
    <section className="card" aria-labelledby="login-title">
      <span className="eyebrow">Панель владельца</span>
      <h1 id="login-title">Вход в «Сёрфинг»</h1>
      <p className="muted">Введите пароль, чтобы открыть панель управления.</p>
      <form onSubmit={submit}>
        <label htmlFor="password">Пароль</label>
        <input id="password" type="password" autoComplete="current-password" required maxLength={256}
          value={password} onChange={event => setPassword(event.target.value)} />
        {error && <p role="alert">
          {hasStatus(error, 401) ? 'Неверный пароль.' : hasStatus(error, 429)
            ? 'Слишком много попыток. Подождите минуту.' : 'Не удалось войти. Попробуйте ещё раз.'}
        </p>}
        <button type="submit" disabled={isLoading}>{isLoading ? 'Входим…' : 'Войти'}</button>
      </form>
    </section>
  );
}

function Dashboard({ refreshSession }: { refreshSession: () => void }) {
  const dashboard = api.useDashboardQuery();
  const [logout, { isLoading, error }] = api.useLogoutMutation();
  if (hasStatus(dashboard.error, 401)) {
    return <section className="card"><p role="alert">Сессия истекла.</p><button onClick={refreshSession}>Ко входу</button></section>;
  }
  return (
    <section className="card" aria-labelledby="dashboard-title">
      <span className="eyebrow">Песочница</span>
      <h1 id="dashboard-title">Панель робота</h1>
      {dashboard.isLoading && <p role="status">Загружаем состояние…</p>}
      {dashboard.isError && <p role="alert">Не удалось загрузить состояние робота.</p>}
      {dashboard.isError && <button className="secondary" onClick={dashboard.refetch}>Повторить</button>}
      {dashboard.data?.mode === 'stopped' && <p className="status"><span aria-hidden="true" /> Робот остановлен</p>}
      <p className="muted">Подключение брокера и торговые команды пока недоступны.</p>
      {error && <p role="alert">Не удалось завершить сессию. Попробуйте ещё раз.</p>}
      <button className="secondary" onClick={() => void logout()} disabled={isLoading}>Выйти</button>
    </section>
  );
}

export function App() {
  const dark = useAppSelector(state => state.ui.dark);
  const dispatch = useAppDispatch();
  const session = api.useSessionQuery(undefined, { refetchOnFocus: true, refetchOnReconnect: true });
  const [expiredCheck, setExpiredCheck] = useState<number>();
  const { data, fulfilledTimeStamp, refetch } = session;
  useEffect(() => {
    if (!data || fulfilledTimeStamp === undefined) return;
    const timer = window.setTimeout(() => {
      setExpiredCheck(fulfilledTimeStamp);
      void refetch();
    }, Math.max(0, fulfilledTimeStamp + data.remainingMs - Date.now()));
    return () => window.clearTimeout(timer);
  }, [data, fulfilledTimeStamp, refetch]);
  return (
    <div className="site" data-theme={dark ? 'dark' : 'light'}>
      <header>
        <span className="brand">Сёрфинг</span>
        <button className="secondary" onClick={() => dispatch(toggleTheme())}>
          {dark ? 'Светлая тема' : 'Тёмная тема'}
        </button>
      </header>
      <main>
        {session.isLoading ? <p role="status">Проверяем сессию…</p>
          : hasStatus(session.error, 401) ? <Login />
          : session.isError ? <section className="card"><p role="alert">Сервер недоступен.</p>
            <button onClick={session.refetch}>Повторить</button></section>
          : expiredCheck !== undefined && expiredCheck === fulfilledTimeStamp ? <p role="status">Проверяем сессию…</p>
          : data?.authenticated ? <Dashboard refreshSession={() => void refetch()} /> : null}
      </main>
    </div>
  );
}
