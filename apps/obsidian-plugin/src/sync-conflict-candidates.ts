import type { SyncChangeRequest, SyncConflict } from "./api-client";
import type { ConflictResolutionAction, ConflictResolutionCandidate } from "./conflict-resolution-modal";

export interface LocalConflictFileInfo {
  exists: boolean;
  isConflictCopy: boolean;
  previewText: string | null;
}

export function buildConflictResolutionId(conflict: SyncConflict, path: string): string {
  return `${conflict.index}:${conflict.code}:${path}:${conflict.fileId ?? ""}`;
}

export function getRecommendedConflictAction(conflict: SyncConflict, path: string): ConflictResolutionAction {
  if (path.includes(".conflict-")) {
    return "use_remote";
  }
  if (conflict.code === "FILE_NOT_FOUND") {
    return "use_local";
  }
  return "defer";
}

export function getConflictRecommendationReason(
  action: ConflictResolutionAction,
  conflict: SyncConflict,
  path: string
): string {
  if (action === "use_remote") {
    if (path.includes(".conflict-")) {
      return "当前文件已经是冲突副本，继续保留本地通常只会制造更多套娃副本。";
    }
    return "优先接受远端状态，避免继续放大当前冲突。";
  }
  if (action === "use_local") {
    if (conflict.code === "FILE_NOT_FOUND") {
      return "远端文件记录已不存在，保留本地更适合在下一轮以新文件重新建模。";
    }
    return "本地内容更可能是最新编辑结果。";
  }
  return "当前信息不足，建议先人工确认后再决定。";
}

export function buildConflictResolutionCandidate(
  conflict: SyncConflict,
  localPlan: { changes: SyncChangeRequest[] },
  localInfo: LocalConflictFileInfo
): ConflictResolutionCandidate {
  const change = localPlan.changes[conflict.index];
  const path = change?.path ?? conflict.path;
  const recommendedAction = getRecommendedConflictAction(conflict, path);

  return {
    id: buildConflictResolutionId(conflict, path),
    code: conflict.code,
    path,
    fileId: conflict.fileId,
    message: conflict.message,
    localExists: localInfo.exists,
    localIsConflictCopy: localInfo.isConflictCopy,
    localPreview: localInfo.previewText,
    remoteSummary: buildRemoteSummary(conflict),
    recommendedAction,
    recommendedReason: getConflictRecommendationReason(recommendedAction, conflict, path)
  };
}

export function buildRemoteSummary(conflict: SyncConflict): string | null {
  const parts: string[] = [];
  if (conflict.reason) {
    parts.push(`原因标记：${conflict.reason}`);
  }
  if (conflict.remotePath) {
    parts.push(`远端路径：${conflict.remotePath}`);
  }
  if (typeof conflict.headVersion === "number") {
    parts.push(`远端头版本：${conflict.headVersion}`);
  }
  if (typeof conflict.remoteDeleted === "boolean") {
    parts.push(`远端是否已删除：${conflict.remoteDeleted ? "是" : "否"}`);
  }
  if (conflict.existingFileId) {
    parts.push(`占用文件 ID：${conflict.existingFileId}`);
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

export function createTextPreview(bytes: ArrayBuffer, maxChars = 280): string {
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const normalized = decoded.replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars)}...`;
}
