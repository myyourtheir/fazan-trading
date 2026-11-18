import { useCallback, useEffect, useState } from 'react';
import { Outlet } from '@tanstack/react-router';
import { hasStatus, sessionApi } from '@/shared/api';
import { RecoveryCard, Spinner } from '@/shared/ui';
import { SessionAccessContext } from '../model/session-access';

export function SessionGate() {
  const session = sessionApi.useSessionQuery(undefined, { refetchOnFocus: true, refetchOnReconnect: true });
  const [expiredCheck, setExpiredCheck] = useState<number>();
  const { data, fulfilledTimeStamp, refetch } = session;
  const refreshSession = useCallback(() => { void refetch(); }, [refetch]);
  useEffect(() => {
    if (!data || fulfilledTimeStamp === undefined) return;
    const timer = window.setTimeout(() => {
      setExpiredCheck(fulfilledTimeStamp);
      void refetch();
    }, Math.max(0, fulfilledTimeStamp + data.remainingMs - Date.now()));
    return () => window.clearTimeout(timer);
  }, [data, fulfilledTimeStamp, refetch]);

  const checkingExpiry = expiredCheck !== undefined && expiredCheck === fulfilledTimeStamp;
  if (!session.error && (!data || checkingExpiry)) {
    return <p role="status" className="flex items-center gap-2"><Spinner aria-hidden="true" /> Проверяем сессию…</p>;
  }
  const unauthenticated = hasStatus(session.error, 401);
  if (session.error && !unauthenticated) {
    return <RecoveryCard message="Сервер недоступен." action="Повторить" onRetry={refreshSession} />;
  }
  return (
    <SessionAccessContext.Provider value={{ authenticated: !unauthenticated && data?.authenticated === true, refreshSession }}>
      <Outlet />
    </SessionAccessContext.Provider>
  );
}
