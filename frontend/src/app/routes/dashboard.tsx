import { createFileRoute, Navigate } from '@tanstack/react-router';
import { DashboardPage } from '@/pages/dashboard';
import { useSessionAccess } from '../model/session-access';
import { useAppSelector } from '../model/store';

export const Route = createFileRoute('/dashboard')({ component: DashboardRoute });

function DashboardRoute() {
  const { authenticated, refreshSession } = useSessionAccess();
  const dark = useAppSelector(state => state.ui.dark);
  return authenticated
    ? <DashboardPage dark={dark} refreshSession={refreshSession} />
    : <Navigate to="/login" replace />;
}
