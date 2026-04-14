export interface QueuedChange {
  id: string;
  op: "create" | "update" | "delete" | "rename" | "move";
  path: string;
  fileId?: string;
  baseVersion?: number;
  contentHash?: string;
  mtimeMs?: number;
  ctimeMs?: number;
  attempts: number;
  ts: number;
}

export interface IndexedFileState {
  fileId: string;
  path: string;
  version: number;
  contentHash: string;
  mtimeMs?: number;
  ctimeMs?: number;
}

export interface SyncFailureState {
  failedQueue: QueuedChange[];
  lastError: string | null;
  consecutiveFailures: number;
  blocked: boolean;
  lastFailedAt: number | null;
}

export interface PendingConflictSummary {
  id: string;
  code: string;
  path: string;
  fileId?: string;
  message: string;
  localPreview: string | null;
  localContentBase64: string | null;
  remoteSummary: string | null;
  recommendedAction: "use_local" | "use_remote" | "defer";
  recommendedReason: string;
  remoteDeleted: boolean;
}

export interface PendingConflictState {
  items: PendingConflictSummary[];
  deferredAt: number | null;
}

export interface LocalSyncState {
  checkpoint: string | null;
  queue: QueuedChange[];
  fileIndexByPath: Record<string, IndexedFileState>;
  failure: SyncFailureState;
  pendingConflicts: PendingConflictState;
}

function normalizePendingConflictItems(items: PendingConflictSummary[]): PendingConflictSummary[] {
  return items.map((item) => ({
    id: item.id,
    code: item.code,
    path: item.path,
    fileId: item.fileId,
    message: item.message,
    localPreview: item.localPreview ?? null,
    localContentBase64: item.localContentBase64 ?? null,
    remoteSummary: item.remoteSummary ?? null,
    recommendedAction: item.recommendedAction ?? "defer",
    recommendedReason: item.recommendedReason ?? "当前信息不足，建议先人工确认后再决定。",
    remoteDeleted: item.remoteDeleted ?? false
  }));
}

const DEFAULT_FAILURE_STATE: SyncFailureState = {
  failedQueue: [],
  lastError: null,
  consecutiveFailures: 0,
  blocked: false,
  lastFailedAt: null
};

const DEFAULT_PENDING_CONFLICT_STATE: PendingConflictState = {
  items: [],
  deferredAt: null
};

export const DEFAULT_LOCAL_SYNC_STATE: LocalSyncState = {
  checkpoint: null,
  queue: [],
  fileIndexByPath: {},
  failure: DEFAULT_FAILURE_STATE,
  pendingConflicts: DEFAULT_PENDING_CONFLICT_STATE
};

export class LocalStateStore {
  private state: LocalSyncState;
  private readonly onChange: (state: LocalSyncState) => Promise<void>;

  constructor(
    initialState: LocalSyncState | (Omit<LocalSyncState, "pendingConflicts"> & { pendingConflicts?: PendingConflictState }),
    onChange: (state: LocalSyncState) => Promise<void>
  ) {
    const pendingConflicts = initialState.pendingConflicts ?? DEFAULT_PENDING_CONFLICT_STATE;
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
      },
      pendingConflicts: {
        items: normalizePendingConflictItems(pendingConflicts.items),
        deferredAt: pendingConflicts.deferredAt
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
      },
      pendingConflicts: {
        items: normalizePendingConflictItems(this.state.pendingConflicts.items),
        deferredAt: this.state.pendingConflicts.deferredAt
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

  getPendingConflicts(): PendingConflictState {
    return {
      items: normalizePendingConflictItems(this.state.pendingConflicts.items),
      deferredAt: this.state.pendingConflicts.deferredAt
    };
  }

  async setPendingConflicts(items: PendingConflictSummary[], deferredAt = Date.now()): Promise<void> {
    this.state.pendingConflicts = {
      items: normalizePendingConflictItems(items),
      deferredAt
    };
    await this.flush();
  }

  async clearPendingConflicts(): Promise<void> {
    this.state.pendingConflicts = {
      ...DEFAULT_PENDING_CONFLICT_STATE
    };
    await this.flush();
  }

  private async flush(): Promise<void> {
    await this.onChange(this.getSnapshot());
  }
}
