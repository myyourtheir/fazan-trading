import { NodeApiClient } from '@ttech-pub/grpc-node-client';
import {
  InstrumentStatus,
  PriceType,
  type Quotation,
} from '@ttech-pub/grpc-node-client/compiled/common.js';
import { InstrumentIdType } from '@ttech-pub/grpc-node-client/compiled/instruments.js';
import {
  CandleInterval,
  GetTechAnalysisRequest_IndicatorInterval,
  GetTechAnalysisRequest_IndicatorType,
  GetTechAnalysisRequest_TypeOfPrice,
  SubscriptionAction,
  SubscriptionInterval,
  SubscriptionStatus,
  type Candle,
  type HistoricCandle,
} from '@ttech-pub/grpc-node-client/compiled/marketdata.js';
import {
  OrderDirection,
  OrderExecutionReportStatus as ReportStatus,
  OrderIdType,
  OrderType,
  TimeInForceType,
} from '@ttech-pub/grpc-node-client/compiled/orders.js';
import { AccountStatus } from '@ttech-pub/grpc-node-client/compiled/users.js';
import { Status } from 'nice-grpc';
import { SandboxError, virtualFundingRubles, type SandboxBroker } from '../core/sandbox.js';
import type { MarketCandle, MarketBroker } from '../core/market-data.js';
import type { Broker, BrokerOrder, OrderIntent, TradingConfig } from '../core/robot.js';
import type { Timeframe } from '../core/timeframe.js';
import type { BacktestBroker } from '../core/backtest-history.js';

const sandboxUrl = 'https://sandbox-invest-public-api.tbank.ru:443';
const requestOptions = (signal?: AbortSignal, timeoutMs = 8_000) => {
  const timeout = AbortSignal.timeout(timeoutMs);
  return { signal: signal ? AbortSignal.any([signal, timeout]) : timeout };
};
const definiteRejections = new Set<unknown>([
  Status.INVALID_ARGUMENT,
  Status.NOT_FOUND,
  Status.ALREADY_EXISTS,
  Status.FAILED_PRECONDITION,
  Status.OUT_OF_RANGE,
  Status.RESOURCE_EXHAUSTED,
  Status.UNIMPLEMENTED,
]);
const grpcCode = (error: unknown) =>
  error && typeof error === 'object' && 'code' in error ? error.code : undefined;

const intervals = {
  '5m': {
    candles: CandleInterval.CANDLE_INTERVAL_5_MIN,
    ema: GetTechAnalysisRequest_IndicatorInterval.INDICATOR_INTERVAL_FIVE_MINUTES,
    stream: SubscriptionInterval.SUBSCRIPTION_INTERVAL_FIVE_MINUTES,
  },
  '15m': {
    candles: CandleInterval.CANDLE_INTERVAL_15_MIN,
    ema: GetTechAnalysisRequest_IndicatorInterval.INDICATOR_INTERVAL_FIFTEEN_MINUTES,
    stream: SubscriptionInterval.SUBSCRIPTION_INTERVAL_FIFTEEN_MINUTES,
  },
  '30m': {
    candles: CandleInterval.CANDLE_INTERVAL_30_MIN,
    ema: GetTechAnalysisRequest_IndicatorInterval.INDICATOR_INTERVAL_30_MIN,
    stream: SubscriptionInterval.SUBSCRIPTION_INTERVAL_30_MIN,
  },
  '1h': {
    candles: CandleInterval.CANDLE_INTERVAL_HOUR,
    ema: GetTechAnalysisRequest_IndicatorInterval.INDICATOR_INTERVAL_ONE_HOUR,
    stream: SubscriptionInterval.SUBSCRIPTION_INTERVAL_ONE_HOUR,
  },
} satisfies Record<
  Timeframe,
  {
    candles: CandleInterval;
    ema: GetTechAnalysisRequest_IndicatorInterval;
    stream: SubscriptionInterval;
  }
>;
const price = ({ units, nano }: Quotation) => units + nano / 1e9;
const brokerDirection = (direction: OrderIntent['direction']) =>
  direction === 'buy' ? OrderDirection.ORDER_DIRECTION_BUY : OrderDirection.ORDER_DIRECTION_SELL;

