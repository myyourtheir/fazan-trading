import {
  emptyProtectionLedger,
  ProtectionLedger,
  type ProtectionLedgerState,
} from './protection-ledger.js';
import type { Write } from './protection-transactions.js';

/** Shared explicitly to simulate distinct store instances and restarts. */
export class ProtectionMemory {
  public state = emptyProtectionLedger();
  public failNext: 'precommit' | 'postcommit' | null = null;
}

export class MemoryProtectionTransactions extends ProtectionLedger {
  public constructor(private readonly memory: ProtectionMemory) {
    super({
      read: async () => structuredClone(memory.state),
      write: async <T>(transition: (state: ProtectionLedgerState) => Write<T>) => {
        const next = structuredClone(memory.state);
        const result = transition(next);
        if (!result.ok) return result;
        if (memory.failNext === 'precommit') {
          memory.failNext = null;
          throw new Error('precommit');
        }
        memory.state = structuredClone(next);
        if (memory.failNext === 'postcommit') {
          memory.failNext = null;
          throw new Error('postcommit');
        }
        return structuredClone(result);
      },
    });
  }

  public proofSnapshot() {
    return structuredClone(this.memory.state.proof);
  }
}
