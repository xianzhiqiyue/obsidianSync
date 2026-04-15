import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as loadEnv } from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appRoot = path.resolve(__dirname, "..");

for (const envFile of [path.join(appRoot, ".env.test"), path.join(appRoot, ".env")]) {
  if (existsSync(envFile)) {
    loadEnv({ path: envFile, override: false });
  }
}

process.env.APP_ENV ??= "test";
process.env.JWT_SECRET ??= "test-jwt-secret-change-me-32chars";
process.env.S3_ENDPOINT ??= "http://127.0.0.1:9000";
process.env.S3_BUCKET ??= "obsidian-sync-test";
process.env.S3_ACCESS_KEY ??= "minioadmin";
process.env.S3_SECRET_KEY ??= "minioadmin";

if (!process.env.POSTGRES_DSN) {
  console.log("SKIP sync-api integration tests: POSTGRES_DSN is not set. Copy apps/sync-api/.env.test.example to .env.test or export POSTGRES_DSN to run them.");
  process.exit(0);
}

const testFiles = collectTestFiles(path.join(appRoot, "src")).map((file) => path.relative(appRoot, file));
if (testFiles.length === 0) {
  console.log("SKIP sync-api integration tests: no test files found.");
  process.exit(0);
}

const child = spawn("tsx", ["--test", ...testFiles], {
  cwd: appRoot,
  stdio: "inherit",
  env: process.env
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`sync-api tests terminated by ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});

function collectTestFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTestFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(fullPath);
    }
  }
  return files.sort();
}