function marketCandle(
  { time, open, high, low, close }: HistoricCandle | Candle,
  complete: boolean,
): MarketCandle | null {
  if (!time || !open || !high || !low || !close) return null;
  return {
    time: time.getTime(),
    open: price(open),
    high: price(high),
    low: price(low),
    close: price(close),
    complete,
  };
}

const brokerStatuses: Partial<Record<ReportStatus, BrokerOrder['brokerStatus']>> = {
  [ReportStatus.EXECUTION_REPORT_STATUS_FILL]: 'filled',
  [ReportStatus.EXECUTION_REPORT_STATUS_REJECTED]: 'rejected',
  [ReportStatus.EXECUTION_REPORT_STATUS_CANCELLED]: 'cancelled',
  [ReportStatus.EXECUTION_REPORT_STATUS_NEW]: 'new',
  [ReportStatus.EXECUTION_REPORT_STATUS_PARTIALLYFILL]: 'partial',
};

export class InvestSandbox implements SandboxBroker, MarketBroker, Broker, BacktestBroker {
  private current?: { token: string; client: NodeApiClient };

  private async call<T>(token: string, operation: (client: NodeApiClient) => Promise<T>) {
    try {
      const existing = this.current;
      const client =
        existing?.token === token
          ? existing.client
          : await NodeApiClient.create({
              token,
              url: sandboxUrl,
              telemetry: 'disabled',
              useMincifryCertificate: true,
            });
      const result = await operation(client);
      this.current = { token, client };
      return result;
    } catch (error) {
      const code = grpcCode(error);
      if (code === Status.UNAUTHENTICATED || code === Status.PERMISSION_DENIED) {
        throw new SandboxError('SANDBOX_TOKEN_REJECTED');
      }
      throw new SandboxError(
        definiteRejections.has(code) ? 'SANDBOX_OPERATION_REJECTED' : 'SANDBOX_UNREACHABLE',
      );
    }
  }

  accounts(token: string) {
    return this.call(token, async ({ sandbox }) => {
      const { accounts } = await sandbox.getSandboxAccounts(
        { status: AccountStatus.ACCOUNT_STATUS_OPEN },
        requestOptions(),
      );
      return accounts
        .filter((account) => account.status === AccountStatus.ACCOUNT_STATUS_OPEN)
        .map(({ id, name }) => ({ id, name }));
    });
  }

  openAccount(token: string) {
    return this.call(token, async ({ sandbox }) => {
      const { accountId } = await sandbox.openSandboxAccount(
        { name: 'fazan-trading' },
        requestOptions(),
      );
      if (!accountId) throw new Error('Sandbox account ID is missing.');
      return accountId;
    });
  }

  async fundAccount(token: string, accountId: string) {
    await this.call(token, ({ sandbox }) =>
      sandbox.sandboxPayIn(
        {
          accountId,
          amount: { currency: 'rub', units: virtualFundingRubles, nano: 0 },
        },
        requestOptions(),
      ),
    );
  }

  balanceRubles(token: string, accountId: string) {
    return this.call(token, async ({ sandbox }) => {
      const positions = await sandbox.getSandboxPositions({ accountId }, requestOptions());
      if (positions.limitsLoadingInProgress) return null;
      const rubles = positions.money.filter((amount) => amount.currency.toLowerCase() === 'rub');
      return rubles.length ? rubles.reduce((total, amount) => total + price(amount), 0) : null;
    });
  }

  accountIsFlat(token: string, accountId: string) {
    return this.call(token, async ({ sandbox }) => {
      const { orders } = await sandbox.getSandboxOrders({ accountId }, requestOptions());
      if (orders.length > 0) return false;
      const positions = await sandbox.getSandboxPositions({ accountId }, requestOptions());
      if (positions.limitsLoadingInProgress) return null;
      return ![...positions.futures, ...positions.securities, ...positions.options].some(
        (position) => position.balance !== 0 || position.blocked !== 0,
      );
    });
  }

  futures(token: string) {
    return this.call(token, async ({ instruments }) => {
      // The full catalogue includes inactive contracts, which the strategy cannot use.
      const { instruments: contracts } = await instruments.futures(
        { instrumentStatus: InstrumentStatus.INSTRUMENT_STATUS_BASE },
        requestOptions(undefined, 15_000),
      );
      return contracts.map(
        ({ uid, ticker, name, classCode, exchange, expirationDate, apiTradeAvailableFlag }) => ({
          uid,
          ticker,
          name,
          classCode,
          exchange,
          expirationDate: expirationDate?.toISOString() ?? null,
          apiTradeAvailableFlag,
        }),
      );
    });
  }

