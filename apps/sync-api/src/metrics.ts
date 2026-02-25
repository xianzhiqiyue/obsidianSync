import type { FastifyInstance, FastifyRequest } from "fastify";

type MetricType = "counter" | "histogram";
type LabelValue = string | number | boolean;
type LabelSet = Record<string, LabelValue>;

interface MetricDefinition {
  name: string;
  help: string;
  type: MetricType;
  buckets?: number[];
}

interface CounterSample {
  labels: Record<string, string>;
  value: number;
}

interface HistogramSample {
  labels: Record<string, string>;
  bucketCounts: number[];
  count: number;
  sum: number;
}

declare module "fastify" {
  interface FastifyRequest {
    metricsStartAtNs?: bigint;
  }
}

const DEFAULT_HTTP_DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5];

class MetricsRegistry {
  private readonly definitions = new Map<string, MetricDefinition>();
  private readonly counters = new Map<string, Map<string, CounterSample>>();
  private readonly histograms = new Map<string, Map<string, HistogramSample>>();

  registerCounter(name: string, help: string): void {
    this.ensureDefinition({ name, help, type: "counter" });
    if (!this.counters.has(name)) {
      this.counters.set(name, new Map());
    }
  }

  registerHistogram(name: string, help: string, buckets: number[]): void {
    this.ensureDefinition({ name, help, type: "histogram", buckets: [...buckets].sort((a, b) => a - b) });
    if (!this.histograms.has(name)) {
      this.histograms.set(name, new Map());
    }
  }

  incCounter(name: string, labels: LabelSet = {}, value = 1): void {
    if (value === 0) {
      return;
    }
    const metric = this.counters.get(name);
    if (!metric) {
      throw new Error(`counter metric not registered: ${name}`);
    }
    const normalizedLabels = normalizeLabels(labels);
    const key = labelKey(normalizedLabels);
    const sample = metric.get(key);
    if (sample) {
      sample.value += value;
      return;
    }
    metric.set(key, {
      labels: normalizedLabels,
      value
    });
  }

  observeHistogram(name: string, labels: LabelSet = {}, value: number): void {
    const metric = this.histograms.get(name);
    const definition = this.definitions.get(name);
    if (!metric || !definition || !definition.buckets) {
      throw new Error(`histogram metric not registered: ${name}`);
    }
    const normalizedLabels = normalizeLabels(labels);
    const key = labelKey(normalizedLabels);
    let sample = metric.get(key);
    if (!sample) {
      sample = {
        labels: normalizedLabels,
        bucketCounts: definition.buckets.map(() => 0),
        count: 0,
        sum: 0
      };
      metric.set(key, sample);
    }

    sample.count += 1;
    sample.sum += value;
    for (let idx = 0; idx < definition.buckets.length; idx += 1) {
      if (value <= definition.buckets[idx]!) {
        sample.bucketCounts[idx] = (sample.bucketCounts[idx] ?? 0) + 1;
      }
    }
  }

  renderPrometheus(): string {
    const lines: string[] = [];
    const metricNames = Array.from(this.definitions.keys()).sort();
    for (const metricName of metricNames) {
      const definition = this.definitions.get(metricName)!;
      lines.push(`# HELP ${definition.name} ${definition.help}`);
      lines.push(`# TYPE ${definition.name} ${definition.type}`);

      if (definition.type === "counter") {
        const samples = this.counters.get(metricName);
        if (!samples || samples.size === 0) {
          lines.push(`${definition.name} 0`);
          continue;
        }
        for (const sample of samples.values()) {
          lines.push(`${definition.name}${formatLabels(sample.labels)} ${formatNumber(sample.value)}`);
        }
        continue;
      }

      const buckets = definition.buckets ?? [];
      const samples = this.histograms.get(metricName);
      if (!samples || samples.size === 0) {
        for (const bucket of buckets) {
          lines.push(`${definition.name}_bucket{le="${bucket}"} 0`);
        }
        lines.push(`${definition.name}_bucket{le="+Inf"} 0`);
        lines.push(`${definition.name}_sum 0`);
        lines.push(`${definition.name}_count 0`);
        continue;
      }

      for (const sample of samples.values()) {
        for (let idx = 0; idx < buckets.length; idx += 1) {
          const labels = {
            ...sample.labels,
            le: String(buckets[idx]!)
          };
          lines.push(`${definition.name}_bucket${formatLabels(labels)} ${formatNumber(sample.bucketCounts[idx] ?? 0)}`);
        }
        lines.push(
          `${definition.name}_bucket${formatLabels({ ...sample.labels, le: "+Inf" })} ${formatNumber(sample.count)}`
        );
        lines.push(`${definition.name}_sum${formatLabels(sample.labels)} ${formatNumber(sample.sum)}`);
        lines.push(`${definition.name}_count${formatLabels(sample.labels)} ${formatNumber(sample.count)}`);
      }
    }
    return `${lines.join("\n")}\n`;
  }

