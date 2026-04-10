import { App, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder } from "obsidian";
import {
  type SyncChangeRequest,
  type SyncConflict,
  type SyncPullChange,
  type UploadTarget,
  SyncApiClient,
  SyncApiError
} from "./api-client";
import {
  DEFAULT_LOCAL_SYNC_STATE,
  LocalStateStore,
  type IndexedFileState,
  type LocalSyncState,
  type PendingConflictSummary
} from "./state-store";
import {
  openConflictAcknowledgeModal,
  openConflictResolutionModal,
  type ConflictResolutionCandidate
} from "./conflict-resolution-modal";
import {
  areAllConflictsLocalDeletes,
  collectLocalDeletionPaths,
  pruneMissingFileIndexEntries
} from "./sync-conflicts";
import { applyRemoteChangesToIndex } from "./sync-remote-index";
import { buildLocalPlan, isConflictCopyPath, normalizeQueuedChanges, type LocalFileSnapshot } from "./sync-planner";
import {
  buildRemoteSummary,
  createTextPreview,
  getConflictRecommendationReason,
  getRecommendedConflictAction
} from "./sync-conflict-candidates";
import { shouldNotifyBlocked, shouldNotifyFailure } from "./sync-notify";
import { runWithRetry } from "./sync-retry";

type DevicePlatform = "macos" | "windows" | "android" | "ios" | "linux" | "unknown";

interface SyncPluginSettings {
  apiBaseUrl: string;
  email: string;
  password: string;
  vaultId: string;
  deviceName: string;
  syncIntervalMinutes: number;
  enableDebugPanel: boolean;
}

interface AuthState {
  deviceId: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  accessTokenExpiresAtMs: number | null;
}

interface PluginPersistedData {
  settings: SyncPluginSettings;
  state: LocalSyncState;
  auth: AuthState;
}

const DEFAULT_SETTINGS: SyncPluginSettings = {
  apiBaseUrl: "http://localhost:3000/api/v1",
  email: "",
  password: "",
  vaultId: "",
  deviceName: "obsidian-device",
  syncIntervalMinutes: 5,
  enableDebugPanel: true
};

const DEFAULT_AUTH_STATE: AuthState = {
  deviceId: null,
  accessToken: null,
  refreshToken: null,
  accessTokenExpiresAtMs: null
};

const SYNC_ATTEMPT_TIMEOUT_MS = 120_000;
const FOREGROUND_SYNC_MIN_INTERVAL_MS = 15_000;
const BLOCKED_NOTICE_COOLDOWN_MS = 10 * 60_000;
const FAILURE_NOTICE_COOLDOWN_MS = 5 * 60_000;
const BACKGROUND_FAILURE_NOTICE_MIN_CONSECUTIVE = 3;
const MAX_UPLOAD_CONCURRENCY = 3;
const MAX_DOWNLOAD_CONCURRENCY = 3;
const REMOTE_CHANGE_BATCH_SIZE = 20;

type SyncRunResult = "idle" | "success" | "failed" | "blocked" | "skipped";

class SyncConflictResolutionRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncConflictResolutionRequiredError";
  }
}

export default class CustomSyncPlugin extends Plugin {
  settings: SyncPluginSettings = { ...DEFAULT_SETTINGS };
  authState: AuthState = { ...DEFAULT_AUTH_STATE };
  stateStore!: LocalStateStore;
  private syncTimer: number | null = null;
  private syncInProgress = false;
  private pendingSync = false;
  private lastForegroundSyncAtMs = 0;
  private lastSyncReason = "none";
  private lastSyncResult: SyncRunResult = "idle";
  private lastSyncStartedAtMs: number | null = null;
  private lastSyncFinishedAtMs: number | null = null;
  private lastSyncError: string | null = null;
  private lastBlockedNoticeAtMs = 0;
  private lastFailureNoticeAtMs = 0;

  async onload(): Promise<void> {
    const loaded = await this.loadPersistedData();
    this.settings = loaded.settings;
    this.authState = loaded.auth;
    this.stateStore = new LocalStateStore(loaded.state, async (state) => {
      await this.persist(state);
    });

    this.addSettingTab(new SyncSettingTab(this.app, this));
    this.addCommand({
      id: "custom-sync-login",
      name: "登录同步服务",
      callback: () => void this.login()
    });
    this.addCommand({
      id: "custom-sync-run-once",
      name: "执行一次同步",
      callback: () => void this.runSyncOnce("manual-command")
    });
    this.addCommand({
      id: "custom-sync-logout",
      name: "清除登录会话",
      callback: () => void this.logout()
    });
    this.addCommand({
      id: "custom-sync-clear-failure-state",
      name: "清除同步失败状态",
      callback: () => void this.clearFailureState()
    });
    this.addCommand({
      id: "custom-sync-resolve-pending-conflicts",
      name: "处理待决冲突",
      callback: () => void this.runSyncOnce("manual-command")
    });
    this.addCommand({
      id: "custom-sync-clear-pending-conflicts",
      name: "清除待决冲突",
      callback: () => void this.clearPendingConflicts()
    });
    this.addCommand({
      id: "custom-sync-clean-legacy-conflict-files",
      name: "清理历史冲突文件",
      callback: () => void this.cleanLegacyConflictFiles()
    });

    this.setupTimer();
    this.setupForegroundResumeHooks();
    new Notice("自建同步插件已加载");
  }

