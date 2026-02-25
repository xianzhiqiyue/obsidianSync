export interface QueuedChange {
  id: string;
  op: "create" | "update" | "delete" | "rename" | "move";
  path: string;
  fileId?: string;
  baseVersion?: number;
  contentHash?: string;
  attempts: number;
  ts: number;
}

export interface IndexedFileState {
  fileId: string;
  path: string;
  version: number;
  contentHash: string;
}

export interface SyncFailureState {
  failedQueue: QueuedChange[];
  lastError: string | null;
  consecutiveFailures: number;
  blocked: boolean;
  lastFailedAt: number | null;
}

export interface LocalSyncState {
  checkpoint: string | null;
  queue: QueuedChange[];
  fileIndexByPath: Record<string, IndexedFileState>;
  failure: SyncFailureState;
}

const DEFAULT_FAILURE_STATE: SyncFailureState = {
  failedQueue: [],
  lastError: null,
  consecutiveFailures: 0,
  blocked: false,
  lastFailedAt: null
};

export const DEFAULT_LOCAL_SYNC_STATE: LocalSyncState = {
  checkpoint: null,
  queue: [],
  fileIndexByPath: {},
  failure: DEFAULT_FAILURE_STATE
};

export class LocalStateStore {
  private state: LocalSyncState;
  private readonly onChange: (state: LocalSyncState) => Promise<void>;

  constructor(initialState: LocalSyncState, onChange: (state: LocalSyncState) => Promise<void>) {
    this.state = {
      checkpoint: initialState.checkpoint,
      queue: initialState.queue.map((item) => ({ ...item })),
      fileIndexByPath: { ...initialState.fileIndexByPath },
      failure: {
        failedQueue: initialState.failure.failedQueue.map((item) => ({ ...item })),
        lastError: initialState.failure.lastError,
        consecutiveFailures: initialState.failure.consecutiveFailures,
        blocked: initialState.failure.blocked,
        lastFailedAt: initialState.failure.lastFailedAt
      }
    };
    this.onChange = onChange;
  }

  getSnapshot(): LocalSyncState {
    return {
      checkpoint: this.state.checkpoint,
      queue: this.state.queue.map((item) => ({ ...item })),
      fileIndexByPath: { ...this.state.fileIndexByPath },
      failure: {
        failedQueue: this.state.failure.failedQueue.map((item) => ({ ...item })),
        lastError: this.state.failure.lastError,
        consecutiveFailures: this.state.failure.consecutiveFailures,
        blocked: this.state.failure.blocked,
        lastFailedAt: this.state.failure.lastFailedAt
      }
    };
  }

  getCheckpoint(): string | null {
    return this.state.checkpoint;
  }

  async setCheckpoint(checkpoint: string | null): Promise<void> {
    this.state.checkpoint = checkpoint;
    await this.flush();
  }

  async enqueue(change: QueuedChange): Promise<void> {
    this.state.queue.push(change);
    await this.flush();
  }

  async replaceQueue(queue: QueuedChange[]): Promise<void> {
    this.state.queue = queue.map((item) => ({ ...item }));
    await this.flush();
  }

  async clearQueue(): Promise<void> {
    this.state.queue = [];
    await this.flush();
  }

  getFileIndexByPath(): Record<string, IndexedFileState> {
    return { ...this.state.fileIndexByPath };
  }

  async replaceFileIndexByPath(indexByPath: Record<string, IndexedFileState>): Promise<void> {
    this.state.fileIndexByPath = { ...indexByPath };
    await this.flush();
  }

  getFailureState(): SyncFailureState {
    return {
      failedQueue: this.state.failure.failedQueue.map((item) => ({ ...item })),
      lastError: this.state.failure.lastError,
      consecutiveFailures: this.state.failure.consecutiveFailures,
      blocked: this.state.failure.blocked,
      lastFailedAt: this.state.failure.lastFailedAt
    };
  }

  async recordFailure(errorMessage: string, retryable: boolean): Promise<void> {
    const failedQueue = this.state.queue.map((item) => ({
      ...item,
      attempts: item.attempts + 1
    }));
    this.state.failure = {
      failedQueue,
      lastError: errorMessage,
      consecutiveFailures: this.state.failure.consecutiveFailures + 1,
      blocked: !retryable,
      lastFailedAt: Date.now()
    };
    await this.flush();
  }

  async clearFailureState(): Promise<void> {
    this.state.failure = {
      ...DEFAULT_FAILURE_STATE
    };
    await this.flush();
  }

  private async flush(): Promise<void> {
    await this.onChange(this.getSnapshot());
  }
}
