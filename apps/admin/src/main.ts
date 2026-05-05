type VaultSummary = {
  vaultId: string;
  name: string;
  fileCount: number;
  deletedFileCount: number;
  latestCheckpoint: string;
  latestEventAt: string | null;
};

type FileSummary = {
  fileId: string;
  path: string;
  headVersion: number;
  deleted: boolean;
  deletedAt: string | null;
  updatedAt: string | null;
  latestCheckpoint: string;
  latestContentHash: string | null;
  versionCount: number;
};

type FileDetail = {
  file: {
    fileId: string;
    path: string;
    headVersion: number;
    deleted: boolean;
    deletedAt: string | null;
  };
  versions: Array<{
    version: number;
    contentHash: string;
    authorDeviceName: string | null;
    authorPlatform: string | null;
    createdAt: string;
    mtimeMs: number | null;
    ctimeMs: number | null;
    current: boolean;
  }>;
  tombstones: Array<{ tombstoneId: string; deletedAt: string; expireAt: string }>;
  events: Array<{
    eventId: string;
    checkpoint: string;
    op: string;
    path: string;
    version: number;
    source: string;
    reason: string | null;
    createdAt: string;
  }>;
  operations: Array<{
    operationId: string;
    operation: string;
    status: string;
    reason: string;
    changesetId: string | null;
    createdAt: string;
  }>;
};

type PreviewResponse = {
  confirmToken: string;
  action: AdminAction;
  pathConflict: boolean;
  pathConflictFileId: string | null;
  willCreateVersion: number;
  willCreateCheckpoint: string;
  target: { version: number; contentHash: string; path: string } | null;
  retention: { historyRetentionDays: number; policy: string };
};

type UserProfile = {
  userId: string;
  email: string;
  displayName: string | null;
  createdAt: string;
  updatedAt: string | null;
  lastLoginAt: string | null;
};

type UserDevice = {
  deviceId: string;
  deviceName: string;
  platform: string;
  pluginVersion: string;
  status: "active" | "revoked";
  current: boolean;
  createdAt: string;
  revokedAt: string | null;
  activeRefreshTokenCount: number;
};

type AdminAction = "restore" | "set_current_version" | "soft_delete";

const DEFAULT_RESTORE_REASON = "后台列表默认恢复最新版本";
type RouteName = "login" | "history" | "users";

type AppState = {
  apiBaseUrl: string;
  email: string;
  password: string;
  deviceName: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAtMs: number;
  user: UserProfile | null;
  devices: UserDevice[];
  vaults: VaultSummary[];
  files: FileSummary[];
  selectedVaultId: string;
  selectedVaultIds: Set<string>;
  vaultDropdownOpen: boolean;
  fileVaultMap: Record<string, string>;
  selectedFileId: string;
  selectedFile: FileDetail | null;
  selectedFileIds: Set<string>;
  detailModalOpen: boolean;
  previewVersion: number | null;
  previewContent: string;
  previewStatus: "idle" | "loading" | "error";
  vaultQuery: string;
  status: "idle" | "loading" | "error";
  message: string;
  fileStatus: "all" | "active" | "deleted";
  fileQuery: string;
  filePage: number;
  filePageSize: number;
  fileHasNextPage: boolean;
  route: RouteName;
};

const storageKeys = {
  apiBaseUrl: "obsidian-sync-admin-api-base-url",
  email: "obsidian-sync-admin-email",
  deviceName: "obsidian-sync-admin-device-name",
  accessToken: "obsidian-sync-admin-access-token",
  refreshToken: "obsidian-sync-admin-refresh-token",
  accessTokenExpiresAtMs: "obsidian-sync-admin-access-token-expires-at-ms"
};

const routeTitles: Record<RouteName, { label: string; title: string; subtitle: string }> = {
  login: { label: "登录", title: "安全登录", subtitle: "使用账号密码进入恢复控制台" },
  history: { label: "历史数据", title: "历史数据恢复控制台", subtitle: "查询 Vault 文件、版本时间线、审计事件与恢复操作" },
  users: { label: "用户模块", title: "用户与设备", subtitle: "管理当前账号资料、密码和已登录设备" }
};

function defaultApiBaseUrl(): string {
  if (window.location.hostname === "localhost" && window.location.port === "5173") {
    return "http://localhost:3000/api/v1";
  }
  return `${window.location.origin}/api/v1`;
}

function initialApiBaseUrl(): string {
  const stored = localStorage.getItem(storageKeys.apiBaseUrl);
  if (!stored) return defaultApiBaseUrl();
  const isRemotePage = !["localhost", "127.0.0.1"].includes(window.location.hostname);
  const pointsToLocalhost = stored.includes("localhost") || stored.includes("127.0.0.1");
  return isRemotePage && pointsToLocalhost ? defaultApiBaseUrl() : stored;
}

const state: AppState = {
  apiBaseUrl: initialApiBaseUrl(),
  email: localStorage.getItem(storageKeys.email) ?? "",
  password: "",
  deviceName: localStorage.getItem(storageKeys.deviceName) ?? `admin-${navigator.platform || "browser"}`,
  accessToken: localStorage.getItem(storageKeys.accessToken) ?? "",
  refreshToken: localStorage.getItem(storageKeys.refreshToken) ?? "",
  accessTokenExpiresAtMs: Number(localStorage.getItem(storageKeys.accessTokenExpiresAtMs) ?? "0"),
  user: null,
  devices: [],
  vaults: [],
  files: [],
  selectedVaultId: "",
  selectedVaultIds: new Set<string>(),
  vaultDropdownOpen: false,
  fileVaultMap: {},
  selectedFileId: "",
  selectedFile: null,
  selectedFileIds: new Set<string>(),
  detailModalOpen: false,
  previewVersion: null,
  previewContent: "",
  previewStatus: "idle",
  vaultQuery: "",
  status: "idle",
  message: "请使用邮箱和密码登录。历史版本默认保留三个月。",
  fileStatus: "all",
  fileQuery: "",
  filePage: 1,
  filePageSize: 50,
  fileHasNextPage: false,
  route: parseRoute()
};

