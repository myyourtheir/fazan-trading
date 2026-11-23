import { Router, type RequestHandler } from 'express';
import { brokerIdLimit, isPositiveInt32, isPrintableAscii } from './request-validation.js';
import type { StrategySettings } from '../core/strategy-settings.js';
import { isTimeframe } from '../core/timeframe.js';

export function strategyRoutes(
  strategy: StrategySettings,
  requireOwner: RequestHandler,
  changeSettings: (action: () => Promise<void>) => Promise<void>,
  onStrategyChange?: () => void,
) {
  const router = Router();
  router.use(requireOwner);
  router.get('/', async (_req, res) => res.json(await strategy.get()));
  router.get('/futures', async (req, res) => {
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!query || query.length > 128) {
      res.status(400).json({ code: 'INVALID_REQUEST' });
      return;
    }
    res.json(await strategy.search(query));
  });
  router.put('/', async (req, res) => {
    const { accountId, instrumentUid, emaPeriod, lots, timeframe } = req.body ?? {};
    if (
      !isPrintableAscii(accountId, brokerIdLimit) ||
      !isPrintableAscii(instrumentUid, brokerIdLimit) ||
      !isPositiveInt32(emaPeriod) ||
      !isPositiveInt32(lots) ||
      !isTimeframe(timeframe)
    ) {
      res.status(400).json({ code: 'INVALID_REQUEST' });
      return;
    }
    await changeSettings(() =>
      strategy.save({ accountId, instrumentUid, emaPeriod, lots, timeframe }),
    );
    onStrategyChange?.();
    res.status(204).end();
  });
  return router;
}
