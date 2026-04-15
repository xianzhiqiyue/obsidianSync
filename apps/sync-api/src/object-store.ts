import {
  CreateBucketCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import type { AppConfig } from "./config.js";

export class ObjectStore {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: AppConfig) {
    this.bucket = config.s3Bucket;
    this.client = new S3Client({
      endpoint: config.s3Endpoint,
      region: config.s3Region,
      forcePathStyle: config.s3ForcePathStyle,
      credentials: {
        accessKeyId: config.s3AccessKey,
        secretAccessKey: config.s3SecretKey
      }
    });
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }

  async objectExists(contentHash: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: this.toObjectKey(contentHash)
        })
      );
      return true;
    } catch {
      return false;
    }
  }

  async createUploadUrl(contentHash: string, expiresInSeconds = 900): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.toObjectKey(contentHash)
      }),
      { expiresIn: expiresInSeconds }
    );
  }

  async createDownloadUrl(contentHash: string, expiresInSeconds = 900): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.toObjectKey(contentHash)
      }),
      { expiresIn: expiresInSeconds }
    );
  }

  async healthcheck(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }

  async verifyObjectContentHash(contentHash: string): Promise<boolean> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.toObjectKey(contentHash)
      })
    );
    const bytes = await readResponseBody(response.Body);
    const actualHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    return actualHash === contentHash;
  }

  private toObjectKey(contentHash: string): string {
    return contentHash.replace(":", "/");
  }
}

async function readResponseBody(body: unknown): Promise<Uint8Array> {
  const maybeBody = body as
    | {
        transformToByteArray?: () => Promise<Uint8Array>;
        transformToString?: () => Promise<string>;
      }
    | undefined;
  if (!maybeBody) {
    throw new Error("object response body is empty");
  }
  if (typeof maybeBody.transformToByteArray === "function") {
    return maybeBody.transformToByteArray();
  }
  if (typeof maybeBody.transformToString === "function") {
    return Buffer.from(await maybeBody.transformToString());
  }
  if (isAsyncIterableUint8Array(body)) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of body) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  throw new Error("unsupported object response body");
}

function isAsyncIterableUint8Array(value: unknown): value is AsyncIterable<Uint8Array> {
  return Boolean(value && typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function");
}
