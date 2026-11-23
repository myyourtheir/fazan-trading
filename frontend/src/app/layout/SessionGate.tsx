import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Outlet } from '@tanstack/react-router';
import { hasStatus, sessionApi } from '@/shared/api';
import { RecoveryCard, Spinner } from '@/shared/ui';
import { SessionAccessContext } from '../model/session-access';

export function SessionGate({
  layout,
}: {
  layout: (authenticated: boolean, content: ReactNode) => ReactNode;
}) {
  const session = sessionApi.useSessionQuery(undefined, {
    refetchOnFocus: true,
    refetchOnReconnect: true,
  });
  const [expiredCheck, setExpiredCheck] = useState<number>();
  const { data, fulfilledTimeStamp, refetch } = session;
  const refreshSession = useCallback(() => {
    void refetch();
  }, [refetch]);
  useEffect(() => {
    if (!data || fulfilledTimeStamp === undefined) return;
    const timer = window.setTimeout(
      () => {
        setExpiredCheck(fulfilledTimeStamp);
        void refetch();
      },
      Math.max(0, fulfilledTimeStamp + data.remainingMs - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [data, fulfilledTimeStamp, refetch]);

  const checkingExpiry = expiredCheck !== undefined && expiredCheck === fulfilledTimeStamp;
  const unauthenticated = hasStatus(session.error, 401);
  const checking = !session.error && (!data || checkingExpiry);
  const authenticated = !checking && !session.error && data?.authenticated === true;
  const content = checking ? (
    <p role="status" className="flex items-center gap-2">
      <Spinner aria-hidden="true" /> Проверяем сессию…
    </p>
  ) : session.error && !unauthenticated ? (
    <RecoveryCard message="Сервер недоступен." action="Повторить" onRetry={refreshSession} />
  ) : (
    <Outlet />
  );
  return (
    <SessionAccessContext.Provider value={{ authenticated, refreshSession }}>
      {layout(authenticated, content)}
    </SessionAccessContext.Provider>
  );
}
