import { randomUUID } from 'node:crypto';
import { NodeApiClient } from '@ttech-pub/grpc-node-client';
import { InstrumentIdType } from '@ttech-pub/grpc-node-client/compiled/instruments.js';
import {
  ExchangeOrderType,
  StopOrderDirection,
  StopOrderExpirationType,
  StopOrderStatusOption as Status,
  StopOrderType,
} from '@ttech-pub/grpc-node-client/compiled/stoporders.js';
import { AccountStatus } from '@ttech-pub/grpc-node-client/compiled/users.js';

const [accountId, instrumentId = '5bcff194-f10d-4314-b9ee-56b7fdb344fd'] = process.argv.slice(2);
const token = process.env.SANDBOX_TOKEN;
if (!token || !accountId) {
  console.error(
    'Usage: SANDBOX_TOKEN=<sandbox token> node scripts/check-sandbox-stop-idempotency.mjs ACCOUNT_ID [FUTURE_UID]',
  );
  process.exit(2);
}

const options = () => ({ signal: AbortSignal.timeout(8_000) });
const connect = () =>
  NodeApiClient.create({
    token,
    url: 'https://sandbox-invest-public-api.tbank.ru:443',
    useMincifryCertificate: true,
    telemetry: 'disabled',
  });
const value = (q) => (q ? q.units + q.nano / 1e9 : NaN);
const activeStops = async (client) =>
  (
    await client.sandbox.getSandboxStopOrders(
      { accountId, status: Status.STOP_ORDER_STATUS_ACTIVE },
      options(),
    )
  ).stopOrders;

async function assertFlat(client) {
  const { orders } = await client.sandbox.getSandboxOrders({ accountId }, options());
  const p = await client.sandbox.getSandboxPositions({ accountId }, options());
  if (
    orders.length ||
    p.limitsLoadingInProgress ||
    [...p.futures, ...p.securities, ...p.options].some((x) => x.balance || x.blocked)
  ) {
    throw new Error('Expected a sandbox account with no positions or active ordinary orders.');
  }
}

const owned = new Set();
let client;
let attempted = false;
try {
  client = await connect();
  const { accounts } = await client.sandbox.getSandboxAccounts(
    { status: AccountStatus.ACCOUNT_STATUS_OPEN },
    options(),
  );
  if (!accounts.some((a) => a.id === accountId)) throw new Error('Sandbox account is not open.');

  const { instrument } = await client.instruments.futureBy(
    { id: instrumentId, idType: InstrumentIdType.INSTRUMENT_ID_TYPE_UID },
    options(),
  );
  const { lastPrices } = await client.marketdata.getLastPrices(
    { instrumentId: [instrumentId] },
    options(),
  );
  const last = value(lastPrices.find((item) => item.instrumentUid === instrumentId)?.price);
  const tick = value(instrument?.minPriceIncrement);
  const nanos = Math.round(Math.floor((last * 0.8) / tick) * tick * 1e9);
  if (!Number.isSafeInteger(nanos) || nanos <= 0 || nanos / 1e9 >= last)
    throw new Error('No usable quote or price step for a stop below market.');

  await assertFlat(client);
  if ((await activeStops(client)).length) throw new Error('Account already has active stops.');
  const request = {
    accountId,
    instrumentId,
    quantity: 1,
    stopPrice: { units: Math.floor(nanos / 1e9), nano: nanos % 1e9 },
    direction: StopOrderDirection.STOP_ORDER_DIRECTION_SELL,
    expirationType: StopOrderExpirationType.STOP_ORDER_EXPIRATION_TYPE_GOOD_TILL_CANCEL,
    stopOrderType: StopOrderType.STOP_ORDER_TYPE_STOP_LOSS,
    exchangeOrderType: ExchangeOrderType.EXCHANGE_ORDER_TYPE_MARKET,
    orderId: randomUUID(),
    confirmMarginTrade: false,
  };
  console.log('Identical requests:', request);
  attempted = true;
  const first = await client.sandbox.postSandboxStopOrder(request, options());
  if (!first.stopOrderId) throw new Error('First response has no stopOrderId.');
  owned.add(first.stopOrderId);
  console.log('First stopOrderId:', first.stopOrderId);

  client = await connect();
  const second = await client.sandbox.postSandboxStopOrder(request, options());
  if (!second.stopOrderId) throw new Error('Second response has no stopOrderId.');
  owned.add(second.stopOrderId);
  console.log('Second stopOrderId:', second.stopOrderId);

  const active = new Set((await activeStops(client)).map((s) => s.stopOrderId));
  console.log('Active stop IDs:', [...active]);
  if (owned.size === 2 && [...owned].every((id) => active.has(id))) {
    console.error('DUPLICATE: both stops are active for the same orderId.');
    process.exitCode = 1;
  } else if (owned.size === 1 && active.size === 1 && active.has(first.stopOrderId)) {
    console.log('Both responses reference the same active stop.');
  } else {
    throw new Error('Inconclusive: responses do not match the active stop list.');
  }
} catch (error) {
  console.error('Probe inconclusive:', error.message);
  process.exitCode = 2;
} finally {
  if (attempted) {
    for (const stopOrderId of owned) {
      try {
        await client.sandbox.cancelSandboxStopOrder({ accountId, stopOrderId }, options());
      } catch (error) {
        console.error('Could not cancel stop:', stopOrderId, error.message);
        process.exitCode = 2;
      }
    }
    try {
      const remaining = await activeStops(client);
      if (remaining.length) {
        console.error(
          'Active stops remain:',
          remaining.map((s) => s.stopOrderId),
        );
        console.error('Inspect and clean up the sandbox account manually.');
        process.exitCode = 2;
      } else {
        await assertFlat(client);
        console.log('Cleanup verified: no active orders, stops or positions.');
      }
    } catch (error) {
      console.error('Cleanup not confirmed:', error.message);
      process.exitCode = 2;
    }
  }
}
