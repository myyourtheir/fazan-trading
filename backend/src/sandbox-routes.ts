import { Router, type Request, type RequestHandler } from 'express';
import { brokerIdLimit, isPrintableAscii } from './request-validation.js';
import type { SandboxConnection } from './sandbox.js';

export function sandboxRoutes(sandbox: SandboxConnection, requireOwner: RequestHandler) {
  const router = Router();
  router.use(requireOwner);
  router.get('/', async (_req, res) => res.json(await sandbox.status()));
  router.put('/connection', mutation('token', 2048, token => sandbox.connect(token)));
  router.put('/account', mutation('accountId', brokerIdLimit, accountId => sandbox.selectAccount(accountId)));
  router.post('/accounts', async (_req, res) => {
    await sandbox.createAccount();
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
