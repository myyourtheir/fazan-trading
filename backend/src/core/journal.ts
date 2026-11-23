import type { OrderIntent, OrderResult } from './robot.js';

// The legacy Surfing journal representation exposed by REST.
export type JournalEntry = Omit<OrderIntent, 'context'> & {
  action: 'ema-crossing' | 'manual-close';
  candleTime: number | null;
  signalTime: number | null;
  signalPrice: number | null;
  ema: number | null;
  manualCloseTime: number | null;
} & Omit<OrderResult, 'status'> & { status: OrderResult['status'] | 'reserved' };
