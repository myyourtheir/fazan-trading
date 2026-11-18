import { createFileRoute, Navigate } from '@tanstack/react-router';
import { LoginPage } from '@/pages/login';
import { useSessionAccess } from '../model/session-access';

export const Route = createFileRoute('/login')({ component: LoginRoute });

function LoginRoute() {
  const { authenticated } = useSessionAccess();
  return authenticated ? <Navigate to="/dashboard" replace /> : <LoginPage />;
}
