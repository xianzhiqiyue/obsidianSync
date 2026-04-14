import assert from "node:assert/strict";
import test from "node:test";
import { mergeMarkdownText } from "./markdown-merge";

test("mergeMarkdownText accepts identical local and remote", () => {
  assert.deepEqual(mergeMarkdownText("a", "b", "b"), { merged: "b", clean: true });
});

test("mergeMarkdownText keeps remote when local did not change", () => {
  assert.deepEqual(mergeMarkdownText("base", "base", "remote"), { merged: "remote", clean: true });
});

test("mergeMarkdownText keeps local when remote did not change", () => {
  assert.deepEqual(mergeMarkdownText("base", "local", "base"), { merged: "local", clean: true });
});

test("mergeMarkdownText combines independent appends using diff-match-patch", () => {
  assert.deepEqual(mergeMarkdownText("# Note\n", "# Note\nlocal\n", "# Note\nremote\n"), {
    merged: "# Note\nremote\nlocal\n",
    clean: true
  });
});

test("mergeMarkdownText applies local edits onto remote context", () => {
  assert.deepEqual(mergeMarkdownText("hello", "HELLO", "hello remote"), {
    merged: "HELLO remote",
    clean: true
  });
});

test("mergeMarkdownText applies fuzzy patches like diff-match-patch", () => {
  assert.deepEqual(mergeMarkdownText("alpha beta gamma", "alpha BETA gamma", "alpha gamma"), {
    merged: "alpha BETAgamma",
    clean: true
  });
});
