import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";
import {
  CLIENT_IP_HEADER,
  SELF_HOSTED as DRIVERS,
  REQUIRED as MINIMUM,
} from "./config-env.ts";

/**
 * The refusals `loadConfig` makes, and the defaults it falls back to.
 *
 * tests/config.test.ts covers the four settings whose *values* are
 * security-relevant - the client IP header, the relying-party id, and the two
 * id lengths. This is the other half: the shape of the contract itself. Every
 * driver that needs a companion setting, every parser that has to reject a
 * malformed value rather than coerce it, and the report that comes back when
 * more than one thing is wrong at once.
 *
 * Configuration is read once at boot and a wrong value here is a deployment
 * that comes up misconfigured rather than failing, which is why each refusal
 * is pinned to its own message.
 */

/*
 * The header added to both: off Workers the loader refuses to guess one, and
 * without it every message below would carry a second complaint. The refusal
 * itself belongs to tests/config.test.ts - see tests/config-env.ts.
 */
const REQUIRED = { ...MINIMUM, ...CLIENT_IP_HEADER };
const SELF_HOSTED = { ...DRIVERS, ...CLIENT_IP_HEADER };

/** The message `loadConfig` threw, or a failure saying it did not throw. */
function refusal(env: Record<string, unknown>, workers = false): string {
  try {
    loadConfig(env as never, { workers });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    // Only the validator's own refusal answers these tests. A TypeError from a
    // fixture built wrong would otherwise satisfy every `toContain` naming a
    // substring it happened to include, and the case would look covered.
    if (!message.startsWith("Invalid configuration:")) throw cause;
    return message;
  }
  throw new Error("expected loadConfig to refuse this environment");
}

describe("the identity settings", () => {
  test("a missing secret is refused", () => {
    const { BETTER_AUTH_SECRET, ...rest } = SELF_HOSTED;
    expect(refusal(rest)).toContain("BETTER_AUTH_SECRET is required");
  });

  test("an empty secret is refused as missing, not as short", () => {
    expect(refusal({ ...SELF_HOSTED, BETTER_AUTH_SECRET: "" })).toContain(
      "BETTER_AUTH_SECRET is required",
    );
  });

  test("a short secret names the floor", () => {
    const message = refusal({ ...SELF_HOSTED, BETTER_AUTH_SECRET: "tooshort" });

    expect(message).toContain("at least 32 characters");
  });

  test("a missing base URL is refused with an example", () => {
    const { PUBLIC_BASE_URL, ...rest } = SELF_HOSTED;

    // The example is the point of the message: an operator who has not set this
    // needs the shape, not just the name of the variable they missed.
    expect(refusal(rest)).toContain(
      "PUBLIC_BASE_URL is required (e.g. https://plans.example.com)",
    );
  });

  test("a base URL that is not a URL is refused, quoting what was given", () => {
    expect(
      refusal({ ...SELF_HOSTED, PUBLIC_BASE_URL: "plans.example.com" }),
    ).toContain('PUBLIC_BASE_URL is not a valid URL: "plans.example.com"');
  });

  test("the base URL is reduced to its origin", () => {
    const config = loadConfig(
      {
        ...SELF_HOSTED,
        PUBLIC_BASE_URL: "https://plans.example.com/some/path?q=1#frag",
      } as never,
      {},
    );

    expect(config.publicBaseUrl).toBe("https://plans.example.com");
  });
});

