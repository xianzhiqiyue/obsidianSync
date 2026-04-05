export interface LoginRequest {
  email: string;
  password: string;
  deviceName: string;
  platform: "macos" | "windows" | "android" | "ios" | "linux" | "unknown";
  pluginVersion: string;
}

export interface LoginResponse {
  deviceId: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface SyncStateResponse {
  checkpoint: string;
  serverTime: string;
}

export interface SyncChangeRequest {
  op: "create" | "update" | "delete" | "rename" | "move";
  fileId?: string;
  path: string;
  baseVersion?: number;
  contentHash?: string;
}

export interface SyncConflict {
  index: number;
  code: string;
  fileId?: string;
  path: string;
  message: string;
  reason?: string;
  headVersion?: number;
  remotePath?: string;
  remoteDeleted?: boolean;
  existingFileId?: string;
}

export interface UploadTarget {
  contentHash: string;
  uploadUrl: string;
}

export interface SyncPrepareResponse {
  prepareId: string;
  uploadTargets: UploadTarget[];
  conflicts: SyncConflict[];
}

export interface SyncCommitResponse {
  changesetId: string;
  newCheckpoint: string;
  appliedChanges: number;
}

export interface SyncPullChange {
  op: "create" | "update" | "delete" | "rename" | "move";
  fileId: string;
  path: string;
  version: number;
  contentHash: string;
}

export interface SyncPullResponse {
  fromCheckpoint: string;
  toCheckpoint: string;
  changes: SyncPullChange[];
  hasMore: boolean;
}

export interface DownloadUrlItem {
  contentHash: string;
  downloadUrl: string;
}

export interface DownloadUrlsResponse {
  items: DownloadUrlItem[];
}

interface ApiErrorPayload {
  code?: string;
  message?: string;
}

export class SyncApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class SyncApiClient {
  constructor(private readonly baseUrl: string) {}

  async login(payload: LoginRequest, signal?: AbortSignal): Promise<LoginResponse> {
    return this.request<LoginResponse>("/auth/login", {
      method: "POST",
      body: JSON.stringify(payload),
      signal
    }, signal);
  }

  async refresh(refreshToken: string, signal?: AbortSignal): Promise<RefreshResponse> {
    return this.request<RefreshResponse>("/auth/token/refresh", {
      method: "POST",
      body: JSON.stringify({ refreshToken }),
      signal
    }, signal);
  }

  async getSyncState(accessToken: string, vaultId: string, signal?: AbortSignal): Promise<SyncStateResponse> {
    return this.request<SyncStateResponse>(`/vaults/${vaultId}/sync/state`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`
      },
      signal
    }, signal);
  }

  async prepare(
    accessToken: string,
    vaultId: string,
    baseCheckpoint: number,
    changes: SyncChangeRequest[],
    signal?: AbortSignal
  ): Promise<SyncPrepareResponse> {
    return this.request<SyncPrepareResponse>(`/vaults/${vaultId}/sync/prepare`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`
      },
      body: JSON.stringify({
        baseCheckpoint,
        changes
      }),
      signal
    }, signal);
  }

  async commit(
    accessToken: string,
    vaultId: string,
    prepareId: string,
    idempotencyKey: string,
    signal?: AbortSignal
  ): Promise<SyncCommitResponse> {
    return this.request<SyncCommitResponse>(`/vaults/${vaultId}/sync/commit`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`
      },
      body: JSON.stringify({
        prepareId,
        idempotencyKey
      }),
      signal
    }, signal);
  }

  async pull(
    accessToken: string,
    vaultId: string,
    fromCheckpoint: number,
    limit = 200,
    signal?: AbortSignal
  ): Promise<SyncPullResponse> {
    return this.request<SyncPullResponse>(
      `/vaults/${vaultId}/sync/pull?fromCheckpoint=${fromCheckpoint}&limit=${limit}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`
        },
        signal
      },
      signal
    );
  }

  async getDownloadUrls(
    accessToken: string,
    vaultId: string,
    contentHashes: string[],
    signal?: AbortSignal
  ): Promise<DownloadUrlsResponse> {
    return this.request<DownloadUrlsResponse>(`/vaults/${vaultId}/objects/download-urls`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`
      },
      body: JSON.stringify({ contentHashes }),
      signal
    }, signal);
  }

  async uploadObject(uploadUrl: string, bytes: ArrayBuffer, signal?: AbortSignal): Promise<void> {
    const response = await fetch(uploadUrl, {
      method: "PUT",
      body: bytes,
      signal
    });
    if (!response.ok) {
      throw new SyncApiError(response.status, "UPLOAD_FAILED", `upload failed with status ${response.status}`);
    }
  }

  async downloadObject(downloadUrl: string, signal?: AbortSignal): Promise<ArrayBuffer> {
    const response = await fetch(downloadUrl, { method: "GET", signal });
    if (!response.ok) {
      throw new SyncApiError(
        response.status,
        "DOWNLOAD_FAILED",
        `download failed with status ${response.status}`
      );
    }
    return response.arrayBuffer();
  }

  private async request<T>(path: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
    const response = await fetch(this.toUrl(path), {
      ...init,
      signal: signal ?? init.signal,
      headers: {
        "Content-Type": "application/json",
        ...(init.headers ?? {})
      }
    });

    const text = await response.text();
    const body = text.length > 0 ? (JSON.parse(text) as T | ApiErrorPayload) : ({} as T);
    if (!response.ok) {
      const payload = body as ApiErrorPayload;
      throw new SyncApiError(
        response.status,
        payload.code ?? "HTTP_ERROR",
        payload.message ?? `request failed with status ${response.status}`
      );
    }

    return body as T;
  }

  private toUrl(path: string): string {
    const normalizedBase = this.baseUrl.endsWith("/") ? this.baseUrl.slice(0, -1) : this.baseUrl;
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    return `${normalizedBase}${normalizedPath}`;
  }
}