  onunload(): void {
    if (this.syncTimer !== null) {
      window.clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  async login(): Promise<void> {
    if (!this.settings.email || !this.settings.password) {
      new Notice("请先在插件设置中填写邮箱和密码。");
      return;
    }

    const client = this.getApiClient();
    try {
      const response = await client.login({
        email: this.settings.email,
        password: this.settings.password,
        deviceName: this.settings.deviceName,
        platform: this.detectPlatform(),
        pluginVersion: this.manifest.version
      });

      this.authState = {
        deviceId: response.deviceId,
        accessToken: response.accessToken,
        refreshToken: response.refreshToken,
        accessTokenExpiresAtMs: Date.now() + response.expiresIn * 1000
      };
      await this.persist();
      new Notice(`登录成功。设备 ID=${response.deviceId}`);
    } catch (error) {
      new Notice(`登录失败：${this.stringifyError(error)}`);
      throw error;
    }
  }

  async logout(): Promise<void> {
    this.authState = { ...DEFAULT_AUTH_STATE };
    await this.persist();
    new Notice("已清除登录会话。");
  }

  async runSyncOnce(reason = "manual"): Promise<void> {
    if (this.syncInProgress) {
      this.pendingSync = true;
      if (this.isInteractiveTrigger(reason)) {
        new Notice("同步正在执行中，已加入下一次队列。");
      }
      return;
    }

    this.syncInProgress = true;
    this.lastSyncReason = reason;
    this.lastSyncStartedAtMs = Date.now();
    this.lastSyncResult = "idle";
    try {
      await this.runSyncWithRetry(reason);
    } finally {
      this.syncInProgress = false;
      this.lastSyncFinishedAtMs = Date.now();
      if (this.pendingSync) {
        this.pendingSync = false;
        void this.runSyncOnce("queued");
      }
    }
  }

  async clearFailureState(): Promise<void> {
    await this.stateStore.clearFailureState();
    new Notice("已清除同步失败状态。");
  }

  async clearPendingConflicts(): Promise<void> {
    await this.stateStore.clearPendingConflicts();
    new Notice("已清除待决冲突。");
  }

  async cleanLegacyConflictFiles(): Promise<void> {
    const legacyFiles = this.app.vault.getFiles().filter((file) => isConflictCopyPath(file.path));
    if (legacyFiles.length === 0) {
      new Notice("当前没有历史冲突文件。");
      return;
    }

    for (const file of legacyFiles) {
      await this.app.vault.delete(file, true);
    }

    new Notice(`已清理 ${legacyFiles.length} 个历史冲突文件。`);
  }

  private async runSyncWithRetry(reason: string): Promise<void> {
    if (!this.settings.vaultId) {
      this.lastSyncResult = "skipped";
      this.lastSyncError = "缺少 Vault ID";
      if (this.isInteractiveTrigger(reason)) {
        new Notice("请先在插件设置中填写 Vault ID。");
      }
      return;
    }

    const failure = this.stateStore.getFailureState();
    if (failure.blocked && !this.isInteractiveTrigger(reason)) {
      this.lastSyncResult = "blocked";
      this.lastSyncError = failure.lastError ?? "同步已阻塞";
      const blockedMessage = `由于上次不可重试错误，当前自动同步已暂停：${failure.lastError ?? "未知错误"}。修复后请手动执行一次同步。`;
      if (this.shouldNotifyBlocked(reason)) {
        new Notice(blockedMessage);
      }
      return;
    }

    const pendingConflicts = this.stateStore.getPendingConflicts();
    if (pendingConflicts.items.length > 0 && !this.isInteractiveTrigger(reason)) {
      this.lastSyncResult = "skipped";
      this.lastSyncError = `存在 ${pendingConflicts.items.length} 个待处理冲突`;
      return;
    }
    if (pendingConflicts.items.length > 0 && this.isInteractiveTrigger(reason)) {
      const pendingResolution = await this.resolvePendingConflictsInteractively();
      if (pendingResolution === "defer") {
        this.lastSyncResult = "skipped";
        this.lastSyncError = `存在 ${pendingConflicts.items.length} 个待处理冲突`;
        return;
      }
    }

    const result = await runWithRetry({
      maxAttempts: 3,
      timeoutMs: SYNC_ATTEMPT_TIMEOUT_MS,
      runAttempt: async (signal) => {
        await this.runSyncOnceInternal(signal);
      },
      isRetryableError: (error) => this.isRetryableError(error),
      toMessage: (error) => this.stringifyError(error),
      sleep: async (ms) => {
        await this.sleep(ms);
      },
      onAttemptFailure: async (failure) => {
        if (failure.error instanceof SyncConflictResolutionRequiredError) {
          return;
        }
        await this.stateStore.recordFailure(failure.message, failure.retryable);
      }
    });

    if (result.status === "success") {
      await this.stateStore.clearFailureState();
      await this.stateStore.clearPendingConflicts();
      this.lastSyncResult = "success";
      this.lastSyncError = null;
      return;
    }

    if (result.lastFailure) {
      if (result.lastFailure.error instanceof SyncConflictResolutionRequiredError) {
        this.lastSyncResult = "skipped";
        this.lastSyncError = result.lastFailure.message;
        if (this.isInteractiveTrigger(reason)) {
          new Notice(result.lastFailure.message);
        }
        return;
      }
      this.lastSyncResult = "failed";
      this.lastSyncError = result.lastFailure.message;
      const failureState = this.stateStore.getFailureState();
      if (this.shouldNotifyFailure(reason, failureState.consecutiveFailures)) {
        new Notice(`同步失败：${result.lastFailure.message}`);
      }
      if (this.settings.enableDebugPanel) {
        console.error("[custom-sync] sync failed", result.lastFailure.error);
      }
      return;
    }

    this.lastSyncResult = "failed";
    this.lastSyncError = "同步失败";
  }

  private async runSyncOnceInternal(signal: AbortSignal, resolutionDepth = 0): Promise<void> {
    if (resolutionDepth > 1) {
      throw new Error("冲突自动重试次数过多，请稍后手动重试。");
    }
    this.throwIfAborted(signal);
    const client = this.getApiClient();
    const token = await this.ensureAccessToken(signal);
    const localCheckpoint = this.stateStore.getCheckpoint();
    let initialCheckpoint = this.checkpointToNumber(localCheckpoint);
    let pullFromCheckpoint = initialCheckpoint;
    let currentIndex = this.stateStore.getFileIndexByPath();
    let failedQueue = this.stateStore.getFailureState().failedQueue;
    const initialState = await client.getSyncState(token, this.settings.vaultId, signal);
    const initialServerCheckpoint = this.checkpointToNumber(initialState.checkpoint);
    if (initialServerCheckpoint < initialCheckpoint) {
      const rebuilt = await this.rebuildRemoteBaseline(client, token, initialServerCheckpoint, signal);
      initialCheckpoint = rebuilt.checkpoint;
      pullFromCheckpoint = rebuilt.checkpoint;
      currentIndex = rebuilt.index;
      failedQueue = [];
      if (this.settings.enableDebugPanel) {
        console.warn("[custom-sync] server checkpoint rolled back", {
          localCheckpoint: localCheckpoint ?? "cp_0",
          serverCheckpoint: initialState.checkpoint,
          rebuiltCheckpoint: `cp_${rebuilt.checkpoint}`
        });
      }
      if (this.isInteractiveTrigger(this.lastSyncReason)) {
        new Notice("检测到服务端检查点回退，已重建同步索引并重新计算本地变更。");
      }
    }

    const localSnapshots = await this.collectLocalSnapshots(signal);
    const localPlan = buildLocalPlan(failedQueue, localSnapshots, currentIndex);
    await this.stateStore.replaceQueue(localPlan.queuePreview);
    if (this.settings.enableDebugPanel) {
      console.info("[custom-sync] local plan source", localPlan.source);
      if (localPlan.source === "replay") {
        console.info("[custom-sync] replay dropped failed items", localPlan.droppedFailedItems);
      }
    }

    if (localPlan.changes.length > 0) {
      this.throwIfAborted(signal);
      const prepare = await client.prepare(token, this.settings.vaultId, initialCheckpoint, localPlan.changes, signal);
      if (prepare.conflicts.length > 0) {
        const resolution = await this.handlePrepareConflicts(
          client,
          token,
          currentIndex,
          localPlan,
          prepare.conflicts,
          this.isInteractiveTrigger(this.lastSyncReason),
          signal
        );
        if (resolution === "retry") {
          await this.runSyncOnceInternal(signal, resolutionDepth + 1);
          return;
        }
        throw new SyncConflictResolutionRequiredError(
          `发现 ${prepare.conflicts.length} 个冲突，已保存本地待解决内容并回放远端最新状态。请先处理待决冲突，再重新同步。`
        );
      }

      await this.uploadTargetsWithConcurrency(client, prepare.uploadTargets, localPlan.hashToSnapshot, signal);

      await client.commit(token, this.settings.vaultId, prepare.prepareId, crypto.randomUUID(), signal);
    }

    const state = await client.getSyncState(token, this.settings.vaultId, signal);
    const serverCheckpoint = this.checkpointToNumber(state.checkpoint);
    if (serverCheckpoint < pullFromCheckpoint) {
      pullFromCheckpoint = serverCheckpoint;
    }

    let nextCheckpoint = pullFromCheckpoint;
    let updatedIndex = { ...currentIndex };
    while (true) {
      this.throwIfAborted(signal);
      const pulled = await client.pull(token, this.settings.vaultId, nextCheckpoint, 200, signal);
      if (pulled.changes.length > 0) {
        updatedIndex = await this.applyRemoteChanges(client, token, updatedIndex, pulled.changes, signal);
        await this.stateStore.replaceFileIndexByPath(updatedIndex);
      }

      await this.stateStore.setCheckpoint(pulled.toCheckpoint);
      nextCheckpoint = this.checkpointToNumber(pulled.toCheckpoint);
      if (!pulled.hasMore) {
        break;
      }
    }

    await this.stateStore.clearQueue();

    const snapshot = this.stateStore.getSnapshot();
    if (this.settings.enableDebugPanel) {
      console.info("[custom-sync] local changes", localPlan.changes);
      console.info("[custom-sync] checkpoint", snapshot.checkpoint);
      console.info("[custom-sync] queue", snapshot.queue.length);
    }

    new Notice(
      `同步完成。本地变更=${localPlan.changes.length}，队列=${snapshot.queue.length}，检查点=${snapshot.checkpoint}`
    );
  }

  async saveSettings(): Promise<void> {
    await this.persist();
    this.setupTimer();
  }

  private async ensureAccessToken(signal?: AbortSignal): Promise<string> {
    const now = Date.now();
    const refreshThresholdMs = 10_000;
    if (
      this.authState.accessToken &&
      this.authState.accessTokenExpiresAtMs &&
      this.authState.accessTokenExpiresAtMs - now > refreshThresholdMs
    ) {
      return this.authState.accessToken;
    }

    if (!this.authState.refreshToken) {
      throw new Error("当前未登录，请先执行登录。");
    }

    const client = this.getApiClient();
    const refreshed = await client.refresh(this.authState.refreshToken, signal);
    this.authState = {
      ...this.authState,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      accessTokenExpiresAtMs: Date.now() + refreshed.expiresIn * 1000
    };
    await this.persist();

    return refreshed.accessToken;
  }

  private getApiClient(): SyncApiClient {
    return new SyncApiClient(this.settings.apiBaseUrl.trim());
  }

  private detectPlatform(): DevicePlatform {
    if (this.app.isMobile) {
      return "android";
    }

    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes("mac")) return "macos";
    if (ua.includes("win")) return "windows";
    if (ua.includes("linux")) return "linux";
    return "unknown";
  }

  private async loadPersistedData(): Promise<PluginPersistedData> {
    const data = (await this.loadData()) as Partial<PluginPersistedData> | null;
    const queue = normalizeQueuedChanges(data?.state?.queue);
    const failedQueue = normalizeQueuedChanges(data?.state?.failure?.failedQueue);
    return {
      settings: {
        ...DEFAULT_SETTINGS,
        ...(data?.settings ?? {})
      },
      state: {
        checkpoint: data?.state?.checkpoint ?? DEFAULT_LOCAL_SYNC_STATE.checkpoint,
        queue,
        fileIndexByPath: data?.state?.fileIndexByPath ?? {},
        failure: {
          failedQueue,
          lastError: data?.state?.failure?.lastError ?? DEFAULT_LOCAL_SYNC_STATE.failure.lastError,
          consecutiveFailures:
            data?.state?.failure?.consecutiveFailures ?? DEFAULT_LOCAL_SYNC_STATE.failure.consecutiveFailures,
          blocked: data?.state?.failure?.blocked ?? DEFAULT_LOCAL_SYNC_STATE.failure.blocked,
          lastFailedAt: data?.state?.failure?.lastFailedAt ?? DEFAULT_LOCAL_SYNC_STATE.failure.lastFailedAt
        },
        pendingConflicts: {
          items: data?.state?.pendingConflicts?.items ?? DEFAULT_LOCAL_SYNC_STATE.pendingConflicts.items,
          deferredAt:
            data?.state?.pendingConflicts?.deferredAt ?? DEFAULT_LOCAL_SYNC_STATE.pendingConflicts.deferredAt
        }
      },
      auth: {
        ...DEFAULT_AUTH_STATE,
        ...(data?.auth ?? {})
      }
    };
  }

  private async persist(stateOverride?: LocalSyncState): Promise<void> {
    const persisted: PluginPersistedData = {
      settings: this.settings,
      state: stateOverride ?? this.stateStore.getSnapshot(),
      auth: this.authState
    };
    await this.saveData(persisted);
  }

  private async collectLocalSnapshots(signal: AbortSignal): Promise<Record<string, LocalFileSnapshot>> {
    const result: Record<string, LocalFileSnapshot> = {};
    for (const file of this.app.vault.getFiles()) {
      this.throwIfAborted(signal);
      if (file.path.startsWith(".obsidian/")) {
        continue;
      }
      if (isConflictCopyPath(file.path)) {
        continue;
      }
      const bytes = await this.app.vault.readBinary(file);
      const contentHash = await this.computeSha256(bytes);
      result[file.path] = {
        path: file.path,
        contentHash,
        bytes
      };
    }
    return result;
  }

  private async rebuildRemoteBaseline(
    client: SyncApiClient,
    accessToken: string,
    serverCheckpoint: number,
    signal: AbortSignal
  ): Promise<{ checkpoint: number; index: Record<string, IndexedFileState> }> {
    const rebuilt = await this.fetchRemoteIndexState(client, accessToken, serverCheckpoint, signal);
    await this.stateStore.replaceFileIndexByPath(rebuilt.index);
    await this.stateStore.setCheckpoint(`cp_${rebuilt.checkpoint}`);
    return rebuilt;
  }

  private async fetchRemoteIndexState(
    client: SyncApiClient,
    accessToken: string,
    serverCheckpoint: number,
    signal: AbortSignal
  ): Promise<{ checkpoint: number; index: Record<string, IndexedFileState> }> {
    if (serverCheckpoint === 0) {
      return {
        checkpoint: 0,
        index: {}
      };
    }

    let nextCheckpoint = 0;
    let rebuiltIndex: Record<string, IndexedFileState> = {};
    while (true) {
      this.throwIfAborted(signal);
      const pulled = await client.pull(accessToken, this.settings.vaultId, nextCheckpoint, 200, signal);
      rebuiltIndex = applyRemoteChangesToIndex(rebuiltIndex, pulled.changes);
      nextCheckpoint = this.checkpointToNumber(pulled.toCheckpoint);
      if (!pulled.hasMore) {
        break;
      }
    }

    if (nextCheckpoint < serverCheckpoint) {
      throw new Error(
        `远端状态重建不完整：服务端检查点=cp_${serverCheckpoint}，重建到=cp_${nextCheckpoint}。`
      );
    }

    return {
      checkpoint: nextCheckpoint,
      index: rebuiltIndex
    };
  }

  private async uploadTargetsWithConcurrency(
    client: SyncApiClient,
    uploadTargets: UploadTarget[],
    hashToSnapshot: Record<string, LocalFileSnapshot>,
    signal: AbortSignal
  ): Promise<void> {
    await this.mapWithConcurrency(
      uploadTargets,
      MAX_UPLOAD_CONCURRENCY,
      async (target) => {
        this.throwIfAborted(signal);
        const snapshot = hashToSnapshot[target.contentHash];
        if (!snapshot) {
          throw new Error(`缺少内容哈希 ${target.contentHash} 对应的本地快照。`);
        }
        await client.uploadObject(target.uploadUrl, snapshot.bytes, signal);
      },
      signal
    );
  }

  private async applyRemoteChanges(
    client: SyncApiClient,
    accessToken: string,
    currentIndex: Record<string, IndexedFileState>,
    remoteChanges: SyncPullChange[],
    signal: AbortSignal
  ): Promise<Record<string, IndexedFileState>> {
    const nextIndex = { ...currentIndex };
    const fileIdToPath: Record<string, string> = {};
    for (const [path, meta] of Object.entries(nextIndex)) {
      fileIdToPath[meta.fileId] = path;
    }

    for (let start = 0; start < remoteChanges.length; start += REMOTE_CHANGE_BATCH_SIZE) {
      this.throwIfAborted(signal);
      const batch = remoteChanges.slice(start, start + REMOTE_CHANGE_BATCH_SIZE);
      const bytesByHash = await this.downloadBatchBytes(client, accessToken, batch, signal);

      for (const change of batch) {
        this.throwIfAborted(signal);
        if (change.op === "delete") {
          const existingPath = fileIdToPath[change.fileId] ?? change.path;
          await this.deleteLocalFileIfExists(existingPath, signal);
          delete fileIdToPath[change.fileId];
          if (nextIndex[existingPath]) {
            delete nextIndex[existingPath];
          } else {
            for (const [path, meta] of Object.entries(nextIndex)) {
              if (meta.fileId === change.fileId) {
                delete nextIndex[path];
              }
            }
          }
          continue;
        }

        const previousPath = fileIdToPath[change.fileId];
        if ((change.op === "rename" || change.op === "move") && previousPath && previousPath !== change.path) {
          await this.renameLocalFileIfExists(previousPath, change.path, signal);
          delete nextIndex[previousPath];
          nextIndex[change.path] = {
            fileId: change.fileId,
            path: change.path,
            version: change.version,
            contentHash: change.contentHash
          };
          fileIdToPath[change.fileId] = change.path;
          continue;
        }

        if (change.op !== "create" && change.op !== "update") {
          throw new Error(`收到不支持的远端操作：${change.op}`);
        }

        const bytes = bytesByHash.get(change.contentHash);
        if (!bytes) {
          throw new Error(`缺少内容哈希 ${change.contentHash} 对应的下载数据。`);
        }

        if (previousPath && previousPath !== change.path) {
          await this.deleteLocalFileIfExists(previousPath, signal);
          delete nextIndex[previousPath];
        }

        await this.writeLocalFile(change.path, bytes, signal);
        nextIndex[change.path] = {
          fileId: change.fileId,
          path: change.path,
          version: change.version,
          contentHash: change.contentHash
        };
        fileIdToPath[change.fileId] = change.path;
      }
    }

    return nextIndex;
  }

  private async downloadBatchBytes(
    client: SyncApiClient,
    accessToken: string,
    remoteChanges: SyncPullChange[],
    signal: AbortSignal
  ): Promise<Map<string, ArrayBuffer>> {
    const downloadHashes = Array.from(
      new Set(
        remoteChanges
          .filter((change) => change.op === "create" || change.op === "update")
          .map((change) => change.contentHash)
          .filter((hash) => hash.length > 0)
      )
    );
    if (downloadHashes.length === 0) {
      return new Map();
    }

    const urls = await client.getDownloadUrls(accessToken, this.settings.vaultId, downloadHashes, signal);
    const urlByHash = new Map(urls.items.map((item) => [item.contentHash, item.downloadUrl]));
    const bytesByHash = new Map<string, ArrayBuffer>();
    await this.mapWithConcurrency(
      downloadHashes,
      MAX_DOWNLOAD_CONCURRENCY,
      async (hash) => {
        this.throwIfAborted(signal);
        const url = urlByHash.get(hash);
        if (!url) {
          throw new Error(`缺少内容哈希 ${hash} 的下载地址。`);
        }
        bytesByHash.set(hash, await client.downloadObject(url, signal));
      },
      signal
    );
    return bytesByHash;
  }

  private async writeLocalFile(path: string, bytes: ArrayBuffer, signal: AbortSignal): Promise<void> {
    this.throwIfAborted(signal);
    await this.ensureParentFolder(path, signal);
    this.throwIfAborted(signal);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.app.vault.modifyBinary(existing, bytes);
      return;
    }
    if (existing instanceof TFolder) {
      throw new Error(`无法写入文件，目标路径是文件夹：${path}`);
    }
    await this.app.vault.createBinary(path, bytes);
  }

