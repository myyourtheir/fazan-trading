import { once } from 'node:events';
import { createServer } from 'node:http';
import { createApp } from './api/app.js';
import { OwnerAuth } from './core/auth.js';
import { BacktestHistory } from './core/backtest-history.js';
import { InvestSandbox } from './infra/invest-sandbox.js';
import { MarketData } from './core/market-data.js';
import { attachMarketSocket } from './api/market-socket.js';
import {
  connectToPostgres, migrateDatabase, PostgresSandboxConnection, PostgresSessions, PostgresStrategySettings, PostgresTradingStore,
} from './infra/postgres.js';
import { Robot, RobotError } from './core/robot.js';
import { SandboxConnection } from './core/sandbox.js';
import { StrategySettings } from './core/strategy-settings.js';
import { TokenCipher } from './infra/token-cipher.js';

async function main() {
  const { DATABASE_URL, PGHOST, OWNER_PASSWORD, COOKIE_SECURE = 'true', HOST = '127.0.0.1', PORT = '3000' } = process.env;
  if (!DATABASE_URL && !PGHOST) throw new Error('DATABASE_URL or PostgreSQL connection variables are required.');
  if (!OWNER_PASSWORD || OWNER_PASSWORD.length < 12 || OWNER_PASSWORD.length > 256) {
    throw new Error('OWNER_PASSWORD must contain 12–256 characters.');
  }
  if (!['true', 'false'].includes(COOKIE_SECURE)) throw new Error('COOKIE_SECURE must be true or false.');
  const port = Number(PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid port number.');
  const cipher = new TokenCipher(process.env.SANDBOX_TOKEN_ENCRYPTION_KEY);

  const { db, close } = connectToPostgres(DATABASE_URL);
  try {
    await migrateDatabase(db);
    const auth = await OwnerAuth.create(OWNER_PASSWORD, new PostgresSessions(db));
    const broker = new InvestSandbox();
    const sandbox = new SandboxConnection(new PostgresSandboxConnection(db), cipher, broker);
    const backtest = new BacktestHistory(broker, () => sandbox.marketDataToken());
    const strategy = new StrategySettings(new PostgresStrategySettings(db), sandbox);
    const market = new MarketData(broker, async () => {
      const { settings } = await strategy.get();
      return settings && { instrumentUid: settings.instrument.uid, emaPeriod: settings.emaPeriod,
        timeframe: settings.timeframe, token: await sandbox.marketDataToken() };
    });
    const robot = new Robot(broker, new PostgresTradingStore(db), market, async () => {
      const { settings } = await strategy.get();
      if (!settings) throw new RobotError('ROBOT_SETTINGS_REQUIRED');
      return {
        ...await sandbox.tradingCredentials(), instrumentUid: settings.instrument.uid,
        ticker: settings.instrument.ticker, emaPeriod: settings.emaPeriod, lots: settings.lots, timeframe: settings.timeframe,
      };
    });
    await robot.restore();
    const server = createServer();
    const marketSocket = attachMarketSocket(server, auth, market, robot);
    server.on('request', createApp({
      auth, market, marketSocket, robot, backtest, secureCookies: COOKIE_SECURE === 'true',
      settings: { sandbox, strategy, change: action => robot.changeSettings(action) },
    }));
    server.listen(port, HOST);
    await once(server, 'listening');
    console.log(`fazan-trading API is listening on ${HOST}:${port}.`);
    const shutdown = () => {
      marketSocket.shutdown();
      const drained = robot.shutdown();
      server.close(() => { void drained.then(close); });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch {
    await close();
    throw new Error('Backend startup failed. Check the database connection, migrations, and listening address.');
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Backend startup failed.');
  process.exitCode = 1;
});
