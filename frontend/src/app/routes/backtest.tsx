import { createFileRoute, Navigate } from '@tanstack/react-router';
import { BacktestPage } from '@/pages/backtest';
import { useSessionAccess } from '../model/session-access';
import { useAppSelector } from '../model/store';

export const Route = createFileRoute('/backtest')({ component: BacktestRoute });

function BacktestRoute() {
  const { authenticated, refreshSession } = useSessionAccess();
  const dark = useAppSelector((state) => state.ui.dark);
  return authenticated ? (
    <BacktestPage dark={dark} refreshSession={refreshSession} />
  ) : (
    <Navigate to="/login" replace />
  );
}