  private async renameLocalFileIfExists(fromPath: string, toPath: string, signal: AbortSignal): Promise<void> {
    this.throwIfAborted(signal);
    const existing = this.app.vault.getAbstractFileByPath(fromPath);
    if (!(existing instanceof TFile)) {
      return;
    }

    await this.ensureParentFolder(toPath, signal);
    this.throwIfAborted(signal);
    const target = this.app.vault.getAbstractFileByPath(toPath);
    if (target instanceof TFile) {
      await this.app.vault.delete(target, true);
    } else if (target instanceof TFolder) {
      throw new Error(`无法重命名文件，目标路径是文件夹：${toPath}`);
    }

    await this.app.fileManager.renameFile(existing, toPath);
  }

  private async handlePrepareConflicts(
    client: SyncApiClient,
    accessToken: string,
    currentIndex: Record<string, IndexedFileState>,
    localPlan: { changes: SyncChangeRequest[]; hashToSnapshot: Record<string, LocalFileSnapshot> },
    conflicts: SyncConflict[],
    interactive: boolean,
    signal: AbortSignal
  ): Promise<"retry" | "pending"> {
    const repairedIndex = pruneMissingFileIndexEntries(currentIndex, localPlan.changes, conflicts);
    const localDeletionPaths = collectLocalDeletionPaths(localPlan.changes, conflicts);
    const pureDeleteConflicts = areAllConflictsLocalDeletes(localPlan.changes, conflicts);
    if (repairedIndex !== currentIndex) {
      await this.stateStore.replaceFileIndexByPath(repairedIndex);
    }

    const pendingSummaries = await this.buildPendingConflictSummaries(localPlan, conflicts, signal);
    new Notice(`已保存 ${pendingSummaries.length} 个待处理冲突，当前已回到远端最新状态。`);
    if (interactive && this.hasRemoteDeletedConflicts(conflicts) && !signal.aborted) {
      await openConflictAcknowledgeModal(this.app, conflicts.filter((item) => item.remoteDeleted));
    }
    await this.stateStore.setPendingConflicts(pendingSummaries);
    await this.rebaseToRemoteState(client, accessToken, signal);
    for (const path of localDeletionPaths) {
      await this.deleteLocalFileIfExists(path, signal);
    }
    if (pureDeleteConflicts) {
      await this.stateStore.clearPendingConflicts();
      new Notice("检测到纯删除冲突，已自动按本地删除意图重新提交。");
      return "retry";
    }
    return "pending";
  }

