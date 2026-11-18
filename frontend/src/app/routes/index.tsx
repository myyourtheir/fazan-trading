import { createFileRoute, Navigate } from '@tanstack/react-router';
import { useSessionAccess } from '../model/session-access';

export const Route = createFileRoute('/')({ component: IndexRoute });

function IndexRoute() {
  const { authenticated } = useSessionAccess();
  return <Navigate to={authenticated ? '/dashboard' : '/login'} replace />;
}
