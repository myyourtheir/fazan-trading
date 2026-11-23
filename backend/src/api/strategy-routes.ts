import { Router, type RequestHandler } from 'express';
import { brokerIdLimit, isPositiveInt32, isPrintableAscii } from './request-validation.js';
import type { StrategySettings } from '../core/strategy-settings.js';
import { isTimeframe } from '../core/timeframe.js';
import { surfingStrategy } from '../core/surfing-strategy.js';

export function strategyRoutes(
  strategy: StrategySettings,
  requireOwner: RequestHandler,
  changeSettings: (action: () => Promise<void>) => Promise<void>,
  onStrategyChange?: () => void,
) {
  const router = Router();
  router.use(requireOwner);
  router.get('/', async (_req, res) => {
    const { defaults, settings } = await strategy.get();
    res.json({
      defaults,
      settings: settings && {
        instrument: settings.instrument,
        timeframe: settings.timeframe,
        ...settings.parameters,
      },
    });
  });
  router.get('/futures', async (req, res) => {
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!query || query.length > 128) {
      res.status(400).json({ code: 'INVALID_REQUEST' });
      return;
    }
    res.json(await strategy.search(query));
  });
  router.put('/', async (req, res) => {
    const { accountId, instrumentUid, timeframe, kind, parameters } = req.body ?? {};
    const values = kind === undefined || parameters === undefined ? req.body : parameters;
    const { emaPeriod, lots } = values ?? {};
    if (
      (kind !== undefined && kind !== 'surfing') ||
      (kind !== undefined && !surfingStrategy.validate(parameters)) ||
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
