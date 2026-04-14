import assert from "node:assert/strict";
import test from "node:test";
import { mergeJsonText } from "./json-merge";

test("mergeJsonText overlays local keys on remote JSON", () => {
  const result = mergeJsonText('{"theme":"old"}', '{"theme":"local","newKey":true}', '{"theme":"remote","remoteOnly":1}');
  assert.equal(result.clean, true);
  assert.deepEqual(JSON.parse(result.merged), {
    theme: "local",
    remoteOnly: 1,
    newKey: true
  });
});

test("mergeJsonText deep merges nested plain objects", () => {
  const result = mergeJsonText("{}", '{"plugin":{"enabled":true}}', '{"plugin":{"remote":1},"x":2}');
  assert.equal(result.clean, true);
  assert.deepEqual(JSON.parse(result.merged), {
    plugin: {
      remote: 1,
      enabled: true
    },
    x: 2
  });
});

test("mergeJsonText rejects arrays and invalid JSON", () => {
  assert.equal(mergeJsonText("{}", "[]", "{}").clean, false);
  assert.equal(mergeJsonText("{}", "not-json", "{}").clean, false);
});
