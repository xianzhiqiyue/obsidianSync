export const SYNC_ACTIVITY_TYPES = ["skipped", "connect", "disconnect", "error", "upload", "download", "delete", "rename"] as const;
export type SyncActivityType = (typeof SYNC_ACTIVITY_TYPES)[number];

export interface SyncActivityItem {
  ts: number;
  type: SyncActivityType;
  message: string;
  path?: string;
}

export function normalizeActivityLog(items: SyncActivityItem[] | undefined): SyncActivityItem[] {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .filter((item) =>
      Number.isFinite(item?.ts) &&
      isSyncActivityType(item?.type) &&
      typeof item?.message === "string" &&
      (item.path === undefined || typeof item.path === "string")
    )
    .slice(0, 200);
}

function isSyncActivityType(value: unknown): value is SyncActivityType {
  return typeof value === "string" && (SYNC_ACTIVITY_TYPES as readonly string[]).includes(value);
}

export function formatActivitySummary(items: SyncActivityItem[], toTimeString = (ts: number) => new Date(ts).toLocaleTimeString()): string {
  if (items.length === 0) {
    return "最近活动：-";
  }

  return [
    "最近活动：",
    ...items.slice(0, 8).map((item) => {
      const path = item.path ? ` · ${item.path}` : "";
      return `${toTimeString(item.ts)} · ${item.type} · ${item.message}${path}`;
    })
  ].join("\n");
}
