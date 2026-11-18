import { Router, type RequestHandler } from 'express';
import { BacktestError, backtestLimits, type BacktestHistory } from '../core/backtest-history.js';
import { isTimeframe } from '../core/timeframe.js';
import { brokerIdLimit, isPositiveInt32, isPrintableAscii } from './request-validation.js';

export function backtestRoutes(history: BacktestHistory, requireOwner: RequestHandler) {
  const router = Router();
  router.use(requireOwner);
  router.get('/limits', (_req, res) => res.json(backtestLimits));
  router.post('/history', async (req, res) => {
    const { instrumentUid, timeframe, emaPeriod, lots, from, to } = req.body ?? {};
    if (!isPrintableAscii(instrumentUid, brokerIdLimit) || !isTimeframe(timeframe)
      || !isPositiveInt32(emaPeriod) || emaPeriod > backtestLimits.maxEmaPeriod
      || !isPositiveInt32(lots) || typeof from !== 'string' || typeof to !== 'string') {
      res.status(400).json({ code: 'INVALID_REQUEST' });
      return;
    }
    try {
      res.json(await history.check({ instrumentUid, timeframe, emaPeriod, lots, from, to }));
    } catch (error) {
      if (!(error instanceof BacktestError)) throw error;
      const status = error.code === 'INVALID_REQUEST' || error.code === 'BACKTEST_PERIOD_TOO_LONG' ? 400 : 422;
      res.status(status).json({ code: error.code });
    }
  });
  return router;
}
