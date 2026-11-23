import type { BacktestCandle, BacktestParameters } from '../core/backtest.js';
import type { Side } from '../core/crossing.js';
import { Router, type RequestHandler } from 'express';
import { BacktestError, backtestLimits, type BacktestHistory } from '../core/backtest-history.js';
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

const errorStatus = (error: BacktestError) =>
  error.code === 'INVALID_REQUEST' || error.code === 'BACKTEST_PERIOD_TOO_LONG' ? 400 : 422;

export function backtestRoutes(
  history: BacktestHistory<BacktestParameters, BacktestCandle, Side | null>,
  requireOwner: RequestHandler,
  loadTimeZone: () => Promise<string>,
) {
  const router = Router();
  router.use(requireOwner);
  router.get('/limits', (_req, res) => res.json(backtestLimits));
  router.post('/history', async (req, res) => {
    const parameters = readParameters(req.body);
    if (!parameters) {
      res.status(400).json({ code: 'INVALID_REQUEST' });
      return;
    }
    try {
      res.json(await history.check({ ...parameters, timeZone: await loadTimeZone() }));
    } catch (error) {
      if (!(error instanceof BacktestError)) throw error;
      res.status(errorStatus(error)).json({ code: error.code, details: error.details });
    }
  });
  router.post('/run', async (req, res) => {
    const parameters = readParameters(req.body);
    if (!parameters) {
      res.status(400).json({ code: 'INVALID_REQUEST' });
      return;
    }
    try {
      res.json(await history.run({ ...parameters, timeZone: await loadTimeZone() }));
    } catch (error) {
      if (!(error instanceof BacktestError)) throw error;
      res.status(errorStatus(error)).json({ code: error.code, details: error.details });
    }
  });
  return router;
}
