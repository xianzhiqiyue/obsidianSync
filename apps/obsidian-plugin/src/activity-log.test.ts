import assert from "node:assert/strict";
import test from "node:test";
import { formatActivitySummary, normalizeActivityLog } from "./activity-log";

test("normalizeActivityLog filters invalid items and caps length", () => {
  const items = [
    { ts: 1, type: "skipped", message: "ok", path: "a.md" },
    { ts: 2, type: "upload", message: "ok" },
    { ts: Number.NaN, type: "bad", message: 1 } as never,
    ...Array.from({ length: 250 }, (_, index) => ({ ts: index + 3, type: "download" as const, message: "x" }))
  ];

  const normalized = normalizeActivityLog(items);
  assert.equal(normalized.length, 200);
  assert.deepEqual(normalized[0], { ts: 1, type: "skipped", message: "ok", path: "a.md" });
  assert.equal(normalized.some((item) => Number.isNaN(item.ts)), false);
  assert.equal(normalized.some((item) => item.type === ("bad" as never)), false);
});

test("formatActivitySummary renders concise copyable log", () => {
  const summary = formatActivitySummary(
    [{ ts: 123, type: "skipped", message: "excluded", path: "private/a.md" }],
    (ts) => `time-${ts}`
  );

  assert.equal(summary, "最近活动：\ntime-123 · skipped · excluded · private/a.md");
});
