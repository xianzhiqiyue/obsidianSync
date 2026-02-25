import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

const toInteger = z.preprocess((value) => Number(value), z.number().int().positive());
const toBoolean = z.preprocess((value) => {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return value;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}, z.boolean());

const EnvSchema = z.object({
  APP_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: toInteger.default(3000),
  BASE_URL: z.string().url().default("https://sync.example.com"),
  CORS_ORIGIN: z.string().default("*"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  POSTGRES_DSN: z.string().min(1, "POSTGRES_DSN is required"),
  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 chars"),
  ACCESS_TOKEN_TTL: toInteger.default(3600),
  REFRESH_TOKEN_TTL_DAYS: toInteger.default(30),
  SYNC_PREPARE_TTL_SECONDS: toInteger.default(600),
  TOMBSTONE_RETENTION_DAYS: toInteger.default(30),
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: toBoolean.default(true),
  SEED_ADMIN_EMAIL: z.string().email().default("admin@example.com"),
  SEED_ADMIN_PASSWORD: z.string().min(8).default("admin123456")
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  const message = parsed.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
  throw new Error(`Invalid environment variables:\n${message}`);
}

export const appConfig = {
  env: parsed.data.APP_ENV,
  host: parsed.data.HOST,
  port: parsed.data.PORT,
  baseUrl: parsed.data.BASE_URL,
  corsOrigin: parsed.data.CORS_ORIGIN,
  logLevel: parsed.data.LOG_LEVEL,
  postgresDsn: parsed.data.POSTGRES_DSN,
  jwtSecret: parsed.data.JWT_SECRET,
  accessTokenTtlSec: parsed.data.ACCESS_TOKEN_TTL,
  refreshTokenTtlDays: parsed.data.REFRESH_TOKEN_TTL_DAYS,
  syncPrepareTtlSec: parsed.data.SYNC_PREPARE_TTL_SECONDS,
  tombstoneRetentionDays: parsed.data.TOMBSTONE_RETENTION_DAYS,
  s3Endpoint: parsed.data.S3_ENDPOINT,
  s3Region: parsed.data.S3_REGION,
  s3Bucket: parsed.data.S3_BUCKET,
  s3AccessKey: parsed.data.S3_ACCESS_KEY,
  s3SecretKey: parsed.data.S3_SECRET_KEY,
  s3ForcePathStyle: parsed.data.S3_FORCE_PATH_STYLE,
  seedAdminEmail: parsed.data.SEED_ADMIN_EMAIL,
  seedAdminPassword: parsed.data.SEED_ADMIN_PASSWORD
};

export type AppConfig = typeof appConfig;
