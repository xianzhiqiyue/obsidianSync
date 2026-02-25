import assert from "node:assert/strict";
import test from "node:test";
import { shouldNotifyBlocked, shouldNotifyFailure } from "./sync-notify";

test("shouldNotifyBlocked always notifies for interactive triggers", () => {
  const result = shouldNotifyBlocked({
    interactive: true,
    nowMs: 10_000,
    lastNoticeAtMs: 9_999,
    cooldownMs: 60_000
  });
  assert.equal(result, true);
});

test("shouldNotifyBlocked throttles non-interactive notifications", () => {
  const first = shouldNotifyBlocked({
    interactive: false,
    nowMs: 120_000,
    lastNoticeAtMs: 0,
    cooldownMs: 60_000
  });
  const second = shouldNotifyBlocked({
    interactive: false,
    nowMs: 130_000,
    lastNoticeAtMs: 120_000,
    cooldownMs: 60_000
  });
  assert.equal(first, true);
  assert.equal(second, false);
});

test("shouldNotifyFailure requires threshold for non-interactive triggers", () => {
  const belowThreshold = shouldNotifyFailure({
    interactive: false,
    nowMs: 200_000,
    lastNoticeAtMs: 0,
    cooldownMs: 60_000,
    consecutiveFailures: 2,
    minConsecutiveFailures: 3
  });
  const atThreshold = shouldNotifyFailure({
    interactive: false,
    nowMs: 200_000,
    lastNoticeAtMs: 0,
    cooldownMs: 60_000,
    consecutiveFailures: 3,
    minConsecutiveFailures: 3
  });
  assert.equal(belowThreshold, false);
  assert.equal(atThreshold, true);
});

test("shouldNotifyFailure always notifies for interactive triggers", () => {
  const result = shouldNotifyFailure({
    interactive: true,
    nowMs: 10_000,
    lastNoticeAtMs: 9_999,
    cooldownMs: 300_000,
    consecutiveFailures: 1,
    minConsecutiveFailures: 3
  });
  assert.equal(result, true);
});
