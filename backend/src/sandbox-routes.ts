import { Router, type Request, type RequestHandler } from 'express';
import type { SandboxConnection } from './sandbox.js';

export function sandboxRoutes(sandbox: SandboxConnection, requireOwner: RequestHandler) {
  const router = Router();
  router.use(requireOwner);
  router.get('/', async (_req, res) => res.json(await sandbox.status()));
  router.put('/connection', mutation('token', 2048, token => sandbox.connect(token)));
  router.put('/account', mutation('accountId', 128, accountId => sandbox.selectAccount(accountId)));
  router.post('/accounts', async (_req, res) => {
    await sandbox.createAccount();
    res.status(204).end();
  });
  router.post('/funding', mutation('accountId', 128, accountId => sandbox.fundAccount(accountId)));
  return router;
}

function mutation(field: string, limit: number, apply: (value: string) => Promise<void>): RequestHandler {
  return async (req: Request, res) => {
    const value: unknown = req.body?.[field];
    if (typeof value !== 'string' || !value.length || value.length > limit || /[^\x21-\x7e]/.test(value)) {
      res.status(400).json({ code: 'INVALID_REQUEST' });
      return;
    }
    await apply(value);
    res.status(204).end();
  };
}
