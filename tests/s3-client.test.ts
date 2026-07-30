import { describe, expect, mock, test } from "bun:test";
import * as sdk from "@aws-sdk/client-s3";
import type { Config } from "../src/config.ts";
import { type Arm, armWhileFileRuns } from "./armed-mock.ts";

/**
 * The S3 driver's construction, and how it reads a failure.
 *
 * tests/drivers/plan-storage.s3.test.ts runs the storage contract against a
 * real MinIO and stays the authority on behaviour. What a live bucket cannot
 * reach is here: the credential decision - omitted entirely unless BOTH keys
 * were configured, or the SDK's provider chain (env vars, SSO, IRSA, task
 * roles, IMDS) never runs - and the error shapes a miss arrives in, one of
 * which MinIO never produces.
 *
 * The SDK is stubbed rather than reached. Each command class records the input
 * it was built with, so what is asserted is the request the driver composed.
 */

interface Sent {
  command: string;
  input: Record<string, unknown>;
}

const sent: Sent[] = [];
/**
 * The second argument of each `send`, kept beside `sent` rather than folded
 * into it so the exact-shape assertions on that array stay exact.
 */
const sendOptions: Array<Record<string, unknown> | undefined> = [];
const constructed: Array<Record<string, unknown>> = [];

/** The next `send` outcome, replaced per test. */
let answer: () => Promise<unknown> = async () => ({});

const arm: Arm = { on: false };

/**
 * Captured before the registration below.
 *
 * The MinIO contract suite in tests/drivers needs the genuine client, and
 * `mock.module` cannot be unregistered - so unarmed, every export here hands
 * back the real one. Without this, running the suite in a single process
 * replaced the SDK inside those integration tests and they talked to an array
 * instead of a bucket.
 */
const realSdk = { ...sdk };

/**
 * Records what the driver built, or defers to the real command class.
 *
 * A `construct` trap rather than a class that returns from its constructor:
 * the unarmed path has to hand back a genuine instance, and a proxy does that
 * without the sleight of hand a constructor return relies on.
 */
const command = <T extends new (input: never) => object>(
  name: string,
  Real: T,
): T =>
  new Proxy(Real, {
    construct: (Target, args: [Record<string, unknown>]) =>
      arm.on
        ? { command: name, input: args[0] }
        : new Target(...(args as unknown as [never])),
  });

mock.module("@aws-sdk/client-s3", () => ({
  ...realSdk,
  // Unarmed, this is the real client - `config`, `middlewareStack` and every
  // method included - because the trap forwards construction untouched. The
  // MinIO contract suite depends on exactly that.
  S3Client: new Proxy(realSdk.S3Client, {
    construct: (Target, args: [Record<string, unknown>]) => {
      if (!arm.on) return new Target(...(args as unknown as [never]));
      constructed.push(args[0]);
      return {
        async send(item: Sent, options?: Record<string, unknown>) {
          sent.push({ command: item.command, input: item.input });
          sendOptions.push(options);
          return await answer();
        },
      };
    },
  }),
  PutObjectCommand: command("put", realSdk.PutObjectCommand),
  GetObjectCommand: command("get", realSdk.GetObjectCommand),
  DeleteObjectCommand: command("delete", realSdk.DeleteObjectCommand),
  HeadBucketCommand: command("head", realSdk.HeadBucketCommand),
}));

/*
 * Dynamic on purpose: a static import is hoisted above `mock.module`, so the
 * driver would close over the real SDK.
 */
const { createS3Storage } = await import("../src/storage/s3.ts");

const BASE = {
  s3Bucket: "plans",
  s3Region: "eu-west-2",
  s3ForcePathStyle: true,
} as unknown as Config;

const storage = (over: Record<string, unknown> = {}) =>
  createS3Storage({ ...BASE, ...over } as Config);

// Arms the stub above for this file; unarmed, the real SDK answers.
armWhileFileRuns(arm, () => {
  sent.length = 0;
  sendOptions.length = 0;
  constructed.length = 0;
  answer = async () => ({});
});

/**
 * The options one construction handed the SDK.
 *
 * Throws rather than defaulting to `{}`: every assertion below is an absence
 * check, and `"credentials" in {}` is false, so a fallback would let the whole
 * block pass while recording nothing at all.
 */
const optionsAt = (index: number): Record<string, unknown> => {
  const options = constructed[index];
  if (options === undefined) {
    throw new Error(`no client was constructed at index ${index}`);
  }
  return options;
};

describe("construction", () => {
  test("refuses without a bucket, naming the setting", () => {
    expect(() => storage({ s3Bucket: undefined })).toThrow(
      "S3_BUCKET is required when STORAGE_DRIVER=s3",
    );
  });

  test("passes the region through", () => {
    storage();

    expect(constructed[0]).toMatchObject({ region: "eu-west-2" });
  });

  test("path-style addressing rides with the endpoint, not on its own", () => {
    // It is meaningless against real AWS, so it is only sent for a deployment
    // that named its own endpoint - MinIO and friends.
    storage();
    storage({ s3Endpoint: "https://minio.internal:9000" });
    // Passed through as configured rather than implied by the endpoint: an
    // endpoint that addresses buckets by virtual host has to be able to say so.
    storage({
      s3Endpoint: "https://minio.internal:9000",
      s3ForcePathStyle: false,
    });

    expect("forcePathStyle" in optionsAt(0)).toBe(false);
    expect(constructed[1]).toMatchObject({ forcePathStyle: true });
    expect(optionsAt(2)["forcePathStyle"]).toBe(false);
  });

  test("omits credentials entirely when neither key is configured", () => {
    storage();

    // Present-but-undefined is not the same thing: the SDK branches on the key
    // existing, and omitting it is what lets the provider chain run.
    expect("credentials" in optionsAt(0)).toBe(false);
  });

  test("omits them when only one key is configured", () => {
    // Configuration refuses this pair at boot; the driver must not invent a
    // partial credential if one ever reached it.
    storage({ s3AccessKeyId: "AKIA0000" });
    storage({ s3SecretAccessKey: "secret" });

    expect(constructed).toHaveLength(2);
    expect(constructed.every((options) => !("credentials" in options))).toBe(
      true,
    );
  });

  test("uses them when both are configured", () => {
    storage({ s3AccessKeyId: "AKIA0000", s3SecretAccessKey: "secret" });

    expect(constructed[0]).toMatchObject({
      credentials: { accessKeyId: "AKIA0000", secretAccessKey: "secret" },
    });
  });

  test("omits the endpoint unless one is configured", () => {
    storage();
    storage({ s3Endpoint: "https://minio.internal:9000" });

    expect("endpoint" in optionsAt(0)).toBe(false);
    expect(constructed[1]).toMatchObject({
      endpoint: "https://minio.internal:9000",
    });
  });
});

