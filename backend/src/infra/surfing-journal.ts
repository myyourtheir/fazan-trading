import type { JournalEntry } from '../core/journal.js';
import type { OrderIntent, RecoveredOrder } from '../core/robot.js';

export const surfingJournalProjection = { toJournalIntent, toRecoveredOrder };

function toJournalIntent({ context, ...order }: OrderIntent) {
  if (context.type === 'manual-close')
    return {
      ...order,
      action: 'manual-close' as const,
      manualCloseTime: context.time,
      candleTime: null,
      signalTime: null,
      signalPrice: null,
      ema: null,
    };
  const { kind, signalPrice, ema } = context.strategy;
  if (
    kind !== 'surfing' ||
    typeof signalPrice !== 'number' ||
    !Number.isFinite(signalPrice) ||
    typeof ema !== 'number' ||
    !Number.isFinite(ema)
  )
    throw new Error('Unsupported journal signal context');
  return {
    ...order,
    action: 'ema-crossing' as const,
    candleTime: context.candleTime,
    signalTime: context.signalTime,
    signalPrice,
    ema,
    manualCloseTime: null,
  };
}

function toRecoveredOrder(entry: JournalEntry): RecoveredOrder {
  const { action, candleTime, signalTime, signalPrice, ema, manualCloseTime, ...order } = entry;
  if (action === 'manual-close' && manualCloseTime !== null)
    return { ...order, context: { type: 'manual-close', time: manualCloseTime } };
  if (
    action === 'ema-crossing' &&
    candleTime !== null &&
    signalTime !== null &&
    signalPrice !== null &&
    ema !== null
  )
    return {
      ...order,
      context: {
        type: 'signal',
        candleTime,
        signalTime,
        strategy: { kind: 'surfing', signalPrice, ema },
      },
    };
  throw new Error('Invalid persisted journal context');
}