describe("the drivers and their companions", () => {
  test("off Cloudflare every driver has to be named", () => {
    const message = refusal(REQUIRED);

    expect(message).toContain("STORAGE_DRIVER is required");
    expect(message).toContain("DB_DRIVER is required");
    expect(message).toContain("KV_DRIVER is required");
  });

  test("on Workers they default to the platform's own", () => {
    const config = loadConfig(REQUIRED as never, { workers: true });

    expect(config.storageDriver).toBe("r2");
    expect(config.dbDriver).toBe("d1");
    expect(config.kvDriver).toBe("kv");
  });

  /**
   * On Workers a driver name is not an implementation choice: the platform
   * three are bindings, and nothing else is in the bundle at all. Accepting
   * `DB_DRIVER=postgres` there built a Worker that resolved a driver it could
   * not import, which surfaced as a runtime failure on the first request
   * rather than at boot.
   */
  test.each([
    ["DB_DRIVER", "postgres", "d1"],
    ["KV_DRIVER", "valkey", "kv"],
    ["STORAGE_DRIVER", "s3", "r2"],
  ])("%s=%s is refused on Workers", (key, given, only) => {
    const message = refusal({ ...REQUIRED, [key]: given }, true);

    expect(message).toContain(
      `${key} must be "${only}" on Cloudflare Workers, got "${given}"`,
    );
  });

  test.each(["DB_DRIVER", "KV_DRIVER", "STORAGE_DRIVER"])(
    "naming the platform's own %s explicitly is still accepted",
    (key) => {
      const only = { DB_DRIVER: "d1", KV_DRIVER: "kv", STORAGE_DRIVER: "r2" }[
        key
      ];
      expect(() =>
        loadConfig({ ...REQUIRED, [key]: only } as never, { workers: true }),
      ).not.toThrow();
    },
  );

  /**
   * The mirror image, and the reason it belongs here rather than in
   * src/runtime/node.ts: that file reaches the drivers one at a time and
   * throws on the first it cannot dispatch to, so an operator who named all
   * three platform bindings would fix one, restart, and meet the next. This
   * file exists to hand back every problem at once.
   */
  test("off Workers all three platform bindings are refused together", () => {
    const message = refusal({
      ...REQUIRED,
      DB_DRIVER: "d1",
      KV_DRIVER: "kv",
      STORAGE_DRIVER: "r2",
    });

    expect(message).toContain(
      "STORAGE_DRIVER=r2 is only available on Cloudflare Workers; use s3 " +
        "when self-hosting",
    );
    expect(message).toContain(
      "DB_DRIVER=d1 is only available on Cloudflare Workers; use sqlite or " +
        "postgres when self-hosting",
    );
    expect(message).toContain(
      "KV_DRIVER=kv is only available on Cloudflare Workers; use valkey " +
        "when self-hosting",
    );
  });

  test("an unknown driver is refused and lists what is allowed", () => {
    const message = refusal({ ...SELF_HOSTED, STORAGE_DRIVER: "gcs" });

    // The whole clause including its end, not a prefix of it. `r2` is
    // deliberately absent off Workers - it is not a choice there, and offering
    // it would send an operator to a driver that refuses next - so a message
    // reading "one of: s3, r2" has to fail, and it would satisfy a `toContain`
    // that stopped at "s3".
    expect(message).toContain('STORAGE_DRIVER must be one of: s3, got "gcs"');
  });

  test.each([
    ["S3_BUCKET", "STORAGE_DRIVER=s3"],
    ["DATABASE_URL", "DB_DRIVER=postgres"],
    ["VALKEY_URL", "KV_DRIVER=valkey"],
  ])("%s is required for %s", (key, condition) => {
    const env = { ...SELF_HOSTED } as Record<string, unknown>;
    delete env[key];

    expect(refusal(env)).toContain(`${key} is required when ${condition}`);
  });

  test("a bucket is not required for r2, which names its own binding", () => {
    // On Workers, because that is the only runtime `r2` is accepted on now -
    // off it the driver itself is refused before a bucket could be missed.
    const config = loadConfig(REQUIRED as never, { workers: true });

    expect(config.storageDriver).toBe("r2");
    expect(config.s3Bucket).toBeUndefined();
  });

  test("half a credential pair is refused rather than falling through", () => {
    // The provider chain would take over and surface as a confusing 403 much
    // later, somewhere with no configuration in view.
    const message = refusal({
      ...SELF_HOSTED,
      S3_ACCESS_KEY_ID: "AKIA0000",
    });

    expect(message).toContain(
      "S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set together",
    );
  });

  test("the other half alone is refused too", () => {
    expect(
      refusal({ ...SELF_HOSTED, S3_SECRET_ACCESS_KEY: "secret" }),
    ).toContain("must be set together");
  });

  test("both together are accepted", () => {
    const config = loadConfig(
      {
        ...SELF_HOSTED,
        S3_ACCESS_KEY_ID: "AKIA0000",
        S3_SECRET_ACCESS_KEY: "secret",
      } as never,
      {},
    );

    expect(config.s3AccessKeyId).toBe("AKIA0000");
    expect(config.s3SecretAccessKey).toBe("secret");
  });

  test("neither is accepted, which is the provider chain", () => {
    const config = loadConfig(SELF_HOSTED as never, {});

    expect(config.s3AccessKeyId).toBeUndefined();
    expect(config.s3SecretAccessKey).toBeUndefined();
  });
});

