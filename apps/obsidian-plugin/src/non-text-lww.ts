export type LastModifiedWinsDecision = "use_local" | "use_remote" | "defer";

export function isTextMergePath(path: string): boolean {
  return path.endsWith(".md") || path.endsWith(".json");
}

export function decideLastModifiedWins(
  path: string,
  localMtimeMs: number | undefined,
  remoteMtimeMs: number | undefined
): LastModifiedWinsDecision {
  if (isTextMergePath(path)) {
    return "defer";
  }
  if (typeof localMtimeMs !== "number" || !Number.isFinite(localMtimeMs)) {
    return "defer";
  }
  if (typeof remoteMtimeMs !== "number" || !Number.isFinite(remoteMtimeMs)) {
    return "defer";
  }
  return localMtimeMs > remoteMtimeMs ? "use_local" : "use_remote";
}
