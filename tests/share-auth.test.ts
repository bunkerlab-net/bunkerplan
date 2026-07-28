import { describe, expect, test } from "bun:test";
import { serializeSigned } from "hono/utils/cookie";
import {
  hashShareCode,
  mintShareCookie,
  SHARE_COOKIE_TTL_SEC,
  shareCodeMatches,
  shareCookieName,
  verifyShareCookie,
} from "../src/http/share-auth.ts";

const SECRET = "share-auth-test-secret-0123456789abcdef";
const PLAN = "abcdefgh12345678";
const NOW = 1_800_000_000_000;

/**
 * The domain-separated key `share-auth.ts` derives internally. Restated here
 * rather than exported: a test that could reach the derivation would prove
 * nothing about a cookie a real client presents.
 */
const COOKIE_SECRET = `${SECRET}:bunkerplan-share-cookie-v1`;

const config = { secret: SECRET, publicBaseUrl: "https://plans.example.test" };

/** The `Set-Cookie` value reduced to what a browser would send back. */
function asRequestCookie(setCookie: string): string {
  return setCookie.split(";")[0] ?? "";
}

async function mint(
  hash: string,
  over: Partial<typeof config> = {},
): Promise<string> {
  return asRequestCookie(
    await mintShareCookie({ ...config, ...over }, PLAN, hash, NOW),
  );
}

