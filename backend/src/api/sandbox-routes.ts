import { Router, type Request, type RequestHandler } from 'express';
import { brokerIdLimit, isPrintableAscii } from './request-validation.js';
import type { SandboxConnection } from '../core/sandbox.js';

export function sandboxRoutes(sandbox: SandboxConnection, requireOwner: RequestHandler, onTokenChange?: () => void,
  changeSettings = (action: () => Promise<void>) => action()) {
  const router = Router();
  router.use(requireOwner);
  router.get('/', async (_req, res) => res.json(await sandbox.status()));
  router.put('/connection', mutation('token', 2048, async token => {
    await changeSettings(() => sandbox.connect(token));
    onTokenChange?.();
  }));
  router.put('/account', mutation('accountId', brokerIdLimit,
    accountId => changeSettings(() => sandbox.selectAccount(accountId))));
  router.post('/accounts', async (_req, res) => {
    await changeSettings(() => sandbox.createAccount());
    res.status(204).end();
  });
  router.post('/funding', mutation('accountId', brokerIdLimit, accountId => sandbox.fundAccount(accountId)));
  return router;
}

function mutation(field: string, limit: number, apply: (value: string) => Promise<void>): RequestHandler {
  return async (req: Request, res) => {
    const value: unknown = req.body?.[field];
    if (!isPrintableAscii(value, limit)) {
      res.status(400).json({ code: 'INVALID_REQUEST' });
      return;
    }
    await apply(value);
    res.status(204).end();
  };
}