function parseRoute(): RouteName {
  const path = window.location.pathname.replace(/\/+$/, "");
  if (path.endsWith("/login")) return "login";
  if (path.endsWith("/users")) return "users";
  return "history";
}

function navigate(route: RouteName, replace = false): void {
  const nextPath = route === "history" ? "/admin/" : `/admin/${route}`;
  if (window.location.pathname !== nextPath) {
    const method = replace ? "replaceState" : "pushState";
    window.history[method]({}, "", nextPath);
  }
  state.route = route;
  render();
  void hydrateRoute(route);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] ?? char);
}

function formatTime(value: string | null): string {
  if (!value) return "--";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function shortHash(value: string | null): string {
  if (!value) return "--";
  return `${value.slice(0, 12)}…${value.slice(-8)}`;
}

function selectedVault(): VaultSummary | undefined {
  return state.vaults.find((vault) => vault.vaultId === state.selectedVaultId);
}

function selectedVaults(): VaultSummary[] {
  return state.vaults.filter((vault) => state.selectedVaultIds.has(vault.vaultId));
}

function effectiveVaultIds(): string[] {
  if (state.selectedVaultIds.size > 0) return Array.from(state.selectedVaultIds);
  return state.selectedVaultId ? [state.selectedVaultId] : [];
}

function vaultName(vaultId: string): string {
  return state.vaults.find((vault) => vault.vaultId === vaultId)?.name ?? vaultId;
}

function persistSession(): void {
  localStorage.setItem(storageKeys.apiBaseUrl, state.apiBaseUrl);
  localStorage.setItem(storageKeys.email, state.email);
  localStorage.setItem(storageKeys.deviceName, state.deviceName);
  localStorage.setItem(storageKeys.accessToken, state.accessToken);
  localStorage.setItem(storageKeys.refreshToken, state.refreshToken);
  localStorage.setItem(storageKeys.accessTokenExpiresAtMs, String(state.accessTokenExpiresAtMs));
}

function clearSession(): void {
  state.accessToken = "";
  state.refreshToken = "";
  state.accessTokenExpiresAtMs = 0;
  state.user = null;
  state.devices = [];
  state.vaults = [];
  state.files = [];
  state.selectedVaultId = "";
  state.selectedVaultIds.clear();
  state.fileVaultMap = {};
  state.vaultDropdownOpen = false;
  state.selectedFileId = "";
  state.selectedFile = null;
  state.selectedFileIds.clear();
  state.detailModalOpen = false;
  state.previewVersion = null;
  state.previewContent = "";
  state.previewStatus = "idle";
  state.vaultQuery = "";
  state.filePage = 1;
  state.fileHasNextPage = false;
  localStorage.removeItem(storageKeys.accessToken);
  localStorage.removeItem(storageKeys.refreshToken);
  localStorage.removeItem(storageKeys.accessTokenExpiresAtMs);
}

async function refreshAccessToken(): Promise<boolean> {
  if (!state.refreshToken) return false;
  const response = await fetch(`${state.apiBaseUrl}/auth/token/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken: state.refreshToken })
  });
  if (!response.ok) return false;
  const body = await response.json() as { accessToken: string; refreshToken: string; expiresIn: number };
  state.accessToken = body.accessToken;
  state.refreshToken = body.refreshToken;
  state.accessTokenExpiresAtMs = Date.now() + body.expiresIn * 1000;
  persistSession();
  return true;
}

async function ensureAccessToken(): Promise<void> {
  if (state.accessToken && Date.now() < state.accessTokenExpiresAtMs - 30_000) return;
  const refreshed = await refreshAccessToken();
  if (!refreshed) throw new Error("登录已失效，请重新登录。");
}

async function requestJson<T>(path: string, options: RequestInit = {}, retry = true): Promise<T> {
  await ensureAccessToken();
  const response = await fetch(`${state.apiBaseUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${state.accessToken}`,
      ...(options.headers ?? {})
    }
  });
  if (response.status === 401 && retry && await refreshAccessToken()) {
    return requestJson<T>(path, options, false);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof body.message === "string" ? body.message : body.code ?? `请求失败：${response.status}`);
  }
  return body as T;
}

async function login(): Promise<void> {
  state.status = "loading";
  state.message = "正在校验账号并注册当前浏览器设备…";
  render();
  const response = await fetch(`${state.apiBaseUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: state.email,
      password: state.password,
      deviceName: state.deviceName,
      platform: "unknown",
      pluginVersion: "admin-web"
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof body.message === "string" ? body.message : body.code ?? "登录失败");
  }
  const data = body as { accessToken: string; refreshToken: string; expiresIn: number };
  state.accessToken = data.accessToken;
  state.refreshToken = data.refreshToken;
  state.accessTokenExpiresAtMs = Date.now() + data.expiresIn * 1000;
  state.password = "";
  state.status = "idle";
  state.message = "登录成功，正在进入控制台。";
  persistSession();
  await loadUserPanel();
  navigate("history", true);
}

async function logout(): Promise<void> {
  try {
    if (state.accessToken) {
      await requestJson("/auth/logout", {
        method: "POST",
        body: JSON.stringify({ refreshToken: state.refreshToken })
      });
    }
  } finally {
    clearSession();
    state.status = "idle";
    state.message = "已退出登录。";
    navigate("login", true);
  }
}

async function loadUserPanel(): Promise<void> {
  const data = await requestJson<{ user: UserProfile; devices: UserDevice[] }>("/users/me");
  state.user = data.user;
  state.devices = data.devices;
}

async function updateDisplayNameFromForm(): Promise<void> {
  const input = document.querySelector<HTMLInputElement>("#profile-display-name");
  const displayName = input?.value.trim();
  if (!displayName) throw new Error("显示名不能为空");
  const data = await requestJson<{ user: UserProfile }>("/users/me", {
    method: "PATCH",
    body: JSON.stringify({ displayName })
  });
  state.user = data.user;
  state.message = "显示名已更新。";
  render();
}

async function updatePasswordFromForm(): Promise<void> {
  const currentPassword = document.querySelector<HTMLInputElement>("#current-password")?.value ?? "";
  const newPassword = document.querySelector<HTMLInputElement>("#new-password")?.value ?? "";
  if (!currentPassword || !newPassword) throw new Error("请填写当前密码和新密码");
  await requestJson("/users/me/password", {
    method: "POST",
    body: JSON.stringify({ currentPassword, newPassword })
  });
  state.message = "密码已更新，其他设备的 refresh token 已撤销。";
  await loadUserPanel();
  render();
}

async function revokeDevice(deviceId: string): Promise<void> {
  if (!window.confirm("确认撤销该设备？该设备需要重新登录。")) return;
  await requestJson(`/users/me/devices/${deviceId}/revoke`, { method: "POST", body: JSON.stringify({}) });
  state.message = "设备已撤销。";
  await loadUserPanel();
  render();
}

async function loadVaults(): Promise<void> {
  state.status = "loading";
  state.message = "正在读取 Vault 与历史数据概览…";
  render();
  await loadUserPanel();
  const data = await requestJson<{ items: VaultSummary[] }>("/admin/vaults");
  state.vaults = data.items;
  state.selectedVaultId = state.selectedVaultId || data.items[0]?.vaultId || "";
  if (state.selectedVaultIds.size === 0 && state.selectedVaultId) {
    state.selectedVaultIds.add(state.selectedVaultId);
  }
  await loadFiles();
}

async function loadFiles(): Promise<void> {
  const vaultIds = effectiveVaultIds();
  if (vaultIds.length === 0) {
    state.status = "idle";
    state.message = "当前账号暂无 Vault。";
    state.fileHasNextPage = false;
    render();
    return;
  }
  const cursor = Math.max(0, (state.filePage - 1) * state.filePageSize);
  const params = new URLSearchParams({ status: state.fileStatus, limit: String(state.filePageSize), cursor: String(cursor) });
  if (state.fileQuery.trim()) params.set("query", state.fileQuery.trim());
  const batches = await Promise.all(vaultIds.map(async (vaultId) => {
    const data = await requestJson<{ items: FileSummary[] }>(`/admin/vaults/${vaultId}/files?${params.toString()}`);
    return data.items.map((file) => ({ ...file, vaultId }));
  }));
  const merged = batches.flat().sort((a, b) => {
    const left = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
    const right = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
    return right - left;
  });
  const visibleFiles = merged.slice(0, state.filePageSize);
  state.files = visibleFiles.map(({ vaultId: _vaultId, ...file }) => file);
  state.fileVaultMap = Object.fromEntries(visibleFiles.map((file) => [file.fileId, file.vaultId]));
  state.fileHasNextPage = batches.some((items) => items.length >= state.filePageSize) || merged.length > state.filePageSize;
  state.selectedFileId = "";
  state.selectedFile = null;
  state.selectedFileIds.clear();
  state.detailModalOpen = false;
  state.status = "idle";
  state.message = `已从 ${vaultIds.length} 个 Vault 载入第 ${state.filePage} 页 ${visibleFiles.length} 个文件记录。`;
  render();
}

function applyFileSearchFromControls(): void {
  state.fileQuery = document.querySelector<HTMLInputElement>("#file-query")?.value ?? "";
  state.fileStatus = (document.querySelector<HTMLSelectElement>("#file-status")?.value as AppState["fileStatus"]) ?? "all";
  state.filePage = 1;
  void loadFiles().catch((error: unknown) => {
    state.status = "error";
    state.message = error instanceof Error ? error.message : "刷新失败";
    render();
  });
}

async function loadFileDetail(fileId: string, shouldRender = true): Promise<void> {
  const vaultId = state.fileVaultMap[fileId] ?? state.selectedVaultId;
  state.selectedVaultId = vaultId;
  state.selectedFileId = fileId;
  state.selectedFile = await requestJson<FileDetail>(`/admin/vaults/${vaultId}/files/${fileId}`);
  state.detailModalOpen = true;
  state.previewVersion = null;
  state.previewContent = "";
  state.previewStatus = "idle";
  if (shouldRender) render();
}

function closeDetailModal(): void {
  state.detailModalOpen = false;
  state.selectedFileId = "";
  state.selectedFile = null;
  state.previewVersion = null;
  state.previewContent = "";
  state.previewStatus = "idle";
  render();
}

async function previewHistoryVersion(version: number): Promise<void> {
  const vaultId = state.selectedFileId ? state.fileVaultMap[state.selectedFileId] ?? state.selectedVaultId : state.selectedVaultId;
  if (!state.selectedFile || !vaultId) return;
  state.previewVersion = version;
  state.previewStatus = "loading";
  state.previewContent = "正在读取历史版本内容…";
  render();
  try {
    const download = await requestJson<{ downloadUrl: string; contentHash: string }>(
      `/vaults/${vaultId}/files/${state.selectedFile.file.fileId}/versions/${version}/download-url`,
      { method: "POST", body: JSON.stringify({}) }
    );
    const response = await fetch(download.downloadUrl);
    if (!response.ok) throw new Error(`下载失败：${response.status}`);
    const contentType = response.headers.get("content-type") ?? "";
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 512 * 1024) {
      throw new Error("文件超过 512KB，暂不在后台直接预览。");
    }
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const hasBinaryChar = /[\u0000-\u0008\u000E-\u001F]/.test(text);
    if (hasBinaryChar && !contentType.includes("text") && !contentType.includes("json")) {
      throw new Error("该历史版本看起来不是文本文件，暂不支持预览。");
    }
    state.previewStatus = "idle";
    state.previewContent = text || "（空文件）";
  } catch (error) {
    state.previewStatus = "error";
    state.previewContent = error instanceof Error ? error.message : "预览失败";
  }
  render();
}

async function previewAction(action: AdminAction, version?: number): Promise<PreviewResponse> {
  if (!state.selectedFile) throw new Error("未选择文件");
  const vaultId = state.fileVaultMap[state.selectedFileId] ?? state.selectedVaultId;
  const targetPath = action === "soft_delete" ? undefined : window.prompt("目标路径", state.selectedFile.file.path) || undefined;
  const payload = action === "soft_delete" ? { action } : { action, version, targetPath };
  return requestJson<PreviewResponse>(`/admin/vaults/${vaultId}/files/${state.selectedFileId}/actions/preview`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

async function executeAction(action: AdminAction, version?: number): Promise<void> {
  try {
    const preview = await previewAction(action, version);
    const actionName = action === "restore" ? "恢复文件" : action === "set_current_version" ? "设为当前版本" : "软删除";
    const previewText = [
      `操作：${actionName}`,
      `将创建版本：v${preview.willCreateVersion}`,
      `将推进 checkpoint：${preview.willCreateCheckpoint}`,
      preview.target ? `目标内容：${shortHash(preview.target.contentHash)}` : "目标内容：当前版本内容",
      preview.target ? `目标路径：${preview.target.path}` : "目标路径：当前路径",
      `路径冲突：${preview.pathConflict ? `是（${preview.pathConflictFileId}）` : "否"}`,
      `保留策略：${preview.retention.policy}`
    ].join("\n");
    if (!window.confirm(`${previewText}\n\n确认继续？`)) return;
    const reason = window.prompt("请输入操作原因", "误删除/错误覆盖恢复")?.trim();
    if (!reason) return;
    const endpoint = action === "restore" ? "restore" : action === "set_current_version" ? "set-current-version" : "soft-delete";
    const body = action === "soft_delete"
      ? { reason, confirmToken: preview.confirmToken }
      : { version, targetPath: preview.target?.path, reason, confirmToken: preview.confirmToken };
    const vaultId = state.fileVaultMap[state.selectedFileId] ?? state.selectedVaultId;
    const result = await requestJson<{ newCheckpoint: string; newVersion: number }>(
      `/admin/vaults/${vaultId}/files/${state.selectedFileId}/${endpoint}`,
      { method: "POST", body: JSON.stringify(body) }
    );
    state.message = `操作完成：生成 v${result.newVersion}，推进到 ${result.newCheckpoint}。客户端下次同步后生效。`;
    await loadFiles();
  } catch (error) {
    state.status = "error";
    state.message = error instanceof Error ? error.message : "操作失败";
    render();
  }
}


function selectedFiles(): FileSummary[] {
  return state.files.filter((file) => state.selectedFileIds.has(file.fileId));
}

async function restoreLatestFile(file: FileSummary): Promise<{ file: FileSummary; newVersion: number; newCheckpoint: string }> {
  const vaultId = state.fileVaultMap[file.fileId] ?? state.selectedVaultId;
  const preview = await requestJson<PreviewResponse>(`/admin/vaults/${vaultId}/files/${file.fileId}/actions/preview`, {
    method: "POST",
    body: JSON.stringify({ action: "restore", version: file.headVersion, targetPath: file.path })
  });
  const result = await requestJson<{ newCheckpoint: string; newVersion: number }>(
    `/admin/vaults/${vaultId}/files/${file.fileId}/restore`,
    {
      method: "POST",
      body: JSON.stringify({
        version: file.headVersion,
        targetPath: preview.target?.path ?? file.path,
        reason: DEFAULT_RESTORE_REASON,
        confirmToken: preview.confirmToken
      })
    }
  );
  return { file, newVersion: result.newVersion, newCheckpoint: result.newCheckpoint };
}

async function restoreLatestFromList(fileId: string): Promise<void> {
  const file = state.files.find((item) => item.fileId === fileId);
  if (!file) return;
  if (!window.confirm(`确认恢复最新版本？\n\n${file.path}\n将使用默认理由：${DEFAULT_RESTORE_REASON}`)) return;
  state.status = "loading";
  state.message = `正在恢复：${file.path}`;
  render();
  try {
    const result = await restoreLatestFile(file);
    await loadFiles();
    state.message = `恢复完成：${result.file.path} 已生成 v${result.newVersion}，推进到 ${result.newCheckpoint}。`;
    render();
  } catch (error) {
    state.status = "error";
    state.message = error instanceof Error ? error.message : "恢复失败";
    render();
  }
}

async function restoreSelectedLatest(): Promise<void> {
  const targets = selectedFiles();
  if (targets.length === 0) return;
  if (!window.confirm(`确认批量恢复 ${targets.length} 个文件的最新版本？\n将使用默认理由：${DEFAULT_RESTORE_REASON}`)) return;
  state.status = "loading";
  state.message = `正在批量恢复 0/${targets.length}…`;
  render();

  const failures: string[] = [];
  let successCount = 0;
  for (const file of targets) {
    try {
      state.message = `正在批量恢复 ${successCount + failures.length + 1}/${targets.length}：${file.path}`;
      render();
      await restoreLatestFile(file);
      successCount += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "恢复失败";
      failures.push(`${file.path}：${message}`);
    }
  }

  state.selectedFileIds.clear();
  await loadFiles();
  state.status = failures.length > 0 ? "error" : "idle";
  state.message = failures.length > 0
    ? `批量恢复完成 ${successCount}/${targets.length}，失败 ${failures.length} 个：${failures.slice(0, 3).join("；")}${failures.length > 3 ? "…" : ""}`
    : `批量恢复完成：${successCount} 个文件已恢复最新版本。`;
  render();
}

async function hydrateRoute(route: RouteName): Promise<void> {
  if (route === "login") return;
  if (!state.accessToken && !state.refreshToken) {
    navigate("login", true);
    return;
  }
  try {
    if (route === "history" && state.vaults.length === 0) await loadVaults();
    if (route === "users") await loadUserPanel().then(render);
  } catch (error) {
    clearSession();
    state.status = "error";
    state.message = error instanceof Error ? error.message : "登录状态失效，请重新登录。";
    navigate("login", true);
  }
}

function renderLogin(): string {
  return `
    <main class="login-page">
      <section class="login-copy">
        <div class="tag-pill">SELF HOSTED SYNC</div>
        <h1>Obsidian<br />Recovery Console</h1>
        <p>面向私有 Vault 的历史版本、设备授权和恢复操作后台。登录后可进入历史数据和用户模块。</p>
        <div class="login-metrics">
          <div><strong>90</strong><span>天墓碑保留</span></div>
          <div><strong>JWT</strong><span>短期访问令牌</span></div>
          <div><strong>Audit</strong><span>操作可追踪</span></div>
        </div>
      </section>
      <section class="login-card">
        <div class="login-orb">OS</div>
        <p class="eyebrow">Secure entrance</p>
        <h2>登录管理后台</h2>
        <label>API 地址<input id="api-base-url" value="${escapeHtml(state.apiBaseUrl)}" autocomplete="url" /></label>
        <label>邮箱<input id="login-email" value="${escapeHtml(state.email)}" autocomplete="username" /></label>
        <label>密码<input id="login-password" value="" type="password" autocomplete="current-password" /></label>
        <label>设备名称<input id="device-name" value="${escapeHtml(state.deviceName)}" /></label>
        <button class="primary-action" id="login">进入控制台 ↗</button>
        <div class="login-hint ${state.status}">${escapeHtml(state.message)}</div>
      </section>
    </main>
  `;
}

function renderSidebar(): string {
  const nav = [
    { route: "history" as const, icon: "◆", label: "历史数据" },
    { route: "users" as const, icon: "●", label: "用户模块" }
  ];
  return `
    <aside class="app-sidebar">
      <div class="brand"><span class="brand-mark">OS</span><strong>Sync Admin</strong></div>
      <nav>
        ${nav.map((item) => `
          <button class="nav-item ${state.route === item.route ? "active" : ""}" data-route="${item.route}">
            <span>${item.icon}</span>${item.label}<b>→</b>
          </button>
        `).join("")}
      </nav>
      <div class="sidebar-card">
        <span class="mesh-icon"></span>
        <strong>Recovery Mode</strong>
        <small>所有高风险操作均需预览、确认与原因记录。</small>
      </div>
      <button class="ghost-action" id="logout">退出登录</button>
    </aside>
  `;
}

function renderTopbar(): string {
  const title = routeTitles[state.route];
  return `
    <header class="workspace-topbar">
      <div>
        <p class="eyebrow">${escapeHtml(title.label)}</p>
        <h1>${escapeHtml(title.title)}</h1>
        <span>${escapeHtml(title.subtitle)}</span>
      </div>
      <div class="topbar-user">
        <div>
          <strong>${escapeHtml(state.user?.displayName ?? state.user?.email ?? "未登录")}</strong>
          <small>${escapeHtml(state.user?.email ?? "")}</small>
        </div>
        <span class="avatar">${escapeHtml((state.user?.displayName ?? state.user?.email ?? "管").slice(0, 1).toUpperCase())}</span>
      </div>
    </header>
  `;
}

function renderNotice(): string {
  return `<div class="notice ${state.status}">${escapeHtml(state.message)}</div>`;
}

function filteredVaults(): VaultSummary[] {
  const query = state.vaultQuery.trim().toLowerCase();
  if (!query) return state.vaults;
  return state.vaults.filter((vault) =>
    vault.name.toLowerCase().includes(query) || vault.vaultId.toLowerCase().includes(query)
  );
}

function renderVaultSearchInline(): string {
  const selected = selectedVaults();
  const visibleVaults = filteredVaults().slice(0, 12);
  return `
    <div class="search-block vault-block multi-vault-block">
      <label>Vault</label>
      <div class="vault-combobox-shell">
        <div class="vault-chip-row">
          ${selected.map((vault) => `
            <button class="vault-chip" type="button" data-remove-vault-id="${vault.vaultId}" title="移除 ${escapeHtml(vault.name)}">
              ${escapeHtml(vault.name)} <span>×</span>
            </button>
          `).join("") || `<span class="vault-placeholder">选择一个或多个 Vault</span>`}
        </div>
        <input id="vault-query" value="${escapeHtml(state.vaultQuery)}" placeholder="搜索 Vault 名称或 ID" autocomplete="off" />
        <button id="toggle-vault-dropdown" class="dropdown-trigger" type="button">${state.vaultDropdownOpen ? "收起" : "展开"}</button>
      </div>
      <div class="vault-dropdown ${state.vaultDropdownOpen ? "open" : ""}">
        ${visibleVaults.map((vault) => `
          <label class="vault-select-option ${state.selectedVaultIds.has(vault.vaultId) ? "selected" : ""}">
            <input type="checkbox" data-vault-option-id="${vault.vaultId}" ${state.selectedVaultIds.has(vault.vaultId) ? "checked" : ""} />
            <span>
              <strong>${escapeHtml(vault.name)}</strong>
              <small>${vault.latestCheckpoint} · ${vault.fileCount} 文件 · ${vault.deletedFileCount} 删除</small>
            </span>
          </label>
        `).join("") || "<p class='empty'>没有匹配 Vault</p>"}
      </div>
      <p class="selected-vault-note">当前筛选：${selected.length > 0 ? selected.map((vault) => escapeHtml(vault.name)).join("、") : "未选择"}</p>
    </div>
  `;
}

function renderFilesTable(): string {
  const currentVaults = selectedVaults();
  const selectedCount = state.selectedFileIds.size;
  const allVisibleSelected = state.files.length > 0 && state.files.every((file) => state.selectedFileIds.has(file.fileId));
  return `
    <section class="file-table-panel full-width">
      <div class="section-head">
        <div>
          <p class="eyebrow">Files</p>
          <h2>${currentVaults.length > 1 ? `${currentVaults.length} 个 Vault` : escapeHtml(currentVaults[0]?.name ?? "未选择 Vault")}</h2>
        </div>
        <span>${state.files.length} 条</span>
      </div>
      <form id="file-search-form" class="unified-search-panel">
        ${renderVaultSearchInline()}
        <div class="search-block file-block">
          <label>文件路径</label>
          <input id="file-query" value="${escapeHtml(state.fileQuery)}" placeholder="搜索文件路径、版本或关键字" />
        </div>
        <div class="search-block status-block">
          <label>状态</label>
          <select id="file-status">
            ${["all", "active", "deleted"].map((item) => `<option value="${item}" ${state.fileStatus === item ? "selected" : ""}>${item}</option>`).join("")}
          </select>
        </div>
        <button id="reload-files" class="search-submit" type="submit">搜索</button>
      </form>
      <div class="batch-toolbar">
        <label class="select-all-box">
          <input id="select-all-files" type="checkbox" ${allVisibleSelected ? "checked" : ""} ${state.files.length === 0 ? "disabled" : ""} />
          <span>选择当前列表</span>
        </label>
        <strong>${selectedCount} 个已选</strong>
        <button id="batch-restore-latest" class="batch-action" ${selectedCount === 0 ? "disabled" : ""}>批量恢复最新版本</button>
        <small>删除文件会恢复 head 最新版本；有效文件会以最新版本重新生成后台恢复记录，理由使用默认值。</small>
      </div>

      <div class="pagination-toolbar">
        <span>第 ${state.filePage} 页 · 每页 ${state.filePageSize} 条</span>
        <div class="pagination-actions">
          <button id="prev-files-page" class="page-action" type="button" ${state.filePage <= 1 ? "disabled" : ""}>上一页</button>
          <button id="next-files-page" class="page-action" type="button" ${!state.fileHasNextPage ? "disabled" : ""}>下一页</button>
        </div>
      </div>
      <div class="file-table-wrap">
        <table class="file-table">
          <thead>
            <tr>
              <th class="select-col">选择</th>
              <th>状态</th>
              <th>路径</th>
              <th>版本</th>
              <th>Checkpoint</th>
              <th>更新时间</th>
              <th>Hash</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            ${state.files.map((file) => `
              <tr class="${file.deleted ? "deleted" : "active"} ${state.selectedFileIds.has(file.fileId) ? "selected" : ""}">
                <td class="select-col"><input class="file-select" type="checkbox" data-select-file-id="${file.fileId}" ${state.selectedFileIds.has(file.fileId) ? "checked" : ""} aria-label="选择 ${escapeHtml(file.path)}" /></td>
                <td><span class="table-status ${file.deleted ? "deleted" : "active"}">${file.deleted ? "已删除" : "有效"}</span></td>
                <td class="path-cell"><span>${escapeHtml(file.path)}</span><small>${escapeHtml(vaultName(state.fileVaultMap[file.fileId] ?? state.selectedVaultId))}</small></td>
                <td>v${file.headVersion}</td>
                <td>${file.latestCheckpoint}</td>
                <td>${formatTime(file.updatedAt)}</td>
                <td>${shortHash(file.latestContentHash)}</td>
                <td class="row-actions">
                  <button class="row-action restore" data-restore-latest-file-id="${file.fileId}">恢复</button>
                  <button class="row-action" data-file-id="${file.fileId}">详情</button>
                </td>
              </tr>
            `).join("") || `<tr><td colspan="8" class="empty-table">没有匹配文件</td></tr>`}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderDetailModal(): string {
  const detail = state.selectedFile;
  if (!state.detailModalOpen || !detail) return "";
  return `
    <div class="modal-backdrop" role="presentation" data-close-modal="true">
      <section class="detail-modal" role="dialog" aria-modal="true" aria-label="文件详情">
        <button class="modal-close" id="close-detail-modal">×</button>
        <div class="detail-hero">
          <div>
            <p class="eyebrow">File Detail</p>
            <h2>${escapeHtml(detail.file.path)}</h2>
            <p>${detail.file.deleted ? `已删除于 ${formatTime(detail.file.deletedAt)}` : "当前有效"} · head v${detail.file.headVersion}</p>
          </div>
          <div class="hero-actions"><button data-action="soft_delete" ${detail.file.deleted ? "disabled" : ""}>软删除</button></div>
        </div>
        <div class="timeline-grid modal-grid">
          <article>
            <h3>历史版本</h3>
            ${detail.versions.map((version) => `
              <div class="version-card ${version.current ? "current" : ""}">
                <div>
                  <strong>v${version.version}${version.current ? " · 当前" : ""}</strong>
                  <p>${shortHash(version.contentHash)} · ${formatTime(version.createdAt)}</p>
                  <small>${escapeHtml(version.authorDeviceName ?? "未知设备")} / ${escapeHtml(version.authorPlatform ?? "unknown")}</small>
                </div>
                <div class="version-actions">
                  <button data-preview-version="${version.version}">预览</button>
                  <button data-action="restore" data-version="${version.version}">恢复</button>
                  <button data-action="set_current_version" data-version="${version.version}">设为当前</button>
                </div>
              </div>
            `).join("")}
          </article>
          <article class="preview-article">
            <h3>历史文件预览</h3>
            <div class="preview-toolbar">
              <span>${state.previewVersion ? `v${state.previewVersion}` : "请选择左侧版本预览"}</span>
              <small>${state.previewStatus === "loading" ? "读取中" : state.previewStatus === "error" ? "预览失败" : "文本预览"}</small>
            </div>
            <pre class="history-preview ${state.previewStatus}">${escapeHtml(state.previewContent || "点击某个历史版本的“预览”按钮，在这里查看当时的文件内容。")}</pre>
          </article>
          <article>
            <h3>同步事件</h3>
            ${detail.events.map((event) => `
              <div class="event-row">
                <strong>${event.checkpoint} · ${event.op}</strong>
                <p>${escapeHtml(event.path)} · v${event.version}</p>
                <small>${event.source}${event.reason ? ` · ${escapeHtml(event.reason)}` : ""} · ${formatTime(event.createdAt)}</small>
              </div>
            `).join("") || "<p class='empty'>暂无事件</p>"}
            <h3>管理操作</h3>
            ${detail.operations.map((operation) => `
              <div class="event-row admin-op">
                <strong>${operation.operation} · ${operation.status}</strong>
                <p>${escapeHtml(operation.reason)}</p>
                <small>${operation.changesetId ?? "无 changeset"} · ${formatTime(operation.createdAt)}</small>
              </div>
            `).join("") || "<p class='empty'>暂无后台操作</p>"}
          </article>
        </div>
      </section>
    </div>
  `;
}

function renderHistoryPage(): string {
  return `<main class="history-shell list-mode">${renderFilesTable()}</main>${renderDetailModal()}`;
}

function renderUsersPage(): string {
  return `
    <main class="users-shell">
      <section class="profile-card">
        <p class="eyebrow">Profile</p>
        <h2>${escapeHtml(state.user?.displayName ?? "未设置显示名")}</h2>
        <p>${escapeHtml(state.user?.email ?? "")}</p>
        <div class="profile-grid">
          <div><span>用户 ID</span><strong>${escapeHtml(state.user?.userId ?? "--")}</strong></div>
          <div><span>创建时间</span><strong>${formatTime(state.user?.createdAt ?? null)}</strong></div>
          <div><span>最近登录</span><strong>${formatTime(state.user?.lastLoginAt ?? null)}</strong></div>
        </div>
      </section>
      <section class="settings-card">
        <p class="eyebrow">Account settings</p>
        <h3>资料与密码</h3>
        <label>显示名<input id="profile-display-name" value="${escapeHtml(state.user?.displayName ?? "")}" /></label>
        <button class="primary-action compact" id="save-profile">保存资料</button>
        <div class="password-grid">
          <label>当前密码<input id="current-password" type="password" autocomplete="current-password" /></label>
          <label>新密码<input id="new-password" type="password" autocomplete="new-password" /></label>
        </div>
        <button class="ghost-action dark" id="save-password">更新密码并撤销其他设备</button>
      </section>
      <section class="devices-card">
        <div class="section-head"><div><p class="eyebrow">Devices</p><h3>已登录设备</h3></div><span>${state.devices.length} 台</span></div>
        <div class="device-list">
          ${state.devices.map((device) => `
            <article class="device-row ${device.current ? "current" : ""} ${device.status}">
              <div class="device-icon">${device.current ? "●" : "○"}</div>
              <div>
                <strong>${escapeHtml(device.deviceName)}</strong>
                <p>${escapeHtml(device.platform)} · ${escapeHtml(device.pluginVersion)} · ${device.status}</p>
                <small>创建：${formatTime(device.createdAt)} · 活跃 refresh token：${device.activeRefreshTokenCount}</small>
              </div>
              ${device.status === "active" && !device.current ? `<button data-revoke-device="${device.deviceId}">撤销</button>` : `<span>${device.current ? "当前设备" : "已撤销"}</span>`}
            </article>
          `).join("") || "<p class='empty'>暂无设备</p>"}
        </div>
      </section>
    </main>
  `;
}

function renderWorkspace(): string {
  return `
    <div class="workspace">
      ${renderSidebar()}
      <section class="workspace-main">
        ${renderTopbar()}
        ${renderNotice()}
        ${state.route === "users" ? renderUsersPage() : renderHistoryPage()}
      </section>
    </div>
  `;
}

function render(): void {
  const app = document.querySelector<HTMLElement>("#app");
  if (!app) throw new Error("管理后台挂载节点不存在");
  state.route = parseRoute();
  const shouldShowLogin = state.route === "login" || (!state.accessToken && !state.refreshToken);
  app.innerHTML = shouldShowLogin ? renderLogin() : renderWorkspace();
  bindEvents();
}

function bindEvents(): void {
  document.querySelector<HTMLButtonElement>("#login")?.addEventListener("click", () => {
    state.apiBaseUrl = document.querySelector<HTMLInputElement>("#api-base-url")?.value.trim() || state.apiBaseUrl;
    state.email = document.querySelector<HTMLInputElement>("#login-email")?.value.trim() || "";
    state.password = document.querySelector<HTMLInputElement>("#login-password")?.value || "";
    state.deviceName = document.querySelector<HTMLInputElement>("#device-name")?.value.trim() || state.deviceName;
    void login().catch((error: unknown) => {
      state.status = "error";
      state.message = error instanceof Error ? error.message : "登录失败";
      render();
    });
  });
  document.querySelector<HTMLButtonElement>("#logout")?.addEventListener("click", () => void logout());
  document.querySelectorAll<HTMLButtonElement>("[data-route]").forEach((button) => {
    button.addEventListener("click", () => navigate((button.dataset.route as RouteName) ?? "history"));
  });
  document.querySelector<HTMLButtonElement>("#save-profile")?.addEventListener("click", () => {
    void updateDisplayNameFromForm().catch((error: unknown) => {
      state.status = "error";
      state.message = error instanceof Error ? error.message : "修改资料失败";
      render();
    });
  });
  document.querySelector<HTMLButtonElement>("#save-password")?.addEventListener("click", () => {
    void updatePasswordFromForm().catch((error: unknown) => {
      state.status = "error";
      state.message = error instanceof Error ? error.message : "修改密码失败";
      render();
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-revoke-device]").forEach((button) => {
    button.addEventListener("click", () => {
      void revokeDevice(button.dataset.revokeDevice ?? "").catch((error: unknown) => {
        state.status = "error";
        state.message = error instanceof Error ? error.message : "撤销设备失败";
        render();
      });
    });
  });
  document.querySelector<HTMLInputElement>("#vault-query")?.addEventListener("input", (event) => {
    state.vaultQuery = (event.target as HTMLInputElement).value;
    state.vaultDropdownOpen = true;
    render();
  });
  document.querySelector<HTMLInputElement>("#vault-query")?.addEventListener("focus", () => {
    state.vaultDropdownOpen = true;
    render();
  });
  document.querySelector<HTMLButtonElement>("#toggle-vault-dropdown")?.addEventListener("click", () => {
    state.vaultDropdownOpen = !state.vaultDropdownOpen;
    render();
  });
  document.querySelectorAll<HTMLInputElement>("[data-vault-option-id]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const vaultId = checkbox.dataset.vaultOptionId ?? "";
      if (checkbox.checked) {
        state.selectedVaultIds.add(vaultId);
        state.selectedVaultId = vaultId;
      } else {
        state.selectedVaultIds.delete(vaultId);
        state.selectedVaultId = effectiveVaultIds()[0] ?? "";
      }
      state.filePage = 1;
      void loadFiles().catch((error: unknown) => {
        state.status = "error";
        state.message = error instanceof Error ? error.message : "读取文件失败";
        render();
      });
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-remove-vault-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedVaultIds.delete(button.dataset.removeVaultId ?? "");
      state.selectedVaultId = effectiveVaultIds()[0] ?? "";
      state.filePage = 1;
      void loadFiles().catch((error: unknown) => {
        state.status = "error";
        state.message = error instanceof Error ? error.message : "读取文件失败";
        render();
      });
    });
  });
  document.querySelector<HTMLFormElement>("#file-search-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    applyFileSearchFromControls();
  });
  document.querySelector<HTMLButtonElement>("#prev-files-page")?.addEventListener("click", () => {
    if (state.filePage <= 1) return;
    state.filePage -= 1;
    void loadFiles().catch((error: unknown) => {
      state.status = "error";
      state.message = error instanceof Error ? error.message : "读取上一页失败";
      render();
    });
  });
  document.querySelector<HTMLButtonElement>("#next-files-page")?.addEventListener("click", () => {
    if (!state.fileHasNextPage) return;
    state.filePage += 1;
    void loadFiles().catch((error: unknown) => {
      state.status = "error";
      state.message = error instanceof Error ? error.message : "读取下一页失败";
      render();
    });
  });
  document.querySelector<HTMLInputElement>("#select-all-files")?.addEventListener("change", (event) => {
    const checked = (event.target as HTMLInputElement).checked;
    state.selectedFileIds.clear();
    if (checked) {
      state.files.forEach((file) => state.selectedFileIds.add(file.fileId));
    }
    render();
  });
  document.querySelectorAll<HTMLInputElement>("[data-select-file-id]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const fileId = checkbox.dataset.selectFileId ?? "";
      if (checkbox.checked) {
        state.selectedFileIds.add(fileId);
      } else {
        state.selectedFileIds.delete(fileId);
      }
      render();
    });
  });
  document.querySelector<HTMLButtonElement>("#batch-restore-latest")?.addEventListener("click", () => {
    void restoreSelectedLatest();
  });
  document.querySelectorAll<HTMLButtonElement>("[data-restore-latest-file-id]").forEach((button) => {
    button.addEventListener("click", () => {
      void restoreLatestFromList(button.dataset.restoreLatestFileId ?? "");
    });
  });
  document.querySelector<HTMLButtonElement>("#close-detail-modal")?.addEventListener("click", () => closeDetailModal());
  document.querySelector<HTMLElement>("[data-close-modal]")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeDetailModal();
  });
  document.querySelectorAll<HTMLButtonElement>("[data-file-id]").forEach((button) => {
    button.addEventListener("click", () => {
      void loadFileDetail(button.dataset.fileId ?? "").catch((error: unknown) => {
        state.status = "error";
        state.message = error instanceof Error ? error.message : "读取详情失败";
        render();
      });
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-preview-version]").forEach((button) => {
    button.addEventListener("click", () => {
      const version = Number(button.dataset.previewVersion);
      void previewHistoryVersion(version);
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.action as AdminAction;
      const version = button.dataset.version ? Number(button.dataset.version) : undefined;
      void executeAction(action, version);
    });
  });
}

window.addEventListener("popstate", () => {
  state.route = parseRoute();
  render();
  void hydrateRoute(state.route);
});

render();

if (state.accessToken || state.refreshToken) {
  void hydrateRoute(state.route === "login" ? "history" : state.route);
} else if (state.route !== "login") {
  navigate("login", true);
}
