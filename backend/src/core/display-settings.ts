export const defaultTimeZone = 'UTC';

export interface DisplaySettingsStore {
  loadTimeZone(): Promise<string | null>;
  saveTimeZone(timeZone: string): Promise<void>;
}

export class DisplaySettings {
  constructor(private readonly store: DisplaySettingsStore) {}

  public async get() {
    return { timeZone: (await this.store.loadTimeZone()) ?? defaultTimeZone };
  }

  public async setTimeZone(timeZone: unknown) {
    // Accept named IANA zones, not fixed numeric offsets.
    if (
      typeof timeZone !== 'string' ||
      timeZone.length > 100 ||
      !/^[A-Za-z][A-Za-z0-9_+/-]*$/.test(timeZone)
    )
      return null;
    try {
      new Intl.DateTimeFormat('ru-RU', { timeZone });
    } catch {
      return null;
    }
    await this.store.saveTimeZone(timeZone);
    return { timeZone };
  }
}