  backtestFuture(token: string, uid: string) {
    return this.call(token, async ({ instruments }) => {
      const { instrument } = await instruments.futureBy(
        {
          idType: InstrumentIdType.INSTRUMENT_ID_TYPE_UID,
          id: uid,
          classCode: '',
        },
        requestOptions(),
      );
      if (!instrument || instrument.uid !== uid) throw new Error('Unexpected futures contract.');
      const {
        firstTradeDate,
        lastTradeDate,
        expirationDate,
        currency,
        lot,
        minPriceIncrement,
        minPriceIncrementAmount,
      } = instrument;
      return {
        firstTrade: firstTradeDate,
        lastTrade: lastTradeDate ?? expirationDate,
        currency,
        lot,
        priceStep: minPriceIncrement ? price(minPriceIncrement) : null,
        priceStepAmount: minPriceIncrementAmount ? price(minPriceIncrementAmount) : null,
      };
    });
  }

  async verifySelection({ token, accountId, instrumentUid }: TradingConfig) {
    const [accounts, contracts] = await Promise.all([this.accounts(token), this.futures(token)]);
    if (!accounts.some((account) => account.id === accountId))
      throw new SandboxError('SANDBOX_ACCOUNT_UNAVAILABLE');
    if (
      !contracts.some(
        (contract) => contract.uid === instrumentUid && contract.apiTradeAvailableFlag,
      )
    ) {
      throw new SandboxError('FUTURE_UNAVAILABLE');
    }
  }

  accountState({ token, accountId, instrumentUid }: TradingConfig) {
    return this.call(token, async ({ sandbox }) => {
      const { orders } = await sandbox.getSandboxOrders({ accountId }, requestOptions());
      const positions = await sandbox.getSandboxPositions({ accountId }, requestOptions());
      const matching = positions.futures.filter((future) => future.instrumentUid === instrumentUid);
      // The SDK's balance excludes blocked contracts and cannot prove the position is flat in those cases.
      const blocked = matching.some((future) => future.blocked !== 0);
      const unidentified = positions.futures.some(
        (future) => !future.instrumentUid && (future.balance !== 0 || future.blocked !== 0),
      );
      const position =
        positions.limitsLoadingInProgress || blocked || unidentified
          ? null
          : matching.reduce((total, future) => total + future.balance, 0);
      return { position, activeOrders: orders.length > 0 || blocked };
    });
  }

  submit(token: string, order: OrderIntent) {
    return this.call(token, async ({ sandbox }) => {
      const reply = await sandbox
        .postSandboxOrder(
          {
            accountId: order.accountId,
            instrumentId: order.instrumentUid,
            orderId: order.id,
            quantity: order.lots,
            orderType: OrderType.ORDER_TYPE_MARKET,
            timeInForce: TimeInForceType.TIME_IN_FORCE_UNSPECIFIED,
            direction: brokerDirection(order.direction),
            confirmMarginTrade: order.direction === 'sell',
            priceType: PriceType.PRICE_TYPE_UNSPECIFIED,
          },
          requestOptions(),
        )
        .catch((error: unknown) => {
          // A validation error from PostSandboxOrder (e.g. insufficient virtual funds) rejects the request.
          // Other RPC failures, including deadline and already-exists, do not prove it never reached the broker.
          if (grpcCode(error) === Status.INVALID_ARGUMENT) return null;
          throw error;
        });
      if (!reply)
        return { brokerOrderId: null, brokerStatus: 'rejected' as const, executedLots: 0 };
      return {
        brokerOrderId: reply.orderId || null,
        brokerStatus: brokerStatuses[reply.executionReportStatus] ?? 'unknown',
        executedLots: reply.lotsExecuted,
      };
    });
  }