  private ensureDefinition(next: MetricDefinition): void {
    const existing = this.definitions.get(next.name);
    if (!existing) {
      this.definitions.set(next.name, next);
      return;
    }
    if (existing.type !== next.type || existing.help !== next.help) {
      throw new Error(`metric definition conflict: ${next.name}`);
    }
  }
}

function normalizeLabels(labels: LabelSet): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    result[key] = String(value);
  }
  return result;
}

function labelKey(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort();
  return keys.map((key) => `${key}=${labels[key]}`).join(",");
}

function formatLabels(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) {
    return "";
  }
  const body = keys
    .map((key) => `${key}="${escapeLabel(labels[key] ?? "")}"`)
    .join(",");
  return `{${body}}`;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) {
    return String(value);
  }
  return value.toFixed(6).replace(/\.?0+$/, "");
}

export const metricsRegistry = new MetricsRegistry();

metricsRegistry.registerCounter("sync_api_http_requests_total", "Total HTTP requests.");
metricsRegistry.registerHistogram(
  "sync_api_http_request_duration_seconds",
  "HTTP request latency in seconds.",
  DEFAULT_HTTP_DURATION_BUCKETS
);
metricsRegistry.registerCounter("sync_api_auth_login_total", "Total auth login attempts by result.");
metricsRegistry.registerCounter("sync_api_auth_refresh_total", "Total auth token refresh attempts by result.");
metricsRegistry.registerCounter("sync_api_sync_prepare_total", "Total sync prepare requests by result.");
metricsRegistry.registerCounter("sync_api_sync_prepare_conflicts_total", "Total sync prepare conflicts returned.");
metricsRegistry.registerCounter("sync_api_sync_commit_total", "Total sync commit requests by result.");
metricsRegistry.registerCounter("sync_api_sync_commit_applied_changes_total", "Total changes applied in successful commits.");
metricsRegistry.registerCounter("sync_api_sync_pull_total", "Total sync pull requests by result.");
metricsRegistry.registerCounter("sync_api_sync_pull_changes_total", "Total changes returned by sync pull.");

function normalizeRoute(request: FastifyRequest): string {
  const route =
    request.routeOptions.url ??
    request.raw.url?.split("?")[0] ??
    request.url.split("?")[0] ??
    "unknown";
  return route;
}

export function registerHttpMetricsHooks(app: FastifyInstance<any, any, any, any, any>): void {
  app.addHook("onRequest", async (request) => {
    request.metricsStartAtNs = process.hrtime.bigint();
  });

  app.addHook("onResponse", async (request, reply) => {
    const start = request.metricsStartAtNs;
    if (!start) {
      return;
    }
    const elapsedNs = process.hrtime.bigint() - start;
    const durationSeconds = Number(elapsedNs) / 1_000_000_000;
    const route = normalizeRoute(request);
    metricsRegistry.incCounter("sync_api_http_requests_total", {
      method: request.method,
      route,
      status: reply.statusCode
    });
    metricsRegistry.observeHistogram(
      "sync_api_http_request_duration_seconds",
      {
        method: request.method,
        route
      },
      durationSeconds
    );
  });
}
