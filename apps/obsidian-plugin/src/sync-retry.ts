export interface RetryFailure {
  error: unknown;
  message: string;
  retryable: boolean;
  attempt: number;
  maxAttempts: number;
  timedOut: boolean;
}

export interface RetryOptions {
  maxAttempts: number;
  timeoutMs: number;
  runAttempt: (signal: AbortSignal) => Promise<void>;
  isRetryableError: (error: unknown) => boolean;
  toMessage: (error: unknown) => string;
  sleep: (ms: number) => Promise<void>;
  onAttemptFailure?: (failure: RetryFailure) => Promise<void> | void;
  backoffMs?: (attempt: number) => number;
}

export interface RetryResult {
  status: "success" | "failed";
  attempts: number;
  lastFailure?: RetryFailure;
}

export async function runWithRetry(options: RetryOptions): Promise<RetryResult> {
  let lastFailure: RetryFailure | undefined;
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    const abortController = new AbortController();
    let timedOut = false;
    const timeoutId = globalThis.setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, options.timeoutMs);

    try {
      await options.runAttempt(abortController.signal);
      globalThis.clearTimeout(timeoutId);
      return {
        status: "success",
        attempts: attempt
      };
    } catch (error) {
      globalThis.clearTimeout(timeoutId);
      const normalizedError = timedOut ? new Error(`sync attempt timed out after ${options.timeoutMs}ms`) : error;
      const failure: RetryFailure = {
        error: normalizedError,
        message: options.toMessage(normalizedError),
        retryable: options.isRetryableError(normalizedError),
        attempt,
        maxAttempts: options.maxAttempts,
        timedOut
      };
      lastFailure = failure;
      await options.onAttemptFailure?.(failure);
      if (!failure.retryable || attempt >= options.maxAttempts) {
        break;
      }

      const nextBackoff = options.backoffMs?.(attempt) ?? 500 * 2 ** (attempt - 1);
      await options.sleep(nextBackoff);
    }
  }

  return {
    status: "failed",
    attempts: options.maxAttempts,
    lastFailure
  };
}
