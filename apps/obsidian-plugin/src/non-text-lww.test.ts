import assert from "node:assert/strict";
import test from "node:test";
import { decideLastModifiedWins } from "./non-text-lww";

test("decideLastModifiedWins chooses newer non-text side", () => {
  assert.equal(decideLastModifiedWins("attachments/a.png", 2000, 1000), "use_local");
  assert.equal(decideLastModifiedWins("attachments/a.png", 1000, 2000), "use_remote");
  assert.equal(decideLastModifiedWins("attachments/a.png", 1000, 1000), "use_remote");
});

test("decideLastModifiedWins defers text paths and missing metadata", () => {
  assert.equal(decideLastModifiedWins("notes/a.md", 2000, 1000), "defer");
  assert.equal(decideLastModifiedWins(".obsidian/app.json", 2000, 1000), "defer");
  assert.equal(decideLastModifiedWins("attachments/a.pdf", undefined, 1000), "defer");
  assert.equal(decideLastModifiedWins("attachments/a.pdf", 1000, undefined), "defer");
});