describe("boolean settings", () => {
  test.each([
    ["true", true],
    ["TRUE", true],
    ["1", true],
    ["false", false],
    ["FALSE", false],
    ["0", false],
  ])("%s reads as %s", (raw, expected) => {
    const config = loadConfig({ ...SELF_HOSTED, LOG_COLOR: raw } as never, {});

    expect(config.logColor).toBe(expected);
  });

  test("anything else is refused rather than read as false", () => {
    expect(refusal({ ...SELF_HOSTED, LOG_COLOR: "yes" })).toContain(
      'LOG_COLOR must be "true" or "false", got "yes"',
    );
  });

  test("path-style addressing is on by default, for MinIO and friends", () => {
    expect(loadConfig(SELF_HOSTED as never, {}).s3ForcePathStyle).toBe(true);
  });

  test("and can be turned off", () => {
    expect(
      loadConfig({ ...SELF_HOSTED, S3_FORCE_PATH_STYLE: "false" } as never, {})
        .s3ForcePathStyle,
    ).toBe(false);
  });
});

describe("integer settings", () => {
  test("a value below the floor is refused, naming the floor", () => {
    expect(refusal({ ...SELF_HOSTED, MAX_UPLOAD_BYTES: "0" })).toContain(
      'MAX_UPLOAD_BYTES must be an integer >= 1, got "0"',
    );
  });

  test("a negative value is an integer, so the floor is what refuses it", () => {
    expect(refusal({ ...SELF_HOSTED, MAX_UPLOAD_BYTES: "-1" })).toContain(
      'MAX_UPLOAD_BYTES must be an integer >= 1, got "-1"',
    );
  });

  test("a bounded setting names both ends", () => {
    expect(refusal({ ...SELF_HOSTED, PLAN_ID_LENGTH: "999" })).toContain(
      "PLAN_ID_LENGTH must be an integer between",
    );
  });

  test.each(["1.5", "abc", "Infinity"])(
    "%p is not an integer and is refused",
    (raw) => {
      expect(refusal({ ...SELF_HOSTED, MAX_UPLOAD_BYTES: raw })).toContain(
        "MAX_UPLOAD_BYTES must be an integer",
      );
    },
  );

  test.each(["", " "])(
    "%p is treated as unset and takes the default",
    (raw) => {
      // The documented default, spelled out rather than imported from
      // src/config.ts: docs/self-hosting.md and .env.example both publish
      // 2 MiB, so a change to the constant has to fail somewhere.
      expect(
        loadConfig({ ...SELF_HOSTED, MAX_UPLOAD_BYTES: raw } as never, {})
          .maxUploadBytes,
      ).toBe(2_097_152);
    },
  );

  test.each([
    ["0x10", 16],
    ["1e3", 1000],
    [" 42 ", 42],
  ])("%p is accepted as %i, the way Number reads it", (raw, expected) => {
    // Not a special case: the parser is `Number`, so every literal form it
    // understands is accepted. Each of these is an integer, which is the
    // property the setting actually cares about.
    expect(
      loadConfig({ ...SELF_HOSTED, MAX_UPLOAD_BYTES: raw } as never, {})
        .maxUploadBytes,
    ).toBe(expected);
  });

  test("a rate window below the floor is refused, not silently raised", () => {
    // A one-second window is a legal number that would make the limiter
    // useless. Refusing says so at boot; clamping left the deployment running
    // a limit the operator did not configure and could not see.
    expect(refusal({ ...SELF_HOSTED, UPLOAD_RATE_WINDOW_SEC: "1" })).toContain(
      'UPLOAD_RATE_WINDOW_SEC must be an integer >= 60, got "1"',
    );
  });

  /**
   * The one ceiling that depends on the runtime. Deleting an account sweeps
   * its objects one at a time inside one invocation, and on Workers that
   * invocation has a subrequest budget - so a quota above what the sweep can
   * finish is refused at boot rather than discovered by an account that
   * cannot be deleted. Self-hosted there is no budget and no ceiling.
   */
  test("the plan quota is capped on Workers", () => {
    expect(refusal({ ...REQUIRED, MAX_PLANS_PER_USER: "401" }, true)).toContain(
      'MAX_PLANS_PER_USER must be an integer between 1 and 400, got "401"',
    );
  });

  test("and uncapped off Workers, where nothing counts the calls", () => {
    expect(
      loadConfig({ ...SELF_HOSTED, MAX_PLANS_PER_USER: "5000" } as never, {})
        .maxPlansPerUser,
    ).toBe(5000);
  });

  test("the unlock window has no such floor", () => {
    const config = loadConfig(
      { ...SELF_HOSTED, UNLOCK_RATE_WINDOW_SEC: "1" } as never,
      {},
    );

    // The floor exists because Workers KV rejects an `expirationTtl` under
    // 60s, and the unlock counter is a database row with no TTL. A shorter
    // window is a weaker limit, which is the operator's call to make.
    expect(config.unlockRateWindowSec).toBe(1);
  });
});

