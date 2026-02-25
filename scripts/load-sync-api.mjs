#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

const toNumber = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const toPositiveInt = (value, fallback) => {
  const n = Math.trunc(toNumber(value, fallback));
  return n > 0 ? n : fallback;
};

const toNonNegativeInt = (value, fallback) => {
  const n = Math.trunc(toNumber(value, fallback));
  return n >= 0 ? n : fallback;
};

const toRate = (value, fallback) => {
  const n = toNumber(value, fallback);
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
};

const parseCheckpoint = (value) => {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  if (typeof value !== "string") {
    return null;
  }
  const match = /^cp_(\d+)$/.exec(value.trim());
  if (!match) {
    return null;
  }
  return Number(match[1]);
};

const percentile = (values, p) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
};

const average = (values) => {
  if (values.length === 0) return 0;
  const sum = values.reduce((acc, v) => acc + v, 0);
  return sum / values.length;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

const nowTag = () => {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}T${hh}${mi}${ss}Z`;
};

const env = process.env;
const config = {
  baseUrl: (env.BASE_URL ?? "http://localhost:3000/api/v1").replace(/\/$/, ""),
  email: env.EMAIL ?? "admin@example.com",
  password: env.PASSWORD ?? "admin123456",
  scenario: env.SCENARIO ?? "concurrency-baseline",
  users: toPositiveInt(env.USERS, 10),
  durationSec: toPositiveInt(env.DURATION_SEC, 60),
  iterationsPerUser: toNonNegativeInt(env.ITERATIONS_PER_USER, 0),
  thinkTimeMs: toNonNegativeInt(env.THINK_TIME_MS, 150),
  requestTimeoutMs: toPositiveInt(env.REQUEST_TIMEOUT_MS, 15000),
  retryMax: toNonNegativeInt(env.RETRY_MAX, 2),
  retryBackoffMs: toNonNegativeInt(env.RETRY_BACKOFF_MS, 200),
  weakMode: (env.WEAK_MODE ?? "0") === "1",
  weakDelayMinMs: toNonNegativeInt(env.WEAK_DELAY_MIN_MS, 300),
  weakDelayMaxMs: toNonNegativeInt(env.WEAK_DELAY_MAX_MS, 800),
  weakTimeoutRate: toRate(env.WEAK_TIMEOUT_RATE ?? "0.2", 0.2),
  weakDropRate: toRate(env.WEAK_DROP_RATE ?? "0.05", 0.05),
  weakTimeoutFactor: toRate(env.WEAK_TIMEOUT_FACTOR ?? "0.2", 0.2),
  reportDir: env.REPORT_DIR ?? "reports/perf",
  reportFile: env.REPORT_FILE ?? "",
  maxOverallErrorRate: toRate(env.MAX_OVERALL_ERROR_RATE ?? "1", 1),
  maxCommitErrorRate: toRate(env.MAX_COMMIT_ERROR_RATE ?? "1", 1)
};

if (config.weakDelayMaxMs < config.weakDelayMinMs) {
  throw new Error(`invalid weak delay range: min=${config.weakDelayMinMs} max=${config.weakDelayMaxMs}`);
}

if (config.durationSec <= 0 && config.iterationsPerUser <= 0) {
  throw new Error("either DURATION_SEC > 0 or ITERATIONS_PER_USER > 0 is required");
}

const reportFile = config.reportFile || path.join(config.reportDir, `${nowTag()}-${config.scenario}.json`);

const operationStats = new Map();
const globalCounters = {
  retries: 0,
  simulatedDrops: 0,
  networkErrors: 0,
  timeouts: 0,
  prepareConflicts: 0,
  commitConflicts: 0,
  uploadedObjects: 0,
  uploadedBytes: 0
};

const workerStats = Array.from({ length: config.users }, (_, idx) => ({
  workerId: idx + 1,
  iterations: 0,
  fatal: null,
  lastCheckpoint: 0,
  vaultId: ""
}));

const ensureOperation = (op) => {
  let stat = operationStats.get(op);
  if (!stat) {
    stat = {
      total: 0,
      success: 0,
      failed: 0,
      latenciesMs: [],
      statusCounts: {},
      retries: 0
    };
    operationStats.set(op, stat);
  }
  return stat;
};

const recordOperation = ({ op, success, latencyMs, statusLabel, retries }) => {
  const stat = ensureOperation(op);
  stat.total += 1;
  stat.latenciesMs.push(latencyMs);
  stat.retries += retries;
  if (success) {
    stat.success += 1;
  } else {
    stat.failed += 1;
  }
  stat.statusCounts[statusLabel] = (stat.statusCounts[statusLabel] ?? 0) + 1;
};

const randomIntBetween = (min, max) => {
  if (max <= min) return min;
  return Math.floor(Math.random() * (max - min + 1)) + min;
};

const shouldInjectWeakDrop = () => config.weakMode && Math.random() < config.weakDropRate;
const shouldInjectWeakTimeout = () => config.weakMode && Math.random() < config.weakTimeoutRate;

const maybeWeakDelay = async () => {
  if (!config.weakMode) return;
  const delayMs = randomIntBetween(config.weakDelayMinMs, config.weakDelayMaxMs);
  await sleep(delayMs);
};

const makeUrl = (uri) => (uri.startsWith("http://") || uri.startsWith("https://") ? uri : `${config.baseUrl}${uri}`);

const request = async ({
  op,
  method,
  uri,
  token,
  body,
  headers,
  parseJson = true,
  expectStatus = null
}) => {
  let lastError = null;
  for (let attempt = 1; attempt <= config.retryMax + 1; attempt += 1) {
    const startedAt = performance.now();
    try {
      await maybeWeakDelay();

      if (shouldInjectWeakDrop()) {
        globalCounters.simulatedDrops += 1;
        throw new Error("simulated_network_drop");
      }

      const controller = new AbortController();
      let timeoutMs = config.requestTimeoutMs;
      if (shouldInjectWeakTimeout()) {
        timeoutMs = Math.max(150, Math.floor(config.requestTimeoutMs * config.weakTimeoutFactor));
      }

      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      const requestHeaders = {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(headers ?? {})
      };

      const response = await fetch(makeUrl(uri), {
        method,
        headers: requestHeaders,
        body: body !== undefined ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      const latencyMs = performance.now() - startedAt;
      const text = await response.text();
      let json = null;
      if (parseJson && text.length > 0) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }

      const statusLabel = String(response.status);
      const retries = attempt - 1;
      const isRetryableStatus = response.status >= 500 || response.status === 429 || response.status === 408;
      const isExpected = expectStatus === null ? response.ok : response.status === expectStatus;

      if (!isExpected && isRetryableStatus && attempt <= config.retryMax) {
        globalCounters.retries += 1;
        await sleep(config.retryBackoffMs * attempt);
        continue;
      }

      recordOperation({ op, success: isExpected, latencyMs, statusLabel, retries });
      return {
        ok: isExpected,
        status: response.status,
        json,
        text,
        latencyMs,
        retries,
        attempt
      };
    } catch (error) {
      const latencyMs = performance.now() - startedAt;
      const isTimeout = error instanceof Error && error.name === "AbortError";
      const statusLabel = isTimeout ? "ERR_TIMEOUT" : "ERR_NETWORK";

      if (isTimeout) {
        globalCounters.timeouts += 1;
      }
      globalCounters.networkErrors += 1;
      lastError = error;

      if (attempt <= config.retryMax) {
        globalCounters.retries += 1;
        await sleep(config.retryBackoffMs * attempt);
        continue;
      }

      recordOperation({ op, success: false, latencyMs, statusLabel, retries: attempt - 1 });
      return {
        ok: false,
        status: 0,
        json: null,
        text: "",
        latencyMs,
        retries: attempt - 1,
        attempt,
        error: lastError instanceof Error ? lastError.message : String(lastError)
      };
    }
  }

  return {
    ok: false,
    status: 0,
    json: null,
    text: "",
    latencyMs: 0,
    retries: config.retryMax,
    attempt: config.retryMax + 1,
    error: lastError instanceof Error ? lastError.message : "request failed"
  };
};

const uploadObject = async ({ uploadUrl, content }) => {
  let lastError = null;
  for (let attempt = 1; attempt <= config.retryMax + 1; attempt += 1) {
    const startedAt = performance.now();
    try {
      await maybeWeakDelay();
      if (shouldInjectWeakDrop()) {
        globalCounters.simulatedDrops += 1;
        throw new Error("simulated_network_drop");
      }

      const controller = new AbortController();
      let timeoutMs = config.requestTimeoutMs;
      if (shouldInjectWeakTimeout()) {
        timeoutMs = Math.max(150, Math.floor(config.requestTimeoutMs * config.weakTimeoutFactor));
      }
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(uploadUrl, {
        method: "PUT",
        body: content,
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      const latencyMs = performance.now() - startedAt;
      const statusLabel = String(response.status);
      const retries = attempt - 1;
      const isRetryableStatus = response.status >= 500 || response.status === 429 || response.status === 408;

      if (!response.ok && isRetryableStatus && attempt <= config.retryMax) {
        globalCounters.retries += 1;
        await sleep(config.retryBackoffMs * attempt);
        continue;
      }

      recordOperation({ op: "object.upload", success: response.ok, latencyMs, statusLabel, retries });
      if (response.ok) {
        globalCounters.uploadedObjects += 1;
        globalCounters.uploadedBytes += Buffer.byteLength(content);
      }
      return {
        ok: response.ok,
        status: response.status,
        retries,
        latencyMs
      };
    } catch (error) {
      const latencyMs = performance.now() - startedAt;
      const isTimeout = error instanceof Error && error.name === "AbortError";
      const statusLabel = isTimeout ? "ERR_TIMEOUT" : "ERR_NETWORK";
      if (isTimeout) {
        globalCounters.timeouts += 1;
      }
      globalCounters.networkErrors += 1;
      lastError = error;

      if (attempt <= config.retryMax) {
        globalCounters.retries += 1;
        await sleep(config.retryBackoffMs * attempt);
        continue;
      }

      recordOperation({ op: "object.upload", success: false, latencyMs, statusLabel, retries: attempt - 1 });
      return {
        ok: false,
        status: 0,
        retries: attempt - 1,
        latencyMs,
        error: lastError instanceof Error ? lastError.message : String(lastError)
      };
    }
  }

  return {
    ok: false,
    status: 0,
    retries: config.retryMax,
    latencyMs: 0,
    error: lastError instanceof Error ? lastError.message : "upload failed"
  };
};

const runWorker = async (workerIndex) => {
  const workerId = workerIndex + 1;
  const worker = workerStats[workerIndex];

  const loginResp = await request({
    op: "auth.login",
    method: "POST",
    uri: "/auth/login",
    body: {
      email: config.email,
      password: config.password,
      deviceName: `load-${config.scenario}-w${workerId}`,
      platform: "macos",
      pluginVersion: "0.1.0"
    }
  });

  if (!loginResp.ok || !loginResp.json?.accessToken) {
    worker.fatal = `login failed (status=${loginResp.status})`;
    return;
  }
  const token = loginResp.json.accessToken;

  const vaultResp = await request({
    op: "vault.create",
    method: "POST",
    uri: "/vaults",
    token,
    body: {
      name: `LoadVault-${config.scenario}-w${workerId}-${nowTag()}`
    },
    expectStatus: 201
  });

  const vaultId = vaultResp.json?.vaultId;
  if (!vaultResp.ok || !vaultId) {
    worker.fatal = `create vault failed (status=${vaultResp.status})`;
    return;
  }
  worker.vaultId = vaultId;

  const stateResp = await request({
    op: "sync.state",
    method: "GET",
    uri: `/vaults/${vaultId}/sync/state`,
    token
  });

  const initialCheckpoint = parseCheckpoint(stateResp.json?.checkpoint) ?? 0;
  if (!stateResp.ok) {
    worker.fatal = `sync state failed (status=${stateResp.status})`;
    return;
  }

  let checkpoint = initialCheckpoint;
  const stopAt = Date.now() + config.durationSec * 1000;

  for (let iter = 1; ; iter += 1) {
    if (config.iterationsPerUser > 0 && iter > config.iterationsPerUser) {
      break;
    }
    if (config.iterationsPerUser === 0 && Date.now() >= stopAt) {
      break;
    }

    const cpBefore = checkpoint;
    const contentHash = `sha256:load-${randomUUID()}`;
    const filePath = `load/w${workerId}/note-${iter}.md`;

    const prepareResp = await request({
      op: "sync.prepare",
      method: "POST",
      uri: `/vaults/${vaultId}/sync/prepare`,
      token,
      body: {
        baseCheckpoint: checkpoint,
        changes: [
          {
            op: "create",
            path: filePath,
            contentHash
          }
        ]
      }
    });

    if (!prepareResp.ok) {
      if (prepareResp.status === 409) {
        globalCounters.prepareConflicts += 1;
      }
      await sleep(config.thinkTimeMs);
      continue;
    }

    const conflicts = Array.isArray(prepareResp.json?.conflicts) ? prepareResp.json.conflicts : [];
    if (conflicts.length > 0) {
      globalCounters.prepareConflicts += conflicts.length;
      await sleep(config.thinkTimeMs);
      continue;
    }

    const uploadTargets = Array.isArray(prepareResp.json?.uploadTargets) ? prepareResp.json.uploadTargets : [];
    let uploadFailed = false;
    for (const target of uploadTargets) {
      const uploadResp = await uploadObject({
        uploadUrl: target.uploadUrl,
        content: `load-content worker=${workerId} iter=${iter} hash=${contentHash}`
      });
      if (!uploadResp.ok) {
        uploadFailed = true;
        break;
      }
    }
    if (uploadFailed) {
      await sleep(config.thinkTimeMs);
      continue;
    }

    const commitResp = await request({
      op: "sync.commit",
      method: "POST",
      uri: `/vaults/${vaultId}/sync/commit`,
      token,
      body: {
        prepareId: prepareResp.json?.prepareId,
        idempotencyKey: randomUUID()
      }
    });

    if (!commitResp.ok) {
      if (commitResp.status === 409) {
        globalCounters.commitConflicts += 1;
      }
      await sleep(config.thinkTimeMs);
      continue;
    }

    const commitCheckpoint = parseCheckpoint(commitResp.json?.newCheckpoint);
    if (commitCheckpoint !== null) {
      checkpoint = commitCheckpoint;
    } else {
      checkpoint += 1;
    }

    const pullResp = await request({
      op: "sync.pull",
      method: "GET",
      uri: `/vaults/${vaultId}/sync/pull?fromCheckpoint=${cpBefore}&limit=200`,
      token
    });

    if (pullResp.ok) {
      const toCheckpoint = parseCheckpoint(pullResp.json?.toCheckpoint);
      if (toCheckpoint !== null) {
        checkpoint = Math.max(checkpoint, toCheckpoint);
      }
    }

    worker.iterations += 1;
    worker.lastCheckpoint = checkpoint;
    await sleep(config.thinkTimeMs);
  }
};

const startedAt = new Date();

const preflight = await request({
  op: "system.health",
  method: "GET",
  uri: "/health"
});
if (!preflight.ok) {
  console.error(`health check failed: status=${preflight.status} error=${preflight.error ?? "unknown"}`);
  process.exit(1);
}

await Promise.all(workerStats.map((_, idx) => runWorker(idx)));

const endedAt = new Date();
const durationSec = (endedAt.getTime() - startedAt.getTime()) / 1000;

const operations = {};
let totalOps = 0;
let totalFailedOps = 0;
for (const [op, stat] of operationStats.entries()) {
  const opErrorRate = stat.total === 0 ? 0 : stat.failed / stat.total;
  operations[op] = {
    total: stat.total,
    success: stat.success,
    failed: stat.failed,
    errorRate: Number(opErrorRate.toFixed(6)),
    avgLatencyMs: Number(average(stat.latenciesMs).toFixed(2)),
    p50LatencyMs: Number(percentile(stat.latenciesMs, 50).toFixed(2)),
    p95LatencyMs: Number(percentile(stat.latenciesMs, 95).toFixed(2)),
    p99LatencyMs: Number(percentile(stat.latenciesMs, 99).toFixed(2)),
    retries: stat.retries,
    statusCounts: stat.statusCounts
  };
  totalOps += stat.total;
  totalFailedOps += stat.failed;
}

const commitStats = operations["sync.commit"] ?? {
  total: 0,
  success: 0,
  failed: 0,
  errorRate: 0,
  avgLatencyMs: 0,
  p50LatencyMs: 0,
  p95LatencyMs: 0,
  p99LatencyMs: 0,
  retries: 0,
  statusCounts: {}
};

const overallErrorRate = totalOps === 0 ? 0 : totalFailedOps / totalOps;
const commitErrorRate = commitStats.total === 0 ? 0 : commitStats.failed / commitStats.total;
const activeWorkers = workerStats.filter((w) => !w.fatal).length;

const checks = {
  maxOverallErrorRate: config.maxOverallErrorRate,
  maxCommitErrorRate: config.maxCommitErrorRate,
  overallErrorRate: Number(overallErrorRate.toFixed(6)),
  commitErrorRate: Number(commitErrorRate.toFixed(6)),
  passed:
    overallErrorRate <= config.maxOverallErrorRate &&
    commitErrorRate <= config.maxCommitErrorRate &&
    activeWorkers > 0
};

const report = {
  scenario: config.scenario,
  config,
  startedAt: startedAt.toISOString(),
  endedAt: endedAt.toISOString(),
  durationSec: Number(durationSec.toFixed(3)),
  workers: {
    requested: config.users,
    active: activeWorkers,
    failedBootstrap: workerStats.filter((w) => w.fatal).length
  },
  totals: {
    operations: totalOps,
    failedOperations: totalFailedOps,
    overallErrorRate: Number(overallErrorRate.toFixed(6)),
    rps: durationSec > 0 ? Number((totalOps / durationSec).toFixed(3)) : 0,
    commitPerSec: durationSec > 0 ? Number((commitStats.success / durationSec).toFixed(3)) : 0,
    workerIterations: workerStats.reduce((acc, w) => acc + w.iterations, 0)
  },
  counters: globalCounters,
  operations,
  checks,
  workersDetail: workerStats
};

await mkdir(path.dirname(reportFile), { recursive: true });
await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.log(`SCENARIO=${config.scenario}`);
console.log(`REPORT_FILE=${reportFile}`);
console.log(`TOTAL_OPS=${report.totals.operations}`);
console.log(`OVERALL_ERROR_RATE=${report.totals.overallErrorRate}`);
console.log(`COMMIT_P95_MS=${commitStats.p95LatencyMs}`);
console.log(`COMMIT_ERROR_RATE=${Number(commitErrorRate.toFixed(6))}`);
console.log(`CHECKS_PASSED=${checks.passed ? "1" : "0"}`);

if (!checks.passed) {
  process.exitCode = 1;
}
