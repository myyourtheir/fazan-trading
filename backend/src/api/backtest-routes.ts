import type { BacktestParameters } from '../core/backtest.js';
import { Router, type RequestHandler } from 'express';
import { BacktestError, backtestLimits, type BacktestHistory } from '../core/backtest-history.js';
import type { FullBacktestParameters, HistoricalBacktest } from '../core/historical-backtest.js';
import { validImproved } from '../core/strategy-settings.js';
import { isTimeframe } from '../core/timeframe.js';
import { brokerIdLimit, isPositiveInt32, isPrintableAscii } from './request-validation.js';

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function readParameters(body: unknown): Omit<BacktestParameters, 'timeZone'> | null {
  if (typeof body !== 'object' || body === null) return null;
  const { instrumentUid, timeframe, emaPeriod, lots, from, to, commission, slippage, kind } =
    body as Record<string, unknown>;
  if (
    (kind !== undefined && kind !== 'surfing') ||
    !isPrintableAscii(instrumentUid, brokerIdLimit) ||
    !isTimeframe(timeframe) ||
    !isPositiveInt32(emaPeriod) ||
    emaPeriod > backtestLimits.maxEmaPeriod ||
    !isPositiveInt32(lots) ||
    typeof from !== 'string' ||
    typeof to !== 'string'
  ) {
    return null;
  }
  const commissionValue = commission === undefined ? 0 : commission;
  const slippageValue = slippage === undefined ? 0 : slippage;
  if (!isNonNegativeNumber(commissionValue) || !isNonNegativeNumber(slippageValue)) return null;
  return {
    instrumentUid,
    timeframe,
    emaPeriod,
    lots,
    from,
    to,
    commission: commissionValue,
    slippage: slippageValue,
  };
}

function readFullParameters(body: Record<string, unknown>): FullBacktestParameters | null {
  const { instrumentUid, timeframe, emaPeriod, from, to, kind, lots, ...other } = body;
  const { commission = 0, slippage = 0, initialMoney = 100_000 } = other;
  if (
    !isPrintableAscii(instrumentUid, brokerIdLimit) ||
    !isTimeframe(timeframe) ||
    !isPositiveInt32(emaPeriod) ||
    emaPeriod > backtestLimits.maxEmaPeriod ||
    typeof from !== 'string' ||
    typeof to !== 'string' ||
    !isNonNegativeNumber(commission) ||
    commission > 100 ||
    !isNonNegativeNumber(slippage) ||
    !Number.isSafeInteger(slippage) ||
    slippage > 2_147_483_647 ||
    !isNonNegativeNumber(initialMoney) ||
    initialMoney < 0.01 ||
    initialMoney > Number.MAX_SAFE_INTEGER
  )
    return null;
  const base = {
    instrumentUid,
    timeframe,
    emaPeriod,
    from,
    to,
    commission,
    slippage,
    initialMoney,
  };
  if (kind === 'surfing' && isPositiveInt32(lots)) return { ...base, kind, lots };
  if (kind !== 'improved-surfing') return null;
  const { atrPeriod, stopAtrMultiplier, addStepAtr, maxAddOns, tradeWeekends } = other;
  const strategy = {
    emaPeriod,
    atrPeriod,
    stopAtrMultiplier,
    addStepAtr,
    maxAddOns,
    tradeWeekends,
  };
  if (!validImproved(strategy) || strategy.atrPeriod > backtestLimits.maxEmaPeriod) return null;
  return { ...base, ...strategy, kind };
}

function errorStatus(error: BacktestError) {
  if (error.code === 'INVALID_REQUEST') return 400;
  if (error.code === 'BACKTEST_CANDLES_LOAD_FAILED') return 502;
  return 422;
}

export function backtestRoutes(
  history: BacktestHistory,
  requireOwner: RequestHandler,
  loadTimeZone: () => Promise<string>,
  full?: HistoricalBacktest,
) {
  const router = Router();
  router.use(requireOwner);
  router.get('/limits', (_req, res) => res.json(backtestLimits));
  const execute =
    (operation: 'check' | 'run'): RequestHandler =>
    async (req, res) => {
      try {
        const body = req.body;
        if (body && typeof body === 'object' && body.kind !== undefined) {
          const parameters = readFullParameters(body);
          if (!parameters) throw new BacktestError('INVALID_REQUEST');
          if (!full) {
            res.status(503).json({ code: 'BACKTEST_UNAVAILABLE' });
            return;
          }
          res.json(await full[operation](parameters));
          return;
        }
        const parameters = readParameters(body);
        if (!parameters) throw new BacktestError('INVALID_REQUEST');
        res.json(await history[operation]({ ...parameters, timeZone: await loadTimeZone() }));
      } catch (error) {
        if (!(error instanceof BacktestError)) throw error;
        res.status(errorStatus(error)).json({ code: error.code, details: error.details });
      }
    };
  router.post('/history', execute('check'));
  router.post('/run', execute('run'));
  return router;
}
