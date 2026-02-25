import assert from "node:assert/strict";
import test from "node:test";
import { runWithRetry } from "./sync-retry";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

test("runWithRetry retries retryable errors and then succeeds", async () => {
  let attemptCount = 0;
  const failedMessages: string[] = [];
  const backoff: number[] = [];

  const result = await runWithRetry({
    maxAttempts: 3,
    timeoutMs: 1_000,
    runAttempt: async () => {
      attemptCount += 1;
      if (attemptCount < 3) {
        throw new Error("network down");
      }
    },
    isRetryableError: (error) => message(error).includes("network"),
    toMessage: message,
    sleep: async (ms) => {
      backoff.push(ms);
    },
    onAttemptFailure: async (failure) => {
      failedMessages.push(failure.message);
    }
  });

  assert.equal(result.status, "success");
  assert.equal(attemptCount, 3);
  assert.deepEqual(failedMessages, ["network down", "network down"]);
  assert.deepEqual(backoff, [500, 1000]);
});

test("runWithRetry handles partial upload failure and succeeds on next attempt", async () => {
  let attemptCount = 0;
  const failures: string[] = [];

  const result = await runWithRetry({
    maxAttempts: 3,
    timeoutMs: 1_000,
    runAttempt: async () => {
      attemptCount += 1;
      if (attemptCount === 1) {
        throw new Error("UPLOAD_FAILED (503)");
      }
    },
    isRetryableError: (error) => message(error).includes("UPLOAD_FAILED"),
    toMessage: message,
    sleep: async () => {},
    onAttemptFailure: async (failure) => {
      failures.push(failure.message);
    }
  });

  assert.equal(result.status, "success");
  assert.equal(attemptCount, 2);
  assert.deepEqual(failures, ["UPLOAD_FAILED (503)"]);
});

test("runWithRetry stops immediately for non-retryable error", async () => {
  let attemptCount = 0;
  const failures: string[] = [];

  const result = await runWithRetry({
    maxAttempts: 3,
    timeoutMs: 1_000,
    runAttempt: async () => {
      attemptCount += 1;
      throw new Error("FORBIDDEN");
    },
    isRetryableError: () => false,
    toMessage: message,
    sleep: async () => {
      throw new Error("sleep should not be called");
    },
    onAttemptFailure: async (failure) => {
      failures.push(failure.message);
    }
  });

  assert.equal(result.status, "failed");
  assert.equal(attemptCount, 1);
  assert.deepEqual(failures, ["FORBIDDEN"]);
  assert.equal(result.lastFailure?.retryable, false);
});

test("runWithRetry marks timed out attempt as retryable when policy allows", async () => {
  let attemptCount = 0;
  const timedOutFlags: boolean[] = [];

  const result = await runWithRetry({
    maxAttempts: 2,
    timeoutMs: 20,
    runAttempt: async (signal) => {
      attemptCount += 1;
      if (attemptCount === 1) {
        await new Promise<void>((_, reject) => {
          signal.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
        return;
      }
    },
    isRetryableError: (error) => message(error).includes("timed out"),
    toMessage: message,
    sleep: async () => {},
    onAttemptFailure: async (failure) => {
      timedOutFlags.push(failure.timedOut);
    }
  });

  assert.equal(result.status, "success");
  assert.equal(attemptCount, 2);
  assert.deepEqual(timedOutFlags, [true]);
});
