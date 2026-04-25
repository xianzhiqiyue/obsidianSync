import assert from "node:assert/strict";
import test from "node:test";
import { buildConflictCopyPath, isConflictCopyPath } from "./conflict-copy";

test("buildConflictCopyPath uses official Obsidian conflicted copy naming", () => {
  const path = buildConflictCopyPath("notes/Meeting notes.md", "My/Mac", new Date("2026-04-14T15:45:00"));
  assert.equal(path, "notes/Meeting notes (Conflicted copy My-Mac 202604141545).md");
});

test("buildConflictCopyPath supports extensionless files", () => {
  const path = buildConflictCopyPath("notes/README", "Laptop", new Date("2026-01-02T03:04:00"));
  assert.equal(path, "notes/README (Conflicted copy Laptop 202601020304)");
});

test("isConflictCopyPath detects official and legacy conflict copies", () => {
  assert.equal(isConflictCopyPath("notes/a (Conflicted copy MacBook 202604141545).md"), true);
  assert.equal(isConflictCopyPath("notes/a.conflict-macbook-2026.md"), true);
  assert.equal(isConflictCopyPath("notes/a.md"), false);
});
