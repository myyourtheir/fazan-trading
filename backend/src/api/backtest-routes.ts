import { Router, type RequestHandler } from 'express';
import { BacktestError, backtestLimits, type BacktestHistory } from '../core/backtest-history.js';
import { isTimeframe } from '../core/timeframe.js';
import type { BacktestParameters } from '../core/backtest.js';
import { brokerIdLimit, isPositiveInt32, isPrintableAscii } from './request-validation.js';

function readParameters(body: unknown): BacktestParameters | null {
  if (typeof body !== 'object' || body === null) return null;
  const { instrumentUid, timeframe, emaPeriod, lots, from, to } = body as Record<string, unknown>;
  if (!isPrintableAscii(instrumentUid, brokerIdLimit) || !isTimeframe(timeframe)
    || !isPositiveInt32(emaPeriod) || emaPeriod > backtestLimits.maxEmaPeriod
    || !isPositiveInt32(lots) || typeof from !== 'string' || typeof to !== 'string') {
    return null;
  }
  return { instrumentUid, timeframe, emaPeriod, lots, from, to };
}

const errorStatus = (error: BacktestError) =>
  error.code === 'INVALID_REQUEST' || error.code === 'BACKTEST_PERIOD_TOO_LONG' ? 400 : 422;

export function backtestRoutes(history: BacktestHistory, requireOwner: RequestHandler) {
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
      res.json(await history.check(parameters));
    } catch (error) {
      if (!(error instanceof BacktestError)) throw error;
      res.status(errorStatus(error)).json({ code: error.code });
    }
  });
  router.post('/run', async (req, res) => {
    const parameters = readParameters(req.body);
    if (!parameters) {
      res.status(400).json({ code: 'INVALID_REQUEST' });
      return;
    }
    try {
      res.json(await history.run(parameters));
    } catch (error) {
      if (!(error instanceof BacktestError)) throw error;
      res.status(errorStatus(error)).json({ code: error.code });
    }
  });
  return router;
}