describe("logging settings", () => {
  test("default to structured JSON at info, uncoloured", () => {
    const config = loadConfig(SELF_HOSTED as never, {});

    // Off by default so captured logs stay free of escape codes.
    expect(config).toMatchObject({
      logFormat: "json",
      logLevel: "info",
      logColor: false,
    });
  });

  test("an unknown format is refused", () => {
    expect(refusal({ ...SELF_HOSTED, LOG_FORMAT: "logfmt" })).toContain(
      "LOG_FORMAT must be one of: json, plain",
    );
  });

  test("an unknown level is refused and lists the levels", () => {
    const message = refusal({ ...SELF_HOSTED, LOG_LEVEL: "verbose" });

    expect(message).toContain("LOG_LEVEL must be one of:");
    expect(message).toContain("debug");
  });
});

describe("the rest of the defaults", () => {
  test("are what a deployment gets when it names only the drivers", () => {
    const config = loadConfig(SELF_HOSTED as never, {});

    expect(config).toMatchObject({
      rpName: "BunkerPlan",
      s3Region: "us-east-1",
      sqlitePath: "./data/bunkerplan.db",
      rpId: "plans.example.com",
    });
    expect(config.s3Endpoint).toBeUndefined();
  });

  test("each one can be overridden", () => {
    const config = loadConfig(
      {
        ...SELF_HOSTED,
        RP_NAME: "Acme Plans",
        S3_REGION: "eu-west-2",
        S3_ENDPOINT: "https://minio.internal:9000",
        SQLITE_PATH: "/var/lib/plans.db",
      } as never,
      {},
    );

    expect(config).toMatchObject({
      rpName: "Acme Plans",
      s3Region: "eu-west-2",
      s3Endpoint: "https://minio.internal:9000",
      sqlitePath: "/var/lib/plans.db",
    });
  });
});

describe("the refusal itself", () => {
  test("reports every problem at once, not just the first", () => {
    /*
     * Built on a complete environment so the four settings below are the only
     * things wrong with it. Passing them alone also tripped the three
     * required-but-absent checks, which made the count meaningless and is why
     * this asserted `toBeGreaterThan(4)` before.
     */
    const message = refusal({
      ...SELF_HOSTED,
      BETTER_AUTH_SECRET: "short",
      PUBLIC_BASE_URL: "not a url",
      STORAGE_DRIVER: "gcs",
      LOG_COLOR: "maybe",
    });

    // A deployment that fixes one setting per restart is a bad afternoon.
    for (const fragment of [
      "BETTER_AUTH_SECRET",
      "PUBLIC_BASE_URL",
      "STORAGE_DRIVER",
      "LOG_COLOR",
    ]) {
      expect(message).toContain(fragment);
    }
    // Exactly four problems, so one header segment plus four. `toBeGreaterThan`
    // also passed on a message that bundled extra complaints nobody asked for.
    expect(message.split("\n  - ").length).toBe(5);
  });

  test("points at the document that describes the contract", () => {
    expect(refusal({})).toContain("docs/self-hosting.md");
  });
});
