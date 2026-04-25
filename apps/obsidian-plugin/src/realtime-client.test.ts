import assert from "node:assert/strict";
import test from "node:test";
import { parseServerSentEvent } from "./realtime-client";

test("parseServerSentEvent reads event name and multiline data", () => {
  const parsed = parseServerSentEvent('event: checkpoint\ndata: {"a":1}\ndata: {"b":2}');
  assert.equal(parsed.event, "checkpoint");
  assert.equal(parsed.data, '{"a":1}\n{"b":2}');
});

test("parseServerSentEvent defaults to message event", () => {
  const parsed = parseServerSentEvent('data: {"ok":true}');
  assert.equal(parsed.event, "message");
  assert.equal(parsed.data, '{"ok":true}');
});
