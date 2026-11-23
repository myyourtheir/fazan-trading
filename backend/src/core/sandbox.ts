export const virtualFundingRubles = 100_000;

type Account = { id: string; name: string };
export type SavedSandboxConnection = {
  encryptedToken: string;
  accountId: string | null;
  previousAccountId?: string | null;
  previousEncryptedToken?: string | null;
};

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
  balanceRubles(token: string, accountId: string): Promise<number | null>;
  accountIsFlat(token: string, accountId: string): Promise<boolean | null>;
  futures(token: string): Promise<(FutureContract & { apiTradeAvailableFlag: boolean })[]>;
}

export interface SandboxStore {
  load(): Promise<SavedSandboxConnection | null>;
  save(connection: SavedSandboxConnection): Promise<void>;
}

export interface TokenCipher {
  encrypt(token: string): string;
  decrypt(encryptedToken: string): string;
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
  SANDBOX_ACCOUNT_NOT_FLAT: 409,
  SANDBOX_ACCOUNT_FLAT_UNVERIFIED: 409,
  FUTURE_SELECTION_EXPIRED: 409,
  FUTURE_UNAVAILABLE: 422,
} as const;

export class SandboxError extends Error {
  constructor(readonly code: keyof typeof errorStatus) {
    super(code);
  }
  public get status() {
    return errorStatus[this.code];
  }
}

function brokerError(error: unknown) {
  return error instanceof SandboxError ? error : new SandboxError('SANDBOX_UNREACHABLE');
}

export class SandboxConnection {
  private busy = false;
  private offeredFutures?: { encryptedToken: string; contracts: Map<string, FutureContract> };

  constructor(
    private readonly store: SandboxStore,
    private readonly cipher: TokenCipher,
    private readonly broker: SandboxBroker,
  ) {}

  public async status() {
    const saved = await this.store.load();
    if (!saved) return { status: 'unconfigured', accountId: null, accounts: [] };
    try {
      const accounts = await this.listAccounts(this.decrypt(saved));
      return { status: 'connected', accountId: saved.accountId, accounts, virtualFundingRubles };
    } catch (error) {
      return {
        status: 'unavailable',
        accountId: saved.accountId,
        accounts: [],
        code: brokerError(error).code,
      };
    }
  }

  public connect(token: string, pinnedAccountId?: string) {
    return this.change(async () => {
      const accounts = await this.listAccounts(token);
      const saved = await this.store.load();
      const accountId = accounts.find((account) => account.id === saved?.accountId)?.id ?? null;
      if (pinnedAccountId !== undefined && accountId !== pinnedAccountId) {
        throw new SandboxError('SANDBOX_ACCOUNT_UNAVAILABLE');
      }
      // Credential repair must not silently change the selected account.
      if (saved?.accountId && saved.accountId !== accountId)
        throw new SandboxError('SANDBOX_ACCOUNT_UNAVAILABLE');
      await this.store.save({
        ...saved,
        encryptedToken: this.cipher.encrypt(token),
        accountId,
      });
      this.offeredFutures = undefined;
    });
  }

  public selectAccount(accountId: string) {
    return this.change(async () => {
      const { saved, token } = await this.credentials();
      await this.requireAccount(token, accountId);
      if (saved.accountId === accountId) return;
      await this.requireFlatAccount(saved);
      await this.requireFlatAccount({ ...saved, accountId });
      await this.store.save({
        ...saved,
        accountId,
        previousAccountId: saved.accountId,
        previousEncryptedToken: saved.accountId ? saved.encryptedToken : null,
      });
    });
  }

  public createAccount() {
    return this.change(async () => {
      const { saved, token } = await this.credentials();
      await this.requireFlatAccount(saved);
      let accountId: string;
      try {
        accountId = await this.broker.openAccount(token);
      } catch (error) {
        const failure = brokerError(error);
        throw failure.code === 'SANDBOX_UNREACHABLE'
          ? new SandboxError('SANDBOX_CREATION_UNCERTAIN')
          : failure;
      }
      await this.requireFlatAccount({ ...saved, accountId });
      await this.store.save({
        ...saved,
        accountId,
        previousAccountId: saved.accountId,
        previousEncryptedToken: saved.accountId ? saved.encryptedToken : null,
      });
    });
  }

  public fundAccount(accountId: string) {
    return this.change(async () => {
      const { token } = await this.selectedAccountCredentials(accountId);
      try {
        await this.broker.fundAccount(token, accountId);
      } catch (error) {
        const failure = brokerError(error);
        throw failure.code === 'SANDBOX_UNREACHABLE'
          ? new SandboxError('SANDBOX_FUNDING_UNCERTAIN')
          : failure;
      }
    });
  }

