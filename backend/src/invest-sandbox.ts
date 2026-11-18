import { NodeApiClient } from '@ttech-pub/grpc-node-client';
import { InstrumentStatus } from '@ttech-pub/grpc-node-client/compiled/common.js';
import { AccountStatus } from '@ttech-pub/grpc-node-client/compiled/users.js';
import { Status } from 'nice-grpc';
import { SandboxError, virtualFundingRubles, type SandboxBroker } from './sandbox.js';

const sandboxUrl = 'https://sandbox-invest-public-api.tbank.ru:443';
const requestOptions = () => ({ signal: AbortSignal.timeout(8_000) });
const definiteRejections = new Set<unknown>([
  Status.INVALID_ARGUMENT, Status.NOT_FOUND, Status.ALREADY_EXISTS, Status.FAILED_PRECONDITION,
  Status.OUT_OF_RANGE, Status.RESOURCE_EXHAUSTED, Status.UNIMPLEMENTED,
]);

export class InvestSandbox implements SandboxBroker {
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
}
