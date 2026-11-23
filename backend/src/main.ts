import { surfingJournalProjection } from './infra/surfing-journal.js';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { surfingFeed } from './core/surfing-feed.js';
import { createApp } from './api/app.js';
import { OwnerAuth } from './core/auth.js';
import { BacktestHistory } from './core/backtest-history.js';
import { DisplaySettings } from './core/display-settings.js';
import { InvestSandbox } from './infra/invest-sandbox.js';
import { MarketData } from './core/market-data.js';
import { attachMarketSocket } from './api/market-socket.js';
import {
  connectToPostgres,
  ensureAppOwner,
  migrateDatabase,
  PostgresDisplaySettings,
  PostgresSandboxConnection,
  PostgresSessions,
  PostgresStrategySettings,
  PostgresTradingStore,
} from './infra/postgres.js';
import { Robot, RobotError } from './core/robot.js';
import { SandboxConnection } from './core/sandbox.js';
import { StrategySettings } from './core/strategy-settings.js';
import {
  canTradeSurfing,
  surfingStrategy,
  type SurfingLiveConfig,
} from './core/surfing-strategy.js';
import { TokenCipher } from './infra/token-cipher.js';
import { startupErrorMessage } from './infra/startup-error.js';

let startupStage = 'configuration';

async function main() {
  const {
    DATABASE_URL,
    PGHOST,
    OWNER_PASSWORD,
    COOKIE_SECURE = 'true',
    HOST = '127.0.0.1',
    PORT = '3000',
  } = process.env;
  if (!DATABASE_URL && !PGHOST)
    throw new Error('DATABASE_URL or PostgreSQL connection variables are required.');
  if (!OWNER_PASSWORD || OWNER_PASSWORD.length < 12 || OWNER_PASSWORD.length > 256) {
    throw new Error('OWNER_PASSWORD must contain 12–256 characters.');
  }
  if (!['true', 'false'].includes(COOKIE_SECURE))
    throw new Error('COOKIE_SECURE must be true or false.');
  const port = Number(PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('PORT must be a valid port number.');
  const cipher = new TokenCipher(process.env.SANDBOX_TOKEN_ENCRYPTION_KEY);

  startupStage = 'database connection';
  const { db, close } = connectToPostgres(DATABASE_URL);
  try {
    startupStage = 'database migrations';
    await migrateDatabase(db);
    startupStage = 'app_owner initialization';
    const appAccountId = await ensureAppOwner(db);
    startupStage = 'application initialization';
    const auth = await OwnerAuth.create(OWNER_PASSWORD, new PostgresSessions(db), { appAccountId });
    const broker = new InvestSandbox();
    const sandbox = new SandboxConnection(new PostgresSandboxConnection(db), cipher, broker);
    const backtest = new BacktestHistory(
      broker,
      () => sandbox.marketDataToken(),
      Date.now,
      surfingStrategy.backtest,
    );
    const strategy = new StrategySettings(
      new PostgresStrategySettings(db, auth.appAccountId!),
      sandbox,
    );
    const market = new MarketData(broker, async () => {
      const settings = await strategy.selectedProfile();
      return (
        settings && {
          instrumentUid: settings.instrument.uid,
          emaPeriod: settings.parameters.emaPeriod,
          timeframe: settings.timeframe,
          token: await sandbox.marketDataToken(),
        }
      );
    });
    const robot = new Robot<SurfingLiveConfig>(
      broker,
      new PostgresTradingStore(db, surfingJournalProjection),
      surfingFeed(market),
      async () => {
        if ((await strategy.selectedKind()) !== 'surfing')
          throw new RobotError('ROBOT_STRATEGY_UNAVAILABLE');
        const { settings } = await strategy.get();
        if (!settings) throw new RobotError('ROBOT_SETTINGS_REQUIRED');
        return {
          ...(await sandbox.tradingCredentials()),
          instrumentUid: settings.instrument.uid,
          ticker: settings.instrument.ticker,
          emaPeriod: settings.parameters.emaPeriod,
          lots: settings.parameters.lots,
          timeframe: settings.timeframe,
        };
      },
      Date.now,
      (history, options, config) => surfingStrategy.live(history, options, config),
      async (order) => ({
        ...(await sandbox.tradingCredentials()),
        instrumentUid: order.instrumentUid,
      }),
      (config) => {
        if (!canTradeSurfing(config)) throw new RobotError('ROBOT_SETTINGS_INVALID');
      },
      async () => {
        if ((await strategy.selectedKind()) !== 'surfing')
          throw new RobotError('ROBOT_STRATEGY_UNAVAILABLE');
        await sandbox.verifyFreshStart();
      },
      async () => {
        const settings = await strategy.selectedProfile();
        if (!settings) throw new RobotError('ROBOT_SETTINGS_REQUIRED');
        return {
          ...(await sandbox.tradingCredentials()),
          instrumentUid: settings.instrument.uid,
          ticker: settings.instrument.ticker,
          timeframe: settings.timeframe,
        };
      },
    );
    await robot.restore();
    const server = createServer();
    const marketSocket = attachMarketSocket(server, auth, market, robot);
    server.on(
      'request',
      createApp({
        auth,
        market,
        marketSocket,
        robot,
        backtest,
        secureCookies: COOKIE_SECURE === 'true',
        settings: { sandbox, strategy, change: (action) => robot.changeSettings(action) },
        displaySettings: new DisplaySettings(new PostgresDisplaySettings(db)),
      }),
    );
    startupStage = 'server listen';
    server.listen(port, HOST);
    await once(server, 'listening');
    console.log(`fazan-trading API is listening on ${HOST}:${port}.`);
    const shutdown = () => {
      marketSocket.shutdown();
      const drained = robot.shutdown();
      server.close(() => {
        void drained.then(close);
      });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) {
    try {
      await close();
    } catch {
      // Preserve the startup failure if closing the pool also fails.
    }
    throw error;
  }
}

main().catch((error: unknown) => {
  console.error(startupErrorMessage(error, startupStage));
  process.exitCode = 1;
});
