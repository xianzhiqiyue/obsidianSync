export type LastModifiedWinsDecision = "use_local" | "use_remote" | "defer";

export function isTextMergePath(path: string): boolean {
  return path.endsWith(".md") || path.endsWith(".json");
}

export function decideLastModifiedWins(
  _path: string,
  localOperationTimeMs: number | undefined,
  remoteOperationTimeMs: number | undefined
): LastModifiedWinsDecision {
  if (typeof localOperationTimeMs !== "number" || !Number.isFinite(localOperationTimeMs)) {
    return "defer";
  }
  if (typeof remoteOperationTimeMs !== "number" || !Number.isFinite(remoteOperationTimeMs)) {
    return "defer";
  }
  return localOperationTimeMs > remoteOperationTimeMs ? "use_local" : "use_remote";
}