describe("hashShareCode", () => {
  test("is lowercase hex SHA-256 of the code", async () => {
    // Independently known digest of "abc": nothing here is self-referential.
    expect(await hashShareCode("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("distinguishes codes that differ in case", async () => {
    // Share codes are base62, so a case-insensitive digest would silently
    // throw away a bit per character.
    expect(await hashShareCode("Ab")).not.toBe(await hashShareCode("aB"));
  });
});

describe("shareCodeMatches", () => {
  test("accepts the code that produced the digest", async () => {
    expect(
      await shareCodeMatches("swordfish", await hashShareCode("swordfish")),
    ).toBe(true);
  });

  test("refuses a one-character difference", async () => {
    expect(
      await shareCodeMatches("swordfisH", await hashShareCode("swordfish")),
    ).toBe(false);
  });

  test("refuses an empty stored hash rather than matching everything", async () => {
    expect(await shareCodeMatches("swordfish", "")).toBe(false);
  });
});

describe("the unlock cookie", () => {
  test("round-trips the code it was minted for", async () => {
    const hash = await hashShareCode("code-one");
    expect(
      await verifyShareCookie(SECRET, PLAN, hash, await mint(hash), NOW),
    ).toBe(true);
  });

  test("is scoped to the plan and marked for a browser", async () => {
    const hash = await hashShareCode("code-one");
    const setCookie = await mintShareCookie(config, PLAN, hash, NOW);

    expect(setCookie.startsWith(`${shareCookieName(PLAN)}=`)).toBe(true);
    expect(setCookie).toContain(`Path=/p/${PLAN}`);
    expect(setCookie).toContain("HttpOnly");
    // Not Strict: a share link is followed from chat, which is cross-site.
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain(`Max-Age=${SHARE_COOKIE_TTL_SEC}`);
    expect(setCookie).toContain("Secure");
  });

  test("omits Secure when the deployment is served over http", async () => {
    const hash = await hashShareCode("code-one");
    // An unconditional Secure attribute makes local development impossible:
    // the browser accepts the cookie and never sends it back.
    const setCookie = await mintShareCookie(
      { secret: SECRET, publicBaseUrl: "http://localhost:8787" },
      PLAN,
      hash,
      NOW,
    );
    expect(setCookie).not.toContain("Secure");
  });

  test("refuses a missing header and a header without the cookie", async () => {
    const hash = await hashShareCode("code-one");
    expect(await verifyShareCookie(SECRET, PLAN, hash, null, NOW)).toBe(false);
    expect(await verifyShareCookie(SECRET, PLAN, hash, "other=1", NOW)).toBe(
      false,
    );
  });

  test("refuses a tampered signature", async () => {
    const hash = await hashShareCode("code-one");
    const cookie = await mint(hash);
    // Flip the last character of the base64 signature.
    const tampered = `${cookie.slice(0, -2)}${cookie.at(-2) === "A" ? "B" : "A"}${cookie.at(-1)}`;
    expect(await verifyShareCookie(SECRET, PLAN, hash, tampered, NOW)).toBe(
      false,
    );
  });

  test("refuses a cookie signed with another secret", async () => {
    const hash = await hashShareCode("code-one");
    const cookie = await mint(hash, {
      secret: "a-different-secret-value-here",
    });
    expect(await verifyShareCookie(SECRET, PLAN, hash, cookie, NOW)).toBe(
      false,
    );
  });

  test("refuses an unsigned value that is not a cookie of ours", async () => {
    const name = shareCookieName(PLAN);
    expect(
      await verifyShareCookie(SECRET, PLAN, "x", `${name}=nonsense`, NOW),
    ).toBe(false);
  });

  test.each([
    ["too few fields", `${PLAN}:onlytwo`],
    ["too many fields", `${PLAN}:hash:1:extra`],
    ["a non-numeric expiry", `${PLAN}:hash:soon`],
    ["an empty payload", ""],
  ])("refuses a correctly signed payload with %s", async (_, payload) => {
    // Signed with our own key, so the signature verifies and only the payload
    // parse can refuse it. Without this the shape check would be dead code
    // that the bad-signature tests above already covered.
    const signed = await serializeSigned(
      shareCookieName(PLAN),
      payload,
      COOKIE_SECRET,
    );

    expect(
      await verifyShareCookie(
        SECRET,
        PLAN,
        "hash",
        asRequestCookie(signed),
        NOW,
      ),
    ).toBe(false);
  });

  test("a well-formed payload signed with that same key is accepted", async () => {
    // The positive control for the block above. `COOKIE_SECRET` is restated
    // here rather than imported, so if the derivation in share-auth.ts ever
    // changed, every negative case would still pass - for the wrong reason,
    // because nothing would verify. This is what notices.
    const signed = await serializeSigned(
      shareCookieName(PLAN),
      `${PLAN}:hash:${NOW + 60_000}`,
      COOKIE_SECRET,
    );

    expect(
      await verifyShareCookie(
        SECRET,
        PLAN,
        "hash",
        asRequestCookie(signed),
        NOW,
      ),
    ).toBe(true);
  });

  test("refuses a cookie minted for another plan", async () => {
    const hash = await hashShareCode("code-one");
    const other = "zzzzzzzz99999999";
    const setCookie = await mintShareCookie(config, other, hash, NOW);
    // Renamed onto this plan: the signature still verifies, the payload does
    // not. Without the plan id inside the signed statement this would pass.
    const renamed = asRequestCookie(setCookie).replace(
      shareCookieName(other),
      shareCookieName(PLAN),
    );
    expect(await verifyShareCookie(SECRET, PLAN, hash, renamed, NOW)).toBe(
      false,
    );
  });

  test("refuses a cookie minted before the code was rotated", async () => {
    const cookie = await mint(await hashShareCode("code-one"));
    // This is what makes rotation revoke outstanding cookies for free.
    expect(
      await verifyShareCookie(
        SECRET,
        PLAN,
        await hashShareCode("code-two"),
        cookie,
        NOW,
      ),
    ).toBe(false);
  });

  test("refuses an expired cookie, and accepts one a second before", async () => {
    const hash = await hashShareCode("code-one");
    const cookie = await mint(hash);
    const expiry = NOW + SHARE_COOKIE_TTL_SEC * 1000;

    expect(
      await verifyShareCookie(SECRET, PLAN, hash, cookie, expiry - 1_000),
    ).toBe(true);
    expect(await verifyShareCookie(SECRET, PLAN, hash, cookie, expiry)).toBe(
      false,
    );
  });
});
