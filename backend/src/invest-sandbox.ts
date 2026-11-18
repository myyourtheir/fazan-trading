import { NodeApiClient } from '@ttech-pub/grpc-node-client';
import { InstrumentStatus, type Quotation } from '@ttech-pub/grpc-node-client/compiled/common.js';
import {
  CandleInterval, GetTechAnalysisRequest_IndicatorInterval, GetTechAnalysisRequest_IndicatorType,
  GetTechAnalysisRequest_TypeOfPrice, SubscriptionAction, SubscriptionInterval, SubscriptionStatus,
  type Candle, type HistoricCandle,
} from '@ttech-pub/grpc-node-client/compiled/marketdata.js';
import { AccountStatus } from '@ttech-pub/grpc-node-client/compiled/users.js';
import { Status } from 'nice-grpc';
import { SandboxError, virtualFundingRubles, type SandboxBroker } from './sandbox.js';
import type { HourlyCandle, MarketBroker } from './market-data.js';

const sandboxUrl = 'https://sandbox-invest-public-api.tbank.ru:443';
const requestOptions = (signal?: AbortSignal) => {
  const timeout = AbortSignal.timeout(8_000);
  return { signal: signal ? AbortSignal.any([signal, timeout]) : timeout };
};
const definiteRejections = new Set<unknown>([
  Status.INVALID_ARGUMENT, Status.NOT_FOUND, Status.ALREADY_EXISTS, Status.FAILED_PRECONDITION,
  Status.OUT_OF_RANGE, Status.RESOURCE_EXHAUSTED, Status.UNIMPLEMENTED,
]);

const hourlySubscription = SubscriptionInterval.SUBSCRIPTION_INTERVAL_ONE_HOUR;
const price = ({ units, nano }: Quotation) => units + nano / 1e9;

function hourlyCandle({ time, open, high, low, close }: HistoricCandle | Candle, complete: boolean): HourlyCandle | null {
  if (!time || !open || !high || !low || !close) return null;
  return { time: time.getTime(), open: price(open), high: price(high), low: price(low), close: price(close), complete };
}

export class InvestSandbox implements SandboxBroker, MarketBroker {
  private current?: { token: string; client: NodeApiClient };

  private async call<T>(token: string, operation: (client: NodeApiClient) => Promise<T>) {
    try {
      const existing = this.current;
      const client = existing?.token === token
        ? existing.client
        : await NodeApiClient.create({ token, url: sandboxUrl, telemetry: 'disabled', useMincifryCertificate: true });
      const result = await operation(client);
      this.current = { token, client };
      return result;
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (code === Status.UNAUTHENTICATED || code === Status.PERMISSION_DENIED) {
        throw new SandboxError('SANDBOX_TOKEN_REJECTED');
      }
      throw new SandboxError(definiteRejections.has(code) ? 'SANDBOX_OPERATION_REJECTED' : 'SANDBOX_UNREACHABLE');
    }
  }

  accounts(token: string) {
    return this.call(token, async ({ sandbox }) => {
      const { accounts } = await sandbox.getSandboxAccounts({ status: AccountStatus.ACCOUNT_STATUS_OPEN }, requestOptions());
      return accounts.filter(account => account.status === AccountStatus.ACCOUNT_STATUS_OPEN)
        .map(({ id, name }) => ({ id, name }));
    });
  }

  openAccount(token: string) {
    return this.call(token, async ({ sandbox }) => {
      const { accountId } = await sandbox.openSandboxAccount({ name: 'Сёрфинг' }, requestOptions());
      if (!accountId) throw new Error('Sandbox account ID is missing.');
      return accountId;
    });
  }

  async fundAccount(token: string, accountId: string) {
    await this.call(token, ({ sandbox }) => sandbox.sandboxPayIn({
      accountId, amount: { currency: 'rub', units: virtualFundingRubles, nano: 0 },
    }, requestOptions()));
  }

  futures(token: string) {
    return this.call(token, async ({ instruments }) => {
      const { instruments: contracts } = await instruments.futures(
        { instrumentStatus: InstrumentStatus.INSTRUMENT_STATUS_ALL }, requestOptions());
      return contracts.map(({ uid, ticker, name, classCode, exchange, expirationDate, apiTradeAvailableFlag }) => ({
        uid, ticker, name, classCode, exchange, expirationDate: expirationDate?.toISOString() ?? null, apiTradeAvailableFlag,
      }));
    });
  }

  candles(token: string, instrumentId: string, from: Date, to: Date, signal?: AbortSignal) {
    return this.call(token, async ({ marketdata }) => {
      const { candles } = await marketdata.getCandles({
        instrumentId, from, to, interval: CandleInterval.CANDLE_INTERVAL_HOUR,
      }, requestOptions(signal));
      return candles.map(candle => hourlyCandle(candle, candle.isComplete)).filter(candle => candle !== null);
    });
  }

  ema(token: string, instrumentUid: string, length: number, from: Date, to: Date, signal?: AbortSignal) {
    return this.call(token, async ({ marketdata }) => {
      const { technicalIndicators } = await marketdata.getTechAnalysis({
        instrumentUid, from, to, length,
        interval: GetTechAnalysisRequest_IndicatorInterval.INDICATOR_INTERVAL_ONE_HOUR,
        indicatorType: GetTechAnalysisRequest_IndicatorType.INDICATOR_TYPE_EMA,
        typeOfPrice: GetTechAnalysisRequest_TypeOfPrice.TYPE_OF_PRICE_CLOSE,
      }, requestOptions(signal));
      return technicalIndicators.flatMap(({ timestamp, middleBand }) => timestamp && middleBand
        ? [{ time: timestamp.getTime(), value: price(middleBand) }]
        : []);
    });
  }

  async *stream(token: string, instrumentId: string, signal: AbortSignal) {
    const silence = new AbortController();
    const watchdog = setTimeout(() => silence.abort(), 45_000);
    try {
      const responses = await this.call(token, async ({ marketdataStream }) => marketdataStream.marketDataServerSideStream({
        subscribeCandlesRequest: {
          subscriptionAction: SubscriptionAction.SUBSCRIPTION_ACTION_SUBSCRIBE, waitingClose: false,
          instruments: [{ instrumentId, interval: hourlySubscription }],
        },
        pingSettings: { pingDelayMs: 15_000 },
      }, { signal: AbortSignal.any([signal, silence.signal]) }));
      let subscribed = false;
      for await (const { subscribeCandlesResponse, candle } of responses) {
        watchdog.refresh();
        if (subscribeCandlesResponse) {
          subscribed = subscribeCandlesResponse.candlesSubscriptions.some(subscription =>
            subscription.instrumentUid === instrumentId && subscription.interval === hourlySubscription
            && subscription.subscriptionStatus === SubscriptionStatus.SUBSCRIPTION_STATUS_SUCCESS);
          if (!subscribed) throw new SandboxError('SANDBOX_OPERATION_REJECTED');
          yield { kind: 'subscribed' } as const;
        }
        if (subscribed && candle?.instrumentUid === instrumentId && candle.interval === hourlySubscription) {
          const update = hourlyCandle(candle, false);
          if (update) yield { kind: 'candle', candle: update } as const;
        }
      }
    } finally {
      clearTimeout(watchdog);
    }
  }
}
