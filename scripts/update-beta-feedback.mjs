#!/usr/bin/env node
import { access, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const env = process.env;
const releaseTag = (env.RELEASE_TAG ?? "").trim();
const wave = (env.WAVE ?? "wave1").trim();
const feedbackRoot = (env.FEEDBACK_ROOT ?? "reports/beta-feedback").trim();
const feedbackId = (env.FEEDBACK_ID ?? "").trim();
const feedbackFileInput = (env.FEEDBACK_FILE ?? "").trim();
const nextStatus = (env.STATUS ?? "").trim();
const nextSeverity = (env.SEVERITY ?? "").trim();
const nextType = (env.ISSUE_TYPE ?? "").trim();
const ownerInput = (env.OWNER ?? "").trim();
const linkedTaskInput = (env.LINKED_TASK ?? "").trim();
const conclusionInput = (env.CONCLUSION ?? "").trim();
const noteInput = (env.NOTE ?? "").trim();
const dryRun = (env.DRY_RUN ?? "0") === "1";

if (!releaseTag) {
  console.error("RELEASE_TAG is required");
  process.exit(1);
}

if (!feedbackId && !feedbackFileInput) {
  console.error("either FEEDBACK_ID or FEEDBACK_FILE is required");
  process.exit(1);
}

if (!nextStatus && !nextSeverity && !nextType && !ownerInput && !linkedTaskInput && !conclusionInput && !noteInput) {
  console.error("at least one update field is required: STATUS/SEVERITY/ISSUE_TYPE/OWNER/LINKED_TASK/CONCLUSION/NOTE");
  process.exit(1);
}

if (nextSeverity && !["P0", "P1", "P2", "P3"].includes(nextSeverity)) {
  console.error(`invalid SEVERITY: ${nextSeverity} (expected P0|P1|P2|P3)`);
  process.exit(1);
}

const waveDir = path.join(feedbackRoot, releaseTag, wave);

const fileExists = async (p) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

const parseFrontMatter = (text) => {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { meta: {}, body: normalized };
  }
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) {
    return { meta: {}, body: normalized };
  }
  const bodyStart = normalized[end + 4] === "\n" ? end + 5 : end + 4;
  const frontMatter = normalized.slice(4, end).trim();
  const body = normalized.slice(bodyStart);
  const meta = {};
  for (const line of frontMatter.split("\n")) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    meta[key] = value;
  }
  return { meta, body };
};

const serializeFrontMatter = (meta) => {
  const preferredOrder = [
    "id",
    "releaseTag",
    "wave",
    "severity",
    "status",
    "type",
    "reporter",
    "platform",
    "pluginVersion",
    "apiVersion",
    "createdAt",
    "updatedAt"
  ];
  const seen = new Set();
  const lines = [];

  for (const key of preferredOrder) {
    if (Object.prototype.hasOwnProperty.call(meta, key)) {
      lines.push(`${key}: ${meta[key]}`);
      seen.add(key);
    }
  }

  const rest = Object.keys(meta)
    .filter((k) => !seen.has(k))
    .sort((a, b) => a.localeCompare(b));
  for (const key of rest) {
    lines.push(`${key}: ${meta[key]}`);
  }
  return lines.join("\n");
};

const findFeedbackFileById = async (dir, id) => {
  let files = [];
  try {
    files = await readdir(dir);
  } catch {
    return "";
  }
  for (const name of files) {
    if (!name.endsWith(".md")) continue;
    if (["summary.md", "daily-log.md", "README.md"].includes(name)) continue;
    const fullPath = path.join(dir, name);
    const text = await readFile(fullPath, "utf8");
    const { meta } = parseFrontMatter(text);
    if ((meta.id ?? "").trim() === id) {
      return fullPath;
    }
  }
  return "";
};

const resolveFeedbackFile = async () => {
  if (feedbackFileInput) {
    const candidates = path.isAbsolute(feedbackFileInput)
      ? [feedbackFileInput]
      : [path.join(waveDir, feedbackFileInput), feedbackFileInput];
    for (const candidate of candidates) {
      if (await fileExists(candidate)) {
        return path.resolve(candidate);
      }
    }
    return "";
  }
  return findFeedbackFileById(waveDir, feedbackId);
};

const extractCoreValue = (lines, regex) => {
  const line = lines.find((item) => regex.test(item));
  if (!line) return "";
  const idx = line.indexOf("：");
  if (idx === -1) return "";
  return line.slice(idx + 1).trim();
};