  public async balance(accountId: string) {
    const { saved, token } = await this.credentials();
    if (saved.accountId !== accountId) throw new SandboxError('SANDBOX_ACCOUNT_UNAVAILABLE');
    try {
      return { accountId, rubles: await this.broker.balanceRubles(token, accountId) };
    } catch (error) {
      throw brokerError(error);
    }
  }

  public async searchFutures(query: string): Promise<FutureContract[]> {
    const {
      saved: { encryptedToken },
      token,
    } = await this.credentials();
    const term = query.toLowerCase();
    const matches = (await this.fetchTradableFutures(token)).filter(
      ({ ticker, name }) =>
        ticker.toLowerCase().includes(term) || name.toLowerCase().includes(term),
    );

    // An in-flight search can finish after the token is replaced.
    if ((await this.store.load())?.encryptedToken === encryptedToken) {
      const offered =
        this.offeredFutures?.encryptedToken === encryptedToken
          ? this.offeredFutures
          : { encryptedToken, contracts: new Map<string, FutureContract>() };
      for (const contract of matches) offered.contracts.set(contract.uid, contract);
      this.offeredFutures = offered;
    }
    return matches;
  }

  public async marketDataToken() {
    const { token } = await this.credentials();
    return token;
  }

  public async tradingCredentials() {
    const { saved, token } = await this.credentials();
    if (!saved.accountId) throw new SandboxError('SANDBOX_ACCOUNT_UNAVAILABLE');
    return { token, accountId: saved.accountId };
  }

  // Fresh starts are different from recovery: both sides of the last switch
  // must still be clean even if either account changed outside the application.
  public async verifyFreshStart() {
    const { saved } = await this.credentials();
    if (!saved.accountId) throw new SandboxError('SANDBOX_ACCOUNT_UNAVAILABLE');
    if (saved.previousAccountId) {
      if (!saved.previousEncryptedToken) throw new SandboxError('SANDBOX_ACCOUNT_FLAT_UNVERIFIED');
      await this.requireFlatAccount({
        accountId: saved.previousAccountId,
        encryptedToken: saved.previousEncryptedToken,
      });
    }
    await this.requireFlatAccount(saved);
  }

  public changeStrategySelection(accountId: string, action: () => Promise<void>) {
    return this.change(async () => {
      const { saved } = await this.selectedAccountCredentials(accountId);
      await this.requireFlatAccount(saved);
      await action();
    });
  }

  public changeStrategyForAccount(
    accountId: string,
    instrumentUid: string,
    action: (contract: FutureContract) => Promise<void>,
  ) {
    return this.change(async () => {
      const { saved } = await this.selectedAccountCredentials(accountId);
      await this.requireFlatAccount(saved);
      const offered = this.offeredFutures;
      if (offered?.encryptedToken !== saved.encryptedToken)
        throw new SandboxError('FUTURE_SELECTION_EXPIRED');
      const contract = offered.contracts.get(instrumentUid);
      if (!contract) throw new SandboxError('FUTURE_UNAVAILABLE');
      await action(contract);
    });
  }

  private async fetchTradableFutures(token: string): Promise<FutureContract[]> {
    try {
      const contracts = await this.broker.futures(token);
      return contracts
        .filter((contract) => contract.uid && contract.apiTradeAvailableFlag)
        .map(({ uid, ticker, name, classCode, exchange, expirationDate }) => ({
          uid,
          ticker,
          name,
          classCode,
          exchange,
          expirationDate,
        }));
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

  private async selectedAccountCredentials(accountId: string) {
    const credentials = await this.credentials();
    if (credentials.saved.accountId !== accountId)
      throw new SandboxError('SANDBOX_ACCOUNT_UNAVAILABLE');
    await this.requireAccount(credentials.token, accountId);
    return credentials;
  }

  private async listAccounts(token: string) {
    try {
      return await this.broker.accounts(token);
    } catch (error) {
      throw brokerError(error);
    }
  }

  private async requireAccount(token: string, accountId: string) {
    if (!(await this.listAccounts(token)).some((account) => account.id === accountId)) {
      throw new SandboxError('SANDBOX_ACCOUNT_UNAVAILABLE');
    }
  }

  private async requireFlatAccount(saved: SavedSandboxConnection) {
    if (!saved.accountId) return;
    const flat = await this.broker
      .accountIsFlat(this.decrypt(saved), saved.accountId)
      .catch(() => null);
    if (flat === null) throw new SandboxError('SANDBOX_ACCOUNT_FLAT_UNVERIFIED');
    if (!flat) throw new SandboxError('SANDBOX_ACCOUNT_NOT_FLAT');
  }
}
