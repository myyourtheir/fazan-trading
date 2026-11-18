import type { BacktestDraft } from '@/entities/strategy';

// The dashboard passes a one-shot draft to `/backtest` through TanStack Router's in-memory history
// state. Augmenting the router's user history state keeps that hand-off typed without exposing the
// draft in the URL.
declare module '@tanstack/history' {
  interface HistoryState {
    backtestDraft?: BacktestDraft;
  }
}