  private buildPendingConflictId(conflict: SyncConflict, path: string): string {
    return [conflict.code, conflict.fileId ?? "-", path].join(":");
  }

  private async buildPendingConflictSummaries(
    localPlan: { changes: SyncChangeRequest[]; hashToSnapshot: Record<string, LocalFileSnapshot> },
    conflicts: SyncConflict[],
    signal: AbortSignal
  ): Promise<PendingConflictSummary[]> {
    const items: PendingConflictSummary[] = [];
    for (const conflict of conflicts) {
      this.throwIfAborted(signal);
      const change = localPlan.changes[conflict.index];
      const path = change?.path ?? conflict.path;
      const bytes = await this.readConflictBytes(path, change?.contentHash, localPlan.hashToSnapshot);
      const recommendedAction = getRecommendedConflictAction(conflict, path);
      items.push({
        id: this.buildPendingConflictId(conflict, path),
        code: conflict.code,
        path,
        fileId: conflict.fileId,
        message: conflict.message,
        localPreview: bytes ? createTextPreview(bytes) : null,
        localContentBase64: bytes ? this.arrayBufferToBase64(bytes) : null,
        remoteSummary: buildRemoteSummary(conflict),
        recommendedAction,
        recommendedReason: getConflictRecommendationReason(recommendedAction, conflict, path),
        remoteDeleted: Boolean(conflict.remoteDeleted)
      });
    }
    return items;
  }

