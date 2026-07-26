import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { Config } from "../config.ts";
import type { PlanObject, PlanStorage } from "../services/types.ts";
import { planObjectKey } from "./object-key.ts";

const CONTENT_TYPE = "text/html; charset=utf-8";

// The `plans/` mapping and the id shapes it refuses live in
// ./object-key.ts, shared with the R2 driver.

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("name" in error && error.name === "NoSuchKey") return true;
  if ("$metadata" in error) {
    const metadata = error.$metadata;
    if (
      typeof metadata === "object" &&
      metadata !== null &&
      "httpStatusCode" in metadata &&
      metadata.httpStatusCode === 404
    ) {
      return true;
    }
  }
  return false;
}

/**
 * `credentials` is omitted entirely unless BOTH keys were explicitly
 * configured. Omitting it is what lets the SDK resolve env vars, shared config,
 * SSO, web identity (EKS IRSA), ECS/EKS task roles, and EC2 IMDS in its
 * documented order. Never default credentials in code.
 */
function makeClient(config: Config): S3Client {
  return new S3Client({
    region: config.s3Region,
    ...(config.s3Endpoint !== undefined
      ? {
          endpoint: config.s3Endpoint,
          forcePathStyle: config.s3ForcePathStyle,
        }
      : {}),
    ...(config.s3AccessKeyId !== undefined &&
    config.s3SecretAccessKey !== undefined
      ? {
          credentials: {
            accessKeyId: config.s3AccessKeyId,
            secretAccessKey: config.s3SecretAccessKey,
          },
        }
      : {}),
  });
}

export function createS3Storage(config: Config): PlanStorage {
  const bucket = config.s3Bucket;
  if (bucket === undefined) {
    throw new Error("S3_BUCKET is required when STORAGE_DRIVER=s3");
  }
  const client = makeClient(config);

  return {
    async put(id, body) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: planObjectKey(id),
          Body: body,
          ContentType: CONTENT_TYPE,
          ContentLength: body.byteLength,
        }),
      );
    },

    async get(id): Promise<PlanObject | null> {
      try {
        const response = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: planObjectKey(id) }),
        );
        if (response.Body === undefined) return null;
        return {
          // The SDK returns a web ReadableStream on both Node 18+ and Workers.
          body: response.Body.transformToWebStream(),
          size: response.ContentLength ?? 0,
          etag: response.ETag ?? "",
        };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    async delete(id) {
      // S3 deletes are idempotent: a missing key is a success.
      await client.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: planObjectKey(id) }),
      );
    },

    async probe() {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
    },
  };
}