  orderState(
    token: string,
    order: OrderIntent,
    brokerOrderId: string | null,
  ): Promise<BrokerOrder> {
    return this.call(token, async ({ sandbox }) => {
      const state = await sandbox.getSandboxOrderState(
        {
          accountId: order.accountId,
          orderId: brokerOrderId ?? order.id,
          orderIdType: brokerOrderId
            ? OrderIdType.ORDER_ID_TYPE_EXCHANGE
            : OrderIdType.ORDER_ID_TYPE_REQUEST,
          priceType: PriceType.PRICE_TYPE_POINT,
        },
        requestOptions(),
      );
      if (
        !state.orderId ||
        (state.orderRequestId && state.orderRequestId !== order.id) ||
        state.instrumentUid !== order.instrumentUid ||
        state.lotsRequested !== order.lots ||
        state.direction !== brokerDirection(order.direction)
      ) {
        throw new Error('Unexpected sandbox order state.');
      }
      return {
        brokerOrderId: state.orderId,
        brokerStatus: brokerStatuses[state.executionReportStatus] ?? 'unknown',
        executedLots: state.lotsExecuted,
        executions: state.stages.map((stage) => ({
          tradeId: stage.tradeId,
          lots: stage.quantity,
          price: stage.price ? price(stage.price) : null,
          time: stage.executionTime?.getTime() ?? null,
        })),
      };
    });
  }

  candles(
    token: string,
    instrumentId: string,
    timeframe: Timeframe,
    from: Date,
    to: Date,
    signal?: AbortSignal,
  ) {
    return this.call(token, async ({ marketdata }) => {
      const { candles } = await marketdata.getCandles(
        {
          instrumentId,
          from,
          to,
          interval: intervals[timeframe].candles,
        },
        requestOptions(signal),
      );
      return candles
        .map((candle) => marketCandle(candle, candle.isComplete))
        .filter((candle) => candle !== null);
    });
  }

  ema(
    token: string,
    instrumentUid: string,
    timeframe: Timeframe,
    length: number,
    from: Date,
    to: Date,
    signal?: AbortSignal,
  ) {
    return this.call(token, async ({ marketdata }) => {
      const { technicalIndicators } = await marketdata.getTechAnalysis(
        {
          instrumentUid,
          from,
          to,
          length,
          interval: intervals[timeframe].ema,
          indicatorType: GetTechAnalysisRequest_IndicatorType.INDICATOR_TYPE_EMA,
          typeOfPrice: GetTechAnalysisRequest_TypeOfPrice.TYPE_OF_PRICE_CLOSE,
        },
        requestOptions(signal),
      );
      // GetTechAnalysis returns EMA in signal; middleBand is specific to Bollinger Bands.
      return technicalIndicators.flatMap(({ timestamp, signal: ema }) =>
        timestamp && ema ? [{ time: timestamp.getTime(), value: price(ema) }] : [],
      );
    });
  }

  async *stream(token: string, instrumentId: string, timeframe: Timeframe, signal: AbortSignal) {
    const interval = intervals[timeframe].stream;
    const silence = new AbortController();
    const watchdog = setTimeout(() => silence.abort(), 45_000);
    try {
      const responses = await this.call(token, async ({ marketdataStream }) =>
        marketdataStream.marketDataServerSideStream(
          {
            subscribeCandlesRequest: {
              subscriptionAction: SubscriptionAction.SUBSCRIPTION_ACTION_SUBSCRIBE,
              waitingClose: false,
              instruments: [{ instrumentId, interval }],
            },
            pingSettings: { pingDelayMs: 15_000 },
          },
          { signal: AbortSignal.any([signal, silence.signal]) },
        ),
      );
      let subscribed = false;
      for await (const { subscribeCandlesResponse, candle } of responses) {
        watchdog.refresh();
        if (subscribeCandlesResponse) {
          subscribed = subscribeCandlesResponse.candlesSubscriptions.some(
            (subscription) =>
              subscription.instrumentUid === instrumentId &&
              subscription.interval === interval &&
              subscription.subscriptionStatus === SubscriptionStatus.SUBSCRIPTION_STATUS_SUCCESS,
          );
          if (!subscribed) throw new SandboxError('SANDBOX_OPERATION_REJECTED');
          yield { kind: 'subscribed' } as const;
        }
        if (subscribed && candle?.instrumentUid === instrumentId && candle.interval === interval) {
          const update = marketCandle(candle, false);
          if (update) yield { kind: 'candle', candle: update } as const;
        }
      }
    } finally {
      clearTimeout(watchdog);
    }
  }
}
