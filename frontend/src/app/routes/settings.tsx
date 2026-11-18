import { createFileRoute, Navigate } from '@tanstack/react-router';
import { SettingsPage } from '@/pages/settings';
import { useSessionAccess } from '../model/session-access';

export const Route = createFileRoute('/settings')({ component: SettingsRoute });

function SettingsRoute() {
  const { authenticated, refreshSession } = useSessionAccess();
  return authenticated ? <SettingsPage refreshSession={refreshSession} /> : <Navigate to="/login" replace />;
}