  private async readConflictBytes(
    path: string,
    contentHash: string | undefined,
    hashToSnapshot: Record<string, LocalFileSnapshot>
  ): Promise<ArrayBuffer | null> {
    if (contentHash) {
      const snapshot = hashToSnapshot[contentHash];
      if (snapshot?.bytes) {
        return snapshot.bytes;
      }
    }

    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      return this.app.vault.readBinary(existing);
    }

    return null;
  }

  private async resolvePendingConflictsInteractively(): Promise<"retry" | "defer"> {
    const pending = this.stateStore.getPendingConflicts();
    const candidates: ConflictResolutionCandidate[] = pending.items.map((item) => ({
      id: item.id,
      code: item.code,
      path: item.path,
      fileId: item.fileId,
      message: item.message,
      localExists: item.localContentBase64 !== null,
      localIsConflictCopy: false,
      localPreview: item.localPreview,
      remoteSummary: item.remoteSummary,
      recommendedAction: item.recommendedAction,
      recommendedReason: item.recommendedReason
    }));
    const modalResult = await openConflictResolutionModal(this.app, candidates);
    if (modalResult.action === "defer" || Object.values(modalResult.selections).some((value) => value === "defer")) {
      await this.stateStore.setPendingConflicts(pending.items);
      return "defer";
    }

    const signal = new AbortController().signal;
    for (const item of pending.items) {
      if (modalResult.selections[item.id] !== "use_local") {
        continue;
      }
      if (!item.localContentBase64) {
        continue;
      }
      await this.writeLocalFile(item.path, this.base64ToArrayBuffer(item.localContentBase64), signal);
    }

    await this.stateStore.clearPendingConflicts();
    return "retry";
  }

  private hasRemoteDeletedConflicts(conflicts: SyncConflict[]): boolean {
    return conflicts.some((conflict) => conflict.remoteDeleted);
  }

  private async rebaseToRemoteState(
    client: SyncApiClient,
    accessToken: string,
    signal: AbortSignal
  ): Promise<void> {
    await this.stateStore.clearQueue();
    await this.stateStore.replaceFileIndexByPath({});
    await this.stateStore.setCheckpoint(null);

    let nextCheckpoint = 0;
    let updatedIndex: Record<string, IndexedFileState> = {};
    while (true) {
      this.throwIfAborted(signal);
      const pulled = await client.pull(accessToken, this.settings.vaultId, nextCheckpoint, 200, signal);
      if (pulled.changes.length > 0) {
        updatedIndex = await this.applyRemoteChanges(client, accessToken, updatedIndex, pulled.changes, signal);
        await this.stateStore.replaceFileIndexByPath(updatedIndex);
      }

      await this.stateStore.setCheckpoint(pulled.toCheckpoint);
      nextCheckpoint = this.checkpointToNumber(pulled.toCheckpoint);
      if (!pulled.hasMore) {
        break;
      }
    }
  }

  private async deleteLocalFileIfExists(path: string, signal: AbortSignal): Promise<void> {
    this.throwIfAborted(signal);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.app.vault.delete(existing, true);
    }
  }

  private async ensureParentFolder(path: string, signal: AbortSignal): Promise<void> {
    const parts = path.split("/");
    parts.pop();
    let current = "";
    for (const part of parts) {
      this.throwIfAborted(signal);
      if (!part) continue;
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (!existing) {
        await this.app.vault.createFolder(current);
        continue;
      }
      if (!(existing instanceof TFolder)) {
        throw new Error(`路径冲突：${current} 不是文件夹。`);
      }
    }
  }

  private async mapWithConcurrency<T>(
    items: T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<void>,
    signal: AbortSignal
  ): Promise<void> {
    if (items.length === 0) {
      return;
    }

    const workerCount = Math.max(1, Math.min(concurrency, items.length));
    let nextIndex = 0;
    let firstError: unknown = null;

    const runner = async (): Promise<void> => {
      while (true) {
        if (firstError) {
          return;
        }
        this.throwIfAborted(signal);
        const currentIndex = nextIndex;
        if (currentIndex >= items.length) {
          return;
        }
        nextIndex += 1;
        const item = items[currentIndex];
        if (item === undefined) {
          return;
        }
        try {
          await worker(item, currentIndex);
        } catch (error) {
          firstError = error;
          return;
        }
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => runner()));
    if (firstError) {
      throw firstError;
    }
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
      throw new DOMException("操作已取消", "AbortError");
    }
  }

  private checkpointToNumber(checkpoint: string | null): number {
    if (!checkpoint) {
      return 0;
    }
    const match = /^cp_(\d+)$/.exec(checkpoint);
    if (!match) {
      return 0;
    }
    return Number(match[1]);
  }

  private async computeSha256(bytes: ArrayBuffer): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const hex = Array.from(new Uint8Array(digest))
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
    return `sha256:${hex}`;
  }

  private arrayBufferToBase64(bytes: ArrayBuffer): string {
    let binary = "";
    const view = new Uint8Array(bytes);
    for (const byte of view) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary);
  }

  private base64ToArrayBuffer(value: string): ArrayBuffer {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes.buffer;
  }

  private isRetryableError(error: unknown): boolean {
    if (error instanceof SyncApiError) {
      if (error.status >= 500 || error.status === 429) {
        return true;
      }
      if (error.code === "UPLOAD_FAILED" || error.code === "DOWNLOAD_FAILED") {
        return true;
      }
      return false;
    }

    if (error instanceof Error) {
      if (error instanceof SyncConflictResolutionRequiredError) {
        return false;
      }
      const message = error.message.toLowerCase();
      if (message.includes("failed to fetch") || message.includes("network") || message.includes("timed out")) {
        return true;
      }
      return error.name === "AbortError";
    }

    if (error instanceof DOMException && error.name === "AbortError") {
      return true;
    }

    return false;
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  private localizeSyncApiCode(code: string): string {
    const mappings: Record<string, string> = {
      INVALID_REQUEST: "请求参数无效",
      INVALID_PARAMS: "请求参数无效",
      INVALID_CREDENTIALS: "邮箱或密码错误",
      UNAUTHORIZED: "登录已失效，请重新登录",
      TOKEN_INVALID: "登录凭证无效，请重新登录",
      TOKEN_EXPIRED: "登录凭证已过期，请重新登录",
      FORBIDDEN: "无权限执行该操作",
      VAULT_NOT_FOUND: "找不到指定的 Vault",
      CHECKPOINT_MISMATCH: "同步检查点不一致",
      VERSION_CONFLICT: "版本冲突",
      PREPARE_NOT_FOUND: "同步会话不存在",
      PREPARE_EXPIRED: "同步会话已过期",
      PREPARE_ALREADY_COMMITTED: "同步会话已提交",
      SYNC_COMMIT_FAILED: "同步提交失败",
      UPLOAD_FAILED: "文件上传失败",
      DOWNLOAD_FAILED: "文件下载失败",
      HTTP_ERROR: "请求失败"
    };
    return mappings[code] ?? code;
  }

  private localizeErrorMessage(message: string): string {
    const normalized = message.toLowerCase();
    if (normalized.includes("failed to fetch")) {
      return "网络请求失败，请检查网络连接。";
    }
    if (normalized.includes("network")) {
      return "网络异常，请稍后重试。";
    }
    if (normalized.includes("timed out")) {
      return "请求超时，请稍后重试。";
    }
    if (normalized.includes("vault not found")) {
      return "找不到对应的 Vault，请检查 Vault ID。";
    }
    if (normalized.includes("invalid access token")) {
      return "登录态无效，请重新登录。";
    }
    if (normalized.includes("prepare session expired")) {
      return "同步会话已过期，请重新同步。";
    }
    if (normalized.includes("prepare session not found")) {
      return "同步会话不存在，请重新同步。";
    }
    if (normalized.includes("commit failed")) {
      return "同步提交失败，请稍后重试。";
    }
    if (normalized.includes("request failed with status")) {
      return "请求失败，请稍后重试。";
    }
    return message;
  }

  private stringifyError(error: unknown): string {
    if (error instanceof SyncApiError) {
      const codeMessage = this.localizeSyncApiCode(error.code);
      const detail = this.localizeErrorMessage(error.message);
      return `${codeMessage}（${error.status}）：${detail}`;
    }
    if (error instanceof DOMException) {
      if (error.name === "AbortError") {
        return "操作已取消。";
      }
      return `${error.name}：${this.localizeErrorMessage(error.message)}`;
    }
    if (error instanceof Error) {
      return this.localizeErrorMessage(error.message);
    }
    return String(error);
  }

  private isInteractiveTrigger(reason: string): boolean {
    return reason === "manual" || reason === "manual-command" || reason === "settings-button";
  }

  private shouldNotifyBlocked(reason: string): boolean {
    const now = Date.now();
    const shouldNotify = shouldNotifyBlocked({
      interactive: this.isInteractiveTrigger(reason),
      nowMs: now,
      lastNoticeAtMs: this.lastBlockedNoticeAtMs,
      cooldownMs: BLOCKED_NOTICE_COOLDOWN_MS
    });
    if (shouldNotify) {
      this.lastBlockedNoticeAtMs = now;
    }
    return shouldNotify;
  }

  private shouldNotifyFailure(reason: string, consecutiveFailures: number): boolean {
    const now = Date.now();
    const shouldNotify = shouldNotifyFailure({
      interactive: this.isInteractiveTrigger(reason),
      nowMs: now,
      lastNoticeAtMs: this.lastFailureNoticeAtMs,
      cooldownMs: FAILURE_NOTICE_COOLDOWN_MS,
      consecutiveFailures,
      minConsecutiveFailures: BACKGROUND_FAILURE_NOTICE_MIN_CONSECUTIVE
    });
    if (shouldNotify) {
      this.lastFailureNoticeAtMs = now;
    }
    return shouldNotify;
  }

  private formatSyncResult(result: SyncRunResult): string {
    const mappings: Record<SyncRunResult, string> = {
      idle: "空闲",
      success: "成功",
      failed: "失败",
      blocked: "已阻塞",
      skipped: "已跳过"
    };
    return mappings[result];
  }

  private formatSyncReason(reason: string): string {
    if (reason === "manual") return "手动触发";
    if (reason === "manual-command") return "命令触发";
    if (reason === "settings-button") return "设置页按钮触发";
    if (reason === "interval") return "定时触发";
    if (reason === "queued") return "排队触发";
    if (reason.startsWith("foreground:")) {
      const trigger = reason.slice("foreground:".length);
      return `前台唤醒（${trigger}）`;
    }
    if (reason === "none") return "无";
    return reason;
  }

  getRuntimeStatusSummary(): string {
    const snapshot = this.stateStore.getSnapshot();
    const failure = snapshot.failure;
    return [
      `API=${this.settings.apiBaseUrl || "-"} Vault=${this.settings.vaultId || "-"}`,
      `运行中=${this.syncInProgress ? "是" : "否"} 待执行=${this.pendingSync ? "是" : "否"}`,
      `最近触发=${this.formatSyncReason(this.lastSyncReason)} 结果=${this.formatSyncResult(this.lastSyncResult)}`,
      `最近开始=${this.formatTime(this.lastSyncStartedAtMs)} 最近结束=${this.formatTime(this.lastSyncFinishedAtMs)}`,
      `检查点=${snapshot.checkpoint ?? "-"}`,
      `队列长度=${snapshot.queue.length} 失败队列长度=${failure.failedQueue.length}`,
      `待处理冲突=${snapshot.pendingConflicts.items.length} 延后时间=${this.formatTime(snapshot.pendingConflicts.deferredAt)}`,
      `失败阻塞=${failure.blocked ? "是" : "否"} 连续失败=${failure.consecutiveFailures}`,
      `最近失败时间=${this.formatTime(failure.lastFailedAt)} 错误=${this.lastSyncError ?? failure.lastError ?? "-"}`
    ].join("\n");
  }

  private formatTime(ts: number | null): string {
    if (!ts) {
      return "-";
    }
    return new Date(ts).toLocaleString();
  }

  private setupForegroundResumeHooks(): void {
    if (!this.app.isMobile) {
      return;
    }

    this.registerDomEvent(document, "visibilitychange", () => {
      if (!document.hidden) {
        void this.triggerForegroundSync("visibilitychange");
      }
    });
    this.registerDomEvent(window, "focus", () => {
      void this.triggerForegroundSync("focus");
    });
  }

  private async triggerForegroundSync(trigger: string): Promise<void> {
    const now = Date.now();
    if (now - this.lastForegroundSyncAtMs < FOREGROUND_SYNC_MIN_INTERVAL_MS) {
      return;
    }
    this.lastForegroundSyncAtMs = now;
    if (this.settings.enableDebugPanel) {
      console.info("[custom-sync] foreground trigger", trigger);
    }
    await this.runSyncOnce(`foreground:${trigger}`);
  }

  private setupTimer(): void {
    if (this.syncTimer !== null) {
      window.clearInterval(this.syncTimer);
      this.syncTimer = null;
    }

    if (this.settings.syncIntervalMinutes <= 0) {
      return;
    }

    this.syncTimer = window.setInterval(() => {
      void this.runSyncOnce("interval");
    }, this.settings.syncIntervalMinutes * 60 * 1000);
  }
}

