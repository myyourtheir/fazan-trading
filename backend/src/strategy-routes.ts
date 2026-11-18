import { Router, type RequestHandler } from 'express';
import { brokerIdLimit, isPrintableAscii } from './request-validation.js';
import type { StrategySettings } from './strategy-settings.js';

function positiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 2_147_483_647;
}

export function strategyRoutes(strategy: StrategySettings, requireOwner: RequestHandler) {
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
    const { accountId, instrumentUid, emaPeriod, lots } = req.body ?? {};
    if (!isPrintableAscii(accountId, brokerIdLimit) || !isPrintableAscii(instrumentUid, brokerIdLimit)
      || !positiveInt(emaPeriod) || !positiveInt(lots)) {
      res.status(400).json({ code: 'INVALID_REQUEST' });
      return;
    }
    await strategy.save({ accountId, instrumentUid, emaPeriod, lots });
    res.status(204).end();
  });
  return router;
}
