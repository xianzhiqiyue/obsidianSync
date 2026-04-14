export interface JsonMergeResult {
  merged: string;
  clean: boolean;
}

export function mergeJsonText(base: string, local: string, remote: string): JsonMergeResult {
  void base;
  try {
    const localValue = JSON.parse(local) as unknown;
    const remoteValue = JSON.parse(remote) as unknown;
    if (!isPlainObject(localValue) || !isPlainObject(remoteValue)) {
      return { merged: remote, clean: false };
    }

    return {
      merged: `${JSON.stringify(deepMergeObjects(remoteValue, localValue), null, 2)}\n`,
      clean: true
    };
  } catch {
    return { merged: remote, clean: false };
  }
}

function deepMergeObjects(remote: Record<string, unknown>, local: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...remote };
  for (const [key, localValue] of Object.entries(local)) {
    const remoteValue = merged[key];
    merged[key] = isPlainObject(remoteValue) && isPlainObject(localValue)
      ? deepMergeObjects(remoteValue, localValue)
      : localValue;
  }
  return merged;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