class SyncSettingTab extends PluginSettingTab {
  plugin: CustomSyncPlugin;

  constructor(app: App, plugin: CustomSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "自建同步设置" });

    new Setting(containerEl)
      .setName("API 地址")
      .setDesc("同步服务地址，例如：http://localhost:3000/api/v1")
      .addText((text) =>
        text.setValue(this.plugin.settings.apiBaseUrl).onChange(async (value) => {
          this.plugin.settings.apiBaseUrl = value.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("邮箱")
      .setDesc("用于登录同步服务的账号邮箱。")
      .addText((text) =>
        text.setValue(this.plugin.settings.email).onChange(async (value) => {
          this.plugin.settings.email = value.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("密码")
      .setDesc("为方便使用会保存在本地设备。")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setValue(this.plugin.settings.password).onChange(async (value) => {
          this.plugin.settings.password = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Vault ID")
      .setDesc("服务端分配的目标 Vault 标识。")
      .addText((text) =>
        text.setValue(this.plugin.settings.vaultId).onChange(async (value) => {
          this.plugin.settings.vaultId = value.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("设备名称")
      .setDesc("显示在服务端设备列表中。")
      .addText((text) =>
        text.setValue(this.plugin.settings.deviceName).onChange(async (value) => {
          this.plugin.settings.deviceName = value.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("同步间隔（分钟）")
      .setDesc("设置为 0 可关闭定时同步。")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.syncIntervalMinutes)).onChange(async (value) => {
          const next = Number(value);
          if (!Number.isFinite(next) || next < 0) {
            return;
          }
          this.plugin.settings.syncIntervalMinutes = next;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("启用调试面板")
      .setDesc("在控制台输出同步调试信息。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enableDebugPanel).onChange(async (value) => {
          this.plugin.settings.enableDebugPanel = value;
          await this.plugin.saveSettings();
        })
      );

    const statusContainer = containerEl.createDiv();
    statusContainer.createEl("h3", { text: "同步运行状态" });
    const statusEl = statusContainer.createEl("pre");
    const refreshStatus = () => {
      statusEl.setText(this.plugin.getRuntimeStatusSummary());
    };
    refreshStatus();

    const pendingContainer = statusContainer.createDiv();
    const refreshPendingConflicts = () => {
      pendingContainer.empty();
      const pendingConflicts = this.plugin.stateStore.getPendingConflicts();
      pendingContainer.createEl("h4", { text: "待决冲突" });
      if (pendingConflicts.items.length === 0) {
        pendingContainer.createEl("p", { text: "当前没有待处理冲突。" });
        return;
      }

      pendingContainer.createEl("p", {
        text: `共 ${pendingConflicts.items.length} 项，延后时间：${
          pendingConflicts.deferredAt ? new Date(pendingConflicts.deferredAt).toLocaleString() : "-"
        }`
      });
      const list = pendingContainer.createEl("ul");
      for (const item of pendingConflicts.items.slice(0, 10)) {
        list.createEl("li", {
          text: `${item.code} · ${item.path}${item.fileId ? ` · ${item.fileId}` : ""}`
        });
      }
      if (pendingConflicts.items.length > 10) {
        pendingContainer.createEl("p", {
          text: `其余 ${pendingConflicts.items.length - 10} 项未展开。`
        });
      }
    };
    refreshPendingConflicts();

    new Setting(statusContainer)
      .setName("状态操作")
      .setDesc("刷新当前状态或触发一次同步。")
      .addButton((button) =>
        button.setButtonText("刷新状态").onClick(() => {
          refreshStatus();
          refreshPendingConflicts();
        })
      )
      .addButton((button) =>
        button.setButtonText("同步并刷新").onClick(async () => {
          await this.plugin.runSyncOnce("settings-button");
          refreshStatus();
          refreshPendingConflicts();
        })
      )
      .addButton((button) =>
        button.setButtonText("处理待决冲突").onClick(async () => {
          await this.plugin.runSyncOnce("manual-command");
          refreshStatus();
          refreshPendingConflicts();
        })
      )
      .addButton((button) =>
        button.setButtonText("清除待决冲突").onClick(async () => {
          await this.plugin.clearPendingConflicts();
          refreshStatus();
          refreshPendingConflicts();
        })
      )
      .addButton((button) =>
        button.setButtonText("清理历史冲突文件").onClick(async () => {
          await this.plugin.cleanLegacyConflictFiles();
          refreshStatus();
          refreshPendingConflicts();
        })
      );

    new Setting(containerEl)
      .setName("快捷操作")
      .setDesc("常用同步操作入口。")
      .addButton((button) =>
        button.setButtonText("登录").onClick(async () => {
          await this.plugin.login();
        })
      )
      .addButton((button) =>
        button.setButtonText("执行一次同步").onClick(async () => {
          await this.plugin.runSyncOnce("settings-button");
        })
      )
      .addButton((button) =>
        button.setButtonText("处理待决冲突").onClick(async () => {
          await this.plugin.runSyncOnce("manual-command");
        })
      )
      .addButton((button) =>
        button.setButtonText("清除待决冲突").onClick(async () => {
          await this.plugin.clearPendingConflicts();
        })
      )
      .addButton((button) =>
        button.setButtonText("清理历史冲突文件").onClick(async () => {
          await this.plugin.cleanLegacyConflictFiles();
        })
      )
      .addButton((button) =>
        button.setButtonText("清除失败状态").onClick(async () => {
          await this.plugin.clearFailureState();
        })
      );
  }
}
