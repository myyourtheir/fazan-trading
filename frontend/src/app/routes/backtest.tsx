import { createFileRoute, Navigate, useLocation, useRouter } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { BacktestPage } from '@/pages/backtest';
import { timeframes, type BacktestDraft } from '@/entities/strategy';
import { useSessionAccess } from '../model/session-access';
import { useAppSelector } from '../model/store';

export const Route = createFileRoute('/backtest')({ component: BacktestRoute });

// The dashboard hands the backtest form a one-shot draft through the router's in-memory history
// state, so the values reach `/backtest` without being saved or written to the URL.
function isTimeframe(value: unknown): value is BacktestDraft['timeframe'] {
  return typeof value === 'string' && (timeframes as readonly string[]).includes(value);
}

function readDraft(draft: unknown): BacktestDraft | null {
  if (typeof draft !== 'object' || draft === null) return null;
  const value = draft as Record<string, unknown>;
  if (
    typeof value.instrumentUid !== 'string' ||
    typeof value.ticker !== 'string' ||
    typeof value.emaPeriod !== 'string' ||
    typeof value.lots !== 'string' ||
    !isTimeframe(value.timeframe)
  ) {
    return null;
  }
  return {
    instrumentUid: value.instrumentUid,
    ticker: value.ticker,
    timeframe: value.timeframe,
    emaPeriod: value.emaPeriod,
    lots: value.lots,
  };
}

function BacktestRoute() {
  const { authenticated, refreshSession } = useSessionAccess();
  const dark = useAppSelector((state) => state.ui.dark);
  const router = useRouter();
  const backtestDraft = useLocation({ select: (location) => location.state.backtestDraft });
  // Capture the one-shot draft on first render only, so it survives the history-state clear below.
  const [initialDraft] = useState(() => readDraft(backtestDraft));

  useEffect(() => {
    if (!backtestDraft) return;
    // Consume the draft so a later refresh starts from the saved settings, not the transient draft.
    const { href, state } = router.history.location;
    const next = { ...state };
    delete next.backtestDraft;
    router.history.replace(href, next);
  }, [backtestDraft, router]);

  return authenticated ? (
    <BacktestPage dark={dark} refreshSession={refreshSession} initialDraft={initialDraft} />
  ) : (
    <Navigate to="/login" replace />
  );
}
