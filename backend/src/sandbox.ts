import type { TokenCipher } from './token-cipher.js';

export const virtualFundingRubles = 100_000;

type Account = { id: string; name: string };
export type SavedSandboxConnection = { encryptedToken: string; accountId: string | null };

export type FutureContract = {
  uid: string;
  ticker: string;
  name: string;
  classCode: string;
  exchange: string;
  expirationDate: string | null;
};

export interface SandboxBroker {
  accounts(token: string): Promise<Account[]>;
  openAccount(token: string): Promise<string>;
  fundAccount(token: string, accountId: string): Promise<void>;
  futures(token: string): Promise<(FutureContract & { apiTradeAvailableFlag: boolean })[]>;
}

export interface SandboxStore {
  load(): Promise<SavedSandboxConnection | null>;
  save(connection: SavedSandboxConnection): Promise<void>;
}

const errorStatus = {
  SANDBOX_TOKEN_REJECTED: 422,
  SANDBOX_ACCOUNT_UNAVAILABLE: 422,
  SANDBOX_OPERATION_REJECTED: 422,
  SANDBOX_UNREACHABLE: 502,
  SANDBOX_CREATION_UNCERTAIN: 502,
  SANDBOX_FUNDING_UNCERTAIN: 502,
  SANDBOX_NOT_CONFIGURED: 409,
  SANDBOX_TOKEN_UNREADABLE: 409,
  SANDBOX_BUSY: 409,
  FUTURE_UNAVAILABLE: 422,
} as const;

export class SandboxError extends Error {
  constructor(readonly code: keyof typeof errorStatus) { super(code); }
  get status() { return errorStatus[this.code]; }
}

function brokerError(error: unknown) {
  return error instanceof SandboxError ? error : new SandboxError('SANDBOX_UNREACHABLE');
}

export class SandboxConnection {
  private busy = false;

  constructor(
    private readonly store: SandboxStore,
    private readonly cipher: TokenCipher,
    private readonly broker: SandboxBroker,
  ) {}

  async status() {
    const saved = await this.store.load();
    if (!saved) return { status: 'unconfigured', accountId: null, accounts: [] };
    try {
      const accounts = await this.listAccounts(this.decrypt(saved));
      return { status: 'connected', accountId: saved.accountId, accounts, virtualFundingRubles };
    } catch (error) {
      return { status: 'unavailable', accountId: saved.accountId, accounts: [], code: brokerError(error).code };
    }
  }

  connect(token: string) {
    return this.change(async () => {
      const accounts = await this.listAccounts(token);
      const previousAccount = (await this.store.load())?.accountId ?? null;
      await this.store.save({
        encryptedToken: this.cipher.encrypt(token),
        accountId: accounts.some(account => account.id === previousAccount) ? previousAccount : null,
      });
    });
  }

  selectAccount(accountId: string) {
    return this.change(async () => {
      const { saved, token } = await this.credentials();
      await this.requireAccount(token, accountId);
      await this.store.save({ ...saved, accountId });
    });
  }

  createAccount() {
    return this.change(async () => {
      const { saved, token } = await this.credentials();
      let accountId: string;
      try {
        accountId = await this.broker.openAccount(token);
      } catch (error) {
        const failure = brokerError(error);
        throw failure.code === 'SANDBOX_UNREACHABLE' ? new SandboxError('SANDBOX_CREATION_UNCERTAIN') : failure;
      }
      await this.store.save({ ...saved, accountId });
    });
  }

  fundAccount(accountId: string) {
    return this.change(async () => {
      const token = await this.selectedAccountToken(accountId);
      try {
        await this.broker.fundAccount(token, accountId);
      } catch (error) {
        const failure = brokerError(error);
        throw failure.code === 'SANDBOX_UNREACHABLE' ? new SandboxError('SANDBOX_FUNDING_UNCERTAIN') : failure;
      }
    });
  }

  async tradableFutures(): Promise<FutureContract[]> {
    const { token } = await this.credentials();
    return this.fetchTradableFutures(token);
  }

  async marketDataToken() {
    const { token } = await this.credentials();
    return token;
  }

  async tradingCredentials() {
    const { saved, token } = await this.credentials();
    if (!saved.accountId) throw new SandboxError('SANDBOX_ACCOUNT_UNAVAILABLE');
    return { token, accountId: saved.accountId };
  }

  changeStrategyForAccount(accountId: string, action: (contracts: FutureContract[]) => Promise<void>) {
    return this.change(async () => {
      const token = await this.selectedAccountToken(accountId);
      await action(await this.fetchTradableFutures(token));
    });
  }

  private async fetchTradableFutures(token: string): Promise<FutureContract[]> {
    try {
      const contracts = await this.broker.futures(token);
      return contracts.filter(contract => contract.uid && contract.apiTradeAvailableFlag)
        .map(({ uid, ticker, name, classCode, exchange, expirationDate }) =>
          ({ uid, ticker, name, classCode, exchange, expirationDate }));
    } catch (error) {
      throw brokerError(error);
    }
  }

  private async change(action: () => Promise<void>) {
    if (this.busy) throw new SandboxError('SANDBOX_BUSY');
    this.busy = true;
    try {
      await action();
    } finally {
      this.busy = false;
    }
  }

  private decrypt(saved: SavedSandboxConnection) {
    try {
      return this.cipher.decrypt(saved.encryptedToken);
    } catch {
      throw new SandboxError('SANDBOX_TOKEN_UNREADABLE');
    }
  }

  private async credentials() {
    const saved = await this.store.load();
    if (!saved) throw new SandboxError('SANDBOX_NOT_CONFIGURED');
    return { saved, token: this.decrypt(saved) };
  }

  private async selectedAccountToken(accountId: string) {
    const { saved, token } = await this.credentials();
    if (saved.accountId !== accountId) throw new SandboxError('SANDBOX_ACCOUNT_UNAVAILABLE');
    await this.requireAccount(token, accountId);
    return token;
  }

  private async listAccounts(token: string) {
    try {
      return await this.broker.accounts(token);
    } catch (error) {
      throw brokerError(error);
    }
  }

  private async requireAccount(token: string, accountId: string) {
    if (!(await this.listAccounts(token)).some(account => account.id === accountId)) {
      throw new SandboxError('SANDBOX_ACCOUNT_UNAVAILABLE');
    }
  }
}
