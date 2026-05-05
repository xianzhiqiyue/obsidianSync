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

type AdminAction = "restore" | "set_current_version" | "soft_delete";

type AppState = {
  apiBaseUrl: string;
  accessToken: string;
  vaults: VaultSummary[];
  files: FileSummary[];
  selectedVaultId: string;
  selectedFileId: string;
  selectedFile: FileDetail | null;
  status: "idle" | "loading" | "error";
  message: string;
  fileStatus: "all" | "active" | "deleted";
  fileQuery: string;
};

const storageKeys = {
  apiBaseUrl: "obsidian-sync-admin-api-base-url",
  accessToken: "obsidian-sync-admin-access-token"
};

const state: AppState = {
  apiBaseUrl: localStorage.getItem(storageKeys.apiBaseUrl) ?? "http://localhost:3000/api/v1",
  accessToken: localStorage.getItem(storageKeys.accessToken) ?? "",
  vaults: [],
  files: [],
  selectedVaultId: "",
  selectedFileId: "",
  selectedFile: null,
  status: "idle",
  message: "历史版本默认保留三个月。请先填入 API 地址和 access token。",
  fileStatus: "all",
  fileQuery: ""
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] ?? char);
}

function formatTime(value: string | null): string {
  if (!value) return "--";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "medium" }).format(new Date(value));
}

function shortHash(value: string | null): string {
  if (!value) return "--";
  return `${value.slice(0, 14)}…${value.slice(-8)}`;
}

function selectedVault(): VaultSummary | undefined {
  return state.vaults.find((vault) => vault.vaultId === state.selectedVaultId);
}

async function requestJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${state.apiBaseUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${state.accessToken}`,
      ...(options.headers ?? {})
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof body.message === "string" ? body.message : body.code ?? `请求失败：${response.status}`);
  }
  return body as T;
}

async function loadVaults(): Promise<void> {
  state.status = "loading";
  state.message = "正在读取 Vault 与历史数据概览…";
  render();
  const data = await requestJson<{ items: VaultSummary[] }>("/admin/vaults");
  state.vaults = data.items;
  state.selectedVaultId = state.selectedVaultId || data.items[0]?.vaultId || "";
  await loadFiles();
}

async function loadFiles(): Promise<void> {
  if (!state.selectedVaultId) return;
  const params = new URLSearchParams({ status: state.fileStatus, limit: "80" });
  if (state.fileQuery.trim()) params.set("query", state.fileQuery.trim());
  const data = await requestJson<{ items: FileSummary[] }>(`/admin/vaults/${state.selectedVaultId}/files?${params.toString()}`);
  state.files = data.items;
  state.selectedFileId = data.items[0]?.fileId ?? "";
  state.selectedFile = null;
  if (state.selectedFileId) await loadFileDetail(state.selectedFileId, false);
  state.status = "idle";
  state.message = `已载入 ${data.items.length} 个文件记录。`;
  render();
}

async function loadFileDetail(fileId: string, shouldRender = true): Promise<void> {
  state.selectedFileId = fileId;
  state.selectedFile = await requestJson<FileDetail>(`/admin/vaults/${state.selectedVaultId}/files/${fileId}`);
  if (shouldRender) render();
}

async function previewAction(action: AdminAction, version?: number): Promise<PreviewResponse> {
  if (!state.selectedFile) throw new Error("未选择文件");
  const targetPath = action === "soft_delete" ? undefined : window.prompt("目标路径", state.selectedFile.file.path) || undefined;
  const payload = action === "soft_delete" ? { action } : { action, version, targetPath };
  return requestJson<PreviewResponse>(`/admin/vaults/${state.selectedVaultId}/files/${state.selectedFileId}/actions/preview`, {
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
    const result = await requestJson<{ newCheckpoint: string; newVersion: number }>(
      `/admin/vaults/${state.selectedVaultId}/files/${state.selectedFileId}/${endpoint}`,
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

function renderVaultRail(): string {
  return `
    <aside class="vault-rail">
      <div class="rail-title">Vaults</div>
      ${state.vaults.map((vault) => `
        <button class="vault-card ${vault.vaultId === state.selectedVaultId ? "selected" : ""}" data-vault-id="${vault.vaultId}">
          <span>${escapeHtml(vault.name)}</span>
          <strong>${vault.latestCheckpoint}</strong>
          <small>${vault.fileCount} 文件 · ${vault.deletedFileCount} 删除</small>
        </button>
      `).join("") || "<p class='empty'>暂无 Vault</p>"}
    </aside>
  `;
}

function renderFiles(): string {
  return `
    <section class="file-column">
      <div class="section-head">
        <div>
          <p class="eyebrow">History Index</p>
          <h2>${escapeHtml(selectedVault()?.name ?? "未选择 Vault")}</h2>
        </div>
        <span>${state.files.length} 条</span>
      </div>
      <div class="filters">
        <input id="file-query" value="${escapeHtml(state.fileQuery)}" placeholder="搜索路径" />
        <select id="file-status">
          ${["all", "active", "deleted"].map((item) => `<option value="${item}" ${state.fileStatus === item ? "selected" : ""}>${item}</option>`).join("")}
        </select>
        <button id="reload-files">刷新</button>
      </div>
      <div class="file-list">
        ${state.files.map((file) => `
          <button class="file-row ${file.fileId === state.selectedFileId ? "selected" : ""}" data-file-id="${file.fileId}">
            <span class="status-dot ${file.deleted ? "deleted" : "active"}"></span>
            <span class="file-path">${escapeHtml(file.path)}</span>
            <span class="file-meta">v${file.headVersion} · ${file.latestCheckpoint} · ${formatTime(file.updatedAt)}</span>
          </button>
        `).join("") || "<p class='empty'>没有匹配文件</p>"}
      </div>
    </section>
  `;
}

function renderDetail(): string {
  const detail = state.selectedFile;
  if (!detail) return `<section class="detail-panel empty-panel">选择一个文件查看历史版本</section>`;
  return `
    <section class="detail-panel">
      <div class="detail-hero">
        <div>
          <p class="eyebrow">File Timeline</p>
          <h2>${escapeHtml(detail.file.path)}</h2>
          <p>${detail.file.deleted ? `已删除于 ${formatTime(detail.file.deletedAt)}` : "当前有效"} · head v${detail.file.headVersion}</p>
        </div>
        <div class="hero-actions">
          <button data-action="soft_delete" ${detail.file.deleted ? "disabled" : ""}>软删除</button>
        </div>
      </div>

      <div class="timeline-grid">
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
                <button data-action="restore" data-version="${version.version}">恢复</button>
                <button data-action="set_current_version" data-version="${version.version}">设为当前</button>
              </div>
            </div>
          `).join("")}
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
  `;
}

