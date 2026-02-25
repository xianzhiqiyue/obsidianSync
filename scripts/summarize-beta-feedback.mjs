#!/usr/bin/env node
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const env = process.env;
const releaseTag = env.RELEASE_TAG ?? "";
const wave = env.WAVE ?? "wave1";
const feedbackRoot = env.FEEDBACK_ROOT ?? "reports/beta-feedback";
const failOnOpenHigh = (env.FAIL_ON_OPEN_HIGH ?? "0") === "1";

if (!releaseTag) {
  console.error("RELEASE_TAG is required");
  process.exit(1);
}

const feedbackDir = path.join(feedbackRoot, releaseTag, wave);
const outDir = feedbackDir;
const summaryMd = path.join(outDir, "summary.md");
const summaryJson = path.join(outDir, "summary.json");

const toCountMap = () => new Map();
const addCount = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

const parseFrontMatter = (text) => {
  if (!text.startsWith("---\n")) {
    return {};
  }
  const end = text.indexOf("\n---", 4);
  if (end === -1) {
    return {};
  }
  const body = text.slice(4, end).trim();
  const result = {};
  for (const line of body.split("\n")) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    result[key] = value;
  }
  return result;
};

let files = [];
try {
  files = (await readdir(feedbackDir)).filter(
    (name) => name.endsWith(".md") && !["summary.md"].includes(name)
  );
} catch {
  files = [];
}

const entries = [];
for (const file of files) {
  const fullPath = path.join(feedbackDir, file);
  const text = await readFile(fullPath, "utf8");
  const meta = parseFrontMatter(text);
  if (!meta.id && !meta.severity && !meta.status) {
    continue;
  }
  entries.push({
    file,
    id: meta.id ?? "",
    severity: meta.severity ?? "unknown",
    status: meta.status ?? "unknown",
    type: meta.type ?? "unknown",
    reporter: meta.reporter ?? "unknown",
    title: (text.match(/^#\s+(.+)$/m)?.[1] ?? "").trim()
  });
}

const severityCounts = toCountMap();
const statusCounts = toCountMap();
const typeCounts = toCountMap();
const uniqueReporterSet = new Set();

for (const e of entries) {
  addCount(severityCounts, e.severity);
  addCount(statusCounts, e.status);
  addCount(typeCounts, e.type);
  const reporter = (e.reporter ?? "").trim();
  if (reporter && reporter !== "unknown") {
    uniqueReporterSet.add(reporter);
  }
}

const isClosed = (status) => ["已修复", "无法复现", "已关闭", "closed", "done"].includes(status.toLowerCase());
const openHigh = entries.filter((e) => ["P0", "P1"].includes(e.severity) && !isClosed(e.status));

const summary = {
  releaseTag,
  wave,
  feedbackDir,
  generatedAt: new Date().toISOString(),
  totals: {
    all: entries.length,
    openHigh: openHigh.length,
    uniqueReporters: uniqueReporterSet.size
  },
  counts: {
    severity: Object.fromEntries(severityCounts.entries()),
    status: Object.fromEntries(statusCounts.entries()),
    type: Object.fromEntries(typeCounts.entries())
  },
  openHigh,
  entries
};

await mkdir(outDir, { recursive: true });
await writeFile(summaryJson, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

const lines = [];
lines.push("# 灰度反馈汇总");
lines.push("");
lines.push(`- releaseTag: ${releaseTag}`);
lines.push(`- wave: ${wave}`);
lines.push(`- generatedAt: ${summary.generatedAt}`);
lines.push(`- total feedback: ${entries.length}`);
lines.push(`- open P0/P1: ${openHigh.length}`);
lines.push(`- unique reporters: ${uniqueReporterSet.size}`);
lines.push("");

lines.push("## 严重级别统计");
lines.push("");
lines.push("| severity | count |");
lines.push("| --- | --- |");
for (const [k, v] of Array.from(severityCounts.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
  lines.push(`| ${k} | ${v} |`);
}
if (severityCounts.size === 0) {
  lines.push("| (none) | 0 |");
}
lines.push("");

lines.push("## 状态统计");
lines.push("");
lines.push("| status | count |");
lines.push("| --- | --- |");
for (const [k, v] of Array.from(statusCounts.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
  lines.push(`| ${k} | ${v} |`);
}
if (statusCounts.size === 0) {
  lines.push("| (none) | 0 |");
}
lines.push("");

lines.push("## 未关闭高优先级问题（P0/P1）");
lines.push("");
lines.push("| id | severity | status | title | file |");
lines.push("| --- | --- | --- | --- | --- |");
for (const item of openHigh) {
  lines.push(`| ${item.id} | ${item.severity} | ${item.status} | ${item.title} | ${item.file} |`);
}
if (openHigh.length === 0) {
  lines.push("| (none) | - | - | - | - |");
}

await writeFile(summaryMd, `${lines.join("\n")}\n`, "utf8");

console.log(`BETA_FEEDBACK_DIR=${feedbackDir}`);
console.log(`BETA_FEEDBACK_TOTAL=${entries.length}`);
console.log(`BETA_FEEDBACK_OPEN_HIGH=${openHigh.length}`);
console.log(`BETA_FEEDBACK_UNIQUE_REPORTERS=${uniqueReporterSet.size}`);
console.log(`BETA_FEEDBACK_SUMMARY_MD=${summaryMd}`);
console.log(`BETA_FEEDBACK_SUMMARY_JSON=${summaryJson}`);

if (failOnOpenHigh && openHigh.length > 0) {
  process.exitCode = 1;
}
