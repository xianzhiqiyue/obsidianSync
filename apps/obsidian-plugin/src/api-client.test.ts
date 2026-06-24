import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeSyncApiBaseUrl } from "./api-client";

describe("normalizeSyncApiBaseUrl", () => {
  it("adds the API prefix when the server root is configured", () => {
    assert.equal(normalizeSyncApiBaseUrl("https://sync.example.com"), "https://sync.example.com/api/v1");
  });

  it("keeps an existing API prefix", () => {
    assert.equal(normalizeSyncApiBaseUrl("https://sync.example.com/api/v1"), "https://sync.example.com/api/v1");
  });

  it("normalizes whitespace and trailing slashes", () => {
    assert.equal(normalizeSyncApiBaseUrl(" https://sync.example.com/api/v1/// "), "https://sync.example.com/api/v1");
  });
});