function render(): void {
  const app = document.querySelector<HTMLElement>("#app");
  if (!app) throw new Error("管理后台挂载节点不存在");
  app.innerHTML = `
    <header class="topbar">
      <div>
        <p class="eyebrow">Obsidian Sync Recovery Console</p>
        <h1>历史数据恢复控制台</h1>
      </div>
      <div class="connection">
        <input id="api-base-url" value="${escapeHtml(state.apiBaseUrl)}" placeholder="API Base URL" />
        <input id="access-token" value="${escapeHtml(state.accessToken)}" placeholder="Access Token" type="password" />
        <button id="save-connection">连接</button>
      </div>
    </header>
    <div class="notice ${state.status}">${escapeHtml(state.message)}</div>
    <main class="console-shell">
      ${renderVaultRail()}
      ${renderFiles()}
      ${renderDetail()}
    </main>
  `;
  bindEvents();
}

function bindEvents(): void {
  document.querySelector<HTMLButtonElement>("#save-connection")?.addEventListener("click", () => {
    state.apiBaseUrl = document.querySelector<HTMLInputElement>("#api-base-url")?.value.trim() || state.apiBaseUrl;
    state.accessToken = document.querySelector<HTMLInputElement>("#access-token")?.value.trim() || "";
    localStorage.setItem(storageKeys.apiBaseUrl, state.apiBaseUrl);
    localStorage.setItem(storageKeys.accessToken, state.accessToken);
    void loadVaults().catch((error: unknown) => {
      state.status = "error";
      state.message = error instanceof Error ? error.message : "连接失败";
      render();
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-vault-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedVaultId = button.dataset.vaultId ?? "";
      void loadFiles().catch((error: unknown) => {
        state.status = "error";
        state.message = error instanceof Error ? error.message : "读取文件失败";
        render();
      });
    });
  });
  document.querySelector<HTMLButtonElement>("#reload-files")?.addEventListener("click", () => {
    state.fileQuery = document.querySelector<HTMLInputElement>("#file-query")?.value ?? "";
    state.fileStatus = (document.querySelector<HTMLSelectElement>("#file-status")?.value as AppState["fileStatus"]) ?? "all";
    void loadFiles().catch((error: unknown) => {
      state.status = "error";
      state.message = error instanceof Error ? error.message : "刷新失败";
      render();
    });
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
  document.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.action as AdminAction;
      const version = button.dataset.version ? Number(button.dataset.version) : undefined;
      void executeAction(action, version);
    });
  });
}

render();