const updateProcessSection = (body, options) => {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  let start = lines.findIndex((line) => /^##\s*处理记录\s*$/.test(line.trim()));
  let end = -1;
  if (start !== -1) {
    end = lines.findIndex((line, idx) => idx > start && /^##\s+/.test(line.trim()));
    if (end === -1) end = lines.length;
  }

  const ownerPattern = /^-\s*受理人：/;
  const statusPattern = /^-\s*状态：/;
  const linkPattern = /^-\s*关联任务\/提交：/;
  const conclusionPattern = /^-\s*结论：/;
  const corePatterns = [ownerPattern, statusPattern, linkPattern, conclusionPattern];

  let previousSectionLines = [];
  if (start !== -1) {
    previousSectionLines = lines.slice(start + 1, end);
  }

  const owner = options.owner || extractCoreValue(previousSectionLines, ownerPattern) || "";
  const status = options.status || extractCoreValue(previousSectionLines, statusPattern) || options.defaultStatus || "待确认";
  const linkedTask = options.linkedTask || extractCoreValue(previousSectionLines, linkPattern) || "";
  const conclusion = options.conclusion || extractCoreValue(previousSectionLines, conclusionPattern) || "";

  const extras = previousSectionLines.filter((line) => {
    if (!line.trim()) return false;
    return !corePatterns.some((pattern) => pattern.test(line));
  });
  if (options.historyLine) {
    extras.push(options.historyLine);
  }

  const rebuilt = [
    "## 处理记录",
    `- 受理人：${owner}`,
    `- 状态：${status}`,
    `- 关联任务/提交：${linkedTask}`,
    `- 结论：${conclusion}`
  ];
  if (extras.length > 0) {
    rebuilt.push(...extras);
  }

  let nextLines = [];
  if (start === -1) {
    const trimmed = lines.join("\n").trimEnd();
    nextLines = trimmed ? [...trimmed.split("\n"), "", ...rebuilt] : rebuilt;
  } else {
    nextLines = [...lines.slice(0, start), ...rebuilt, ...lines.slice(end)];
  }

  return {
    body: `${nextLines.join("\n").trimEnd()}\n`,
    section: { owner, status, linkedTask, conclusion }
  };
};

const targetFile = await resolveFeedbackFile();
if (!targetFile) {
  console.error("feedback file not found");
  process.exit(1);
}

const text = await readFile(targetFile, "utf8");
const { meta, body } = parseFrontMatter(text);

if (!meta.id) {
  console.error(`feedback file missing id in front matter: ${targetFile}`);
  process.exit(1);
}

if (feedbackId && meta.id !== feedbackId) {
  console.error(`feedback id mismatch: expected ${feedbackId}, got ${meta.id}`);
  process.exit(1);
}

const oldStatus = meta.status ?? "";
const oldSeverity = meta.severity ?? "";
const oldType = meta.type ?? "";

if (nextStatus) {
  meta.status = nextStatus;
}
if (nextSeverity) {
  meta.severity = nextSeverity;
}
if (nextType) {
  meta.type = nextType;
}
meta.updatedAt = new Date().toISOString();

const historyParts = [];
if (nextStatus && nextStatus !== oldStatus) {
  historyParts.push(`状态 ${oldStatus || "unknown"} -> ${nextStatus}`);
}
if (nextSeverity && nextSeverity !== oldSeverity) {
  historyParts.push(`严重级别 ${oldSeverity || "unknown"} -> ${nextSeverity}`);
}
if (nextType && nextType !== oldType) {
  historyParts.push(`类型 ${oldType || "unknown"} -> ${nextType}`);
}
if (ownerInput) {
  historyParts.push(`受理人 ${ownerInput}`);
}
if (linkedTaskInput) {
  historyParts.push(`关联任务 ${linkedTaskInput}`);
}
if (conclusionInput) {
  historyParts.push(`结论 ${conclusionInput}`);
}
if (noteInput) {
  historyParts.push(`备注 ${noteInput}`);
}
if (historyParts.length === 0) {
  historyParts.push("手动更新");
}

const historyLine = `- 更新：${new Date().toISOString()} ${historyParts.join("；")}`;
const updatedSection = updateProcessSection(body, {
  owner: ownerInput,
  status: nextStatus || meta.status || "",
  linkedTask: linkedTaskInput,
  conclusion: conclusionInput,
  defaultStatus: meta.status || "",
  historyLine
});

const finalText = `---\n${serializeFrontMatter(meta)}\n---\n\n${updatedSection.body}`;

if (!dryRun) {
  await writeFile(targetFile, finalText, "utf8");
}

console.log(`BETA_FEEDBACK_UPDATE_FILE=${targetFile}`);
console.log(`BETA_FEEDBACK_UPDATE_ID=${meta.id}`);
console.log(`BETA_FEEDBACK_OLD_STATUS=${oldStatus}`);
console.log(`BETA_FEEDBACK_NEW_STATUS=${meta.status ?? ""}`);
console.log(`BETA_FEEDBACK_OLD_SEVERITY=${oldSeverity}`);
console.log(`BETA_FEEDBACK_NEW_SEVERITY=${meta.severity ?? ""}`);
console.log(`BETA_FEEDBACK_OLD_TYPE=${oldType}`);
console.log(`BETA_FEEDBACK_NEW_TYPE=${meta.type ?? ""}`);
console.log(`BETA_FEEDBACK_OWNER=${updatedSection.section.owner}`);
console.log(`BETA_FEEDBACK_LINKED_TASK=${updatedSection.section.linkedTask}`);
console.log(`BETA_FEEDBACK_CONCLUSION=${updatedSection.section.conclusion}`);
if (dryRun) {
  console.log("BETA_FEEDBACK_DRY_RUN=1");
}