describe("the requests it composes", () => {
  test("a write names the bucket, the key, and the content type", async () => {
    await storage().put("abc123", new TextEncoder().encode("<p>hi</p>"));

    expect(sent[0]).toMatchObject({
      command: "put",
      input: {
        Bucket: "plans",
        Key: "plans/abc123",
        ContentType: "text/html; charset=utf-8",
        ContentLength: 9,
      },
    });
  });

  test("a delete is a plain delete, because S3 makes it idempotent", async () => {
    await storage().delete("abc123");

    expect(sent[0]).toMatchObject({
      command: "delete",
      input: { Bucket: "plans", Key: "plans/abc123" },
    });
  });

  test("the probe heads the bucket rather than reading an object", async () => {
    await storage().probe();

    expect(sent[0]).toEqual({ command: "head", input: { Bucket: "plans" } });
  });

  test("the probe hands its cancellation signal to the SDK", async () => {
    const controller = new AbortController();

    await storage().probe(controller.signal);

    // Asserted at the driver, not only at the route: `/healthz` aborts its own
    // controller either way, so a probe that quietly dropped this argument
    // would leave that test green while the socket stayed held.
    expect(sendOptions[0]?.["abortSignal"]).toBe(controller.signal);
  });

  test("a probe failure surfaces, which is what makes it a probe", async () => {
    answer = async () => {
      throw new Error("bucket is unreachable");
    };

    await expect(storage().probe()).rejects.toThrow("bucket is unreachable");
  });
});

describe("reading an object", () => {
  test("returns the body, size, and etag", async () => {
    const stream = new Response("<p>hi</p>").body as ReadableStream;
    answer = async () => ({
      Body: { transformToWebStream: () => stream },
      ContentLength: 9,
      ETag: '"abc"',
    });

    const object = await storage().get("abc123");

    expect(object).toEqual({ body: stream, size: 9, etag: '"abc"' });
    expect(sent[0]).toMatchObject({
      command: "get",
      input: { Bucket: "plans", Key: "plans/abc123" },
    });
  });

  test("a response with no body is absence, not an empty document", async () => {
    answer = async () => ({ ContentLength: 0 });

    expect(await storage().get("abc123")).toBeNull();
  });

  test("a response missing its metadata still answers", async () => {
    answer = async () => ({
      Body: { transformToWebStream: () => new Response("<p>hi</p>").body },
    });

    const object = await storage().get("abc123");

    // A response can arrive with neither ContentLength nor ETag, and the
    // caller still has to be handed readable bytes rather than the defaults
    // that stood in for the missing metadata. Consumed rather than compared by
    // identity: handing back the same object proves nothing about serving it.
    expect(object).toMatchObject({ size: 0, etag: "" });
    expect(await new Response(object?.body).text()).toBe("<p>hi</p>");
  });

  test("a NoSuchKey error reads as absent", async () => {
    answer = async () => {
      throw Object.assign(new Error("nope"), { name: "NoSuchKey" });
    };

    expect(await storage().get("abc123")).toBeNull();
  });

  test("a 404 in $metadata reads as absent too", async () => {
    // A miss arrives this way rather than as NoSuchKey on some endpoints.
    answer = async () => {
      throw { $metadata: { httpStatusCode: 404 } };
    };

    expect(await storage().get("abc123")).toBeNull();
  });

  test("a 403 is not absence and must surface", async () => {
    // Swallowing a permissions failure as "not found" would turn a broken
    // deployment into a site of empty 404s.
    answer = async () => {
      throw Object.assign(new Error("Forbidden"), {
        $metadata: { httpStatusCode: 403 },
      });
    };

    await expect(storage().get("abc123")).rejects.toThrow("Forbidden");
  });

  test("a plain network error surfaces", async () => {
    answer = async () => {
      throw new Error("socket hang up");
    };

    await expect(storage().get("abc123")).rejects.toThrow("socket hang up");
  });

  test("a thrown non-object surfaces rather than reading as absent", async () => {
    answer = async () => {
      throw "unexpected";
    };

    await expect(storage().get("abc123")).rejects.toBe("unexpected");
  });

  test("an error carrying a non-object $metadata surfaces", async () => {
    answer = async () => {
      throw Object.assign(new Error("odd"), { $metadata: null });
    };

    await expect(storage().get("abc123")).rejects.toThrow("odd");
  });

  test("an id the key mapping refuses never reaches the network", async () => {
    await expect(storage().get("../../etc/passwd")).rejects.toThrow();

    // Only meaningful once the rejection has settled: an un-awaited assertion
    // would read `sent` before the driver had the chance to reach the network.
    expect(sent).toEqual([]);
  });
});
