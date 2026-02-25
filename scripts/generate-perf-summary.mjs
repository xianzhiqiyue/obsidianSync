#!/usr/bin/env node
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
if (args.length < 3 || args[0] !== "--out") {
  console.error("usage: node scripts/generate-perf-summary.mjs --out <summary.md> <report1.json> <report2.json> [...]");
  process.exit(1);
}

const outPath = args[1];
const reportPaths = args.slice(2);

const loadReport = async (filePath) => {
  const content = await readFile(filePath, "utf8");
  return JSON.parse(content);
};

const reports = await Promise.all(reportPaths.map(loadReport));
const generatedAt = new Date().toISOString();

const formatRate = (n) => `${(Number(n) * 100).toFixed(2)}%`;
const formatMs = (n) => `${Number(n ?? 0).toFixed(2)} ms`;

const scenarioRows = reports.map((report, idx) => {
  const commit = report.operations?.["sync.commit"] ?? {
    success: 0,
    total: 0,
    p95LatencyMs: 0,
    errorRate: 0
  };
  const pull = report.operations?.["sync.pull"] ?? {
    p95LatencyMs: 0
  };

  const commitSuccessRate = commit.total > 0 ? commit.success / commit.total : 0;
  return {
    scenario: report.scenario,
    users: report.config?.users ?? 0,
    durationSec: report.durationSec ?? 0,
    totalOps: report.totals?.operations ?? 0,
    overallErrorRate: report.totals?.overallErrorRate ?? 0,
    commitSuccessRate,
    commitP95Ms: commit.p95LatencyMs ?? 0,
    pullP95Ms: pull.p95LatencyMs ?? 0,
    prepareConflicts: report.counters?.prepareConflicts ?? 0,
    passed: report.checks?.passed ? "PASS" : "FAIL",
    reportPath: reportPaths[idx] ?? ""
  };
});

const lines = [];
lines.push("# 压测基线报告");
lines.push("");
lines.push(`生成时间：${generatedAt}`);
lines.push("");
lines.push("## 场景汇总");
lines.push("");
lines.push("| 场景 | 并发用户 | 持续时间(s) | 总请求数 | 总错误率 | commit 成功率 | commit P95 | pull P95 | prepare 冲突数 | 结果 |");
lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const row of scenarioRows) {
  lines.push(
    `| ${row.scenario} | ${row.users} | ${Number(row.durationSec).toFixed(2)} | ${row.totalOps} | ${formatRate(
      row.overallErrorRate
    )} | ${formatRate(row.commitSuccessRate)} | ${formatMs(row.commitP95Ms)} | ${formatMs(row.pullP95Ms)} | ${row.prepareConflicts} | ${row.passed} |`
  );
}

lines.push("");
lines.push("## 判定建议");
lines.push("");
for (const [idx, row] of scenarioRows.entries()) {
  lines.push(`${idx + 1}. ${row.scenario}: ${row.passed}（报告文件：\`${row.reportPath}\`）`);
}

lines.push("");
lines.push("## NFR 对照（P4）");
lines.push("");
lines.push("- 目标：100 文件增量同步 P95 < 5s。可用 commit/pull P95 作为阶段性代理指标。");
lines.push("- 目标：10 设备并发提交错误率 < 1%。可用 `sync.commit` 错误率与总错误率联合判定。");
lines.push("- 说明：该报告为脚本自动跑数，正式验收建议在目标部署环境重复执行并保留 3 轮结果。");

await mkdir(path.dirname(outPath), { recursive: true });
await writeFile(outPath, `${lines.join("\n")}\n`, "utf8");

console.log(`PERF_SUMMARY_FILE=${outPath}`);
