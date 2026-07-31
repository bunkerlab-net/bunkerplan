import { describe, expect, test } from "bun:test";
import { APP_CSP, PLAN_CSP } from "../src/http/security-headers.ts";
import { hashShareCode, shareCookieName } from "../src/http/share-auth.ts";
import {
  buildApp,
  CLIENT_IP,
  CLIENT_IP_HEADER,
  GRANTEE,
  memoryPlans,
  memoryStorage,
  OWNER,
  PLAN_ID,
  STRANGER,
  storedPlan,
} from "./app-harness.ts";

/**
 * `GET /p/:id` - the route the whole product exists to serve, and the one
 * where a mistake is a disclosure rather than a bug.
 *
 * Three things are load-bearing and each is pinned below. The plan sandbox has
 * to be on the 304 as well as the 200, because a cache told to update a stored
 * response with a 304's headers would otherwise hold the document under the
 * *app* policy, which lets it script the real origin. A private plan must
 * never enter a shared cache. And a plan that is missing must be
 * indistinguishable from one that was never issued.
 */

const DOCUMENT = "<!doctype html><html><body><p>plan</p></body></html>";
const CODE = "sHaReCoDe1234567";

/**
 * The `name=value` pair a response set, without the attributes after it.
 *
 * What a browser would send back, which is what these tests replay. Named
 * rather than "the first `Set-Cookie`": these responses can carry more than
 * one, and taking whichever came first would replay a different plan's cookie
 * - or a session's - while the test reads as though it proved this plan's.
 *
 * Throws rather than returning "" for a response that set nothing: every
 * caller replays the result and asserts on what it opens, and an empty cookie
 * earns the same 401 as a wrong one - passing the test without testing
 * anything.
 */
const cookiePair = (response: Response, planId: string): string => {
  const name = shareCookieName(planId);
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(";")[0] ?? "";
    if (pair.startsWith(`${name}=`) && !pair.endsWith("=")) return pair;
  }
  throw new Error(`the response set no ${name} cookie`);
};

const serve = (
  over: {
    plan?: Parameters<typeof storedPlan>[0];
    sessionUser?: string | null;
    keyUser?: string | null;
    stored?: boolean;
  } = {},
) =>
  buildApp({
    sessionUser: over.sessionUser ?? null,
    keyUser: over.keyUser ?? null,
    plans: memoryPlans([storedPlan(over.plan)]),
    storage:
      over.stored === false
        ? memoryStorage()
        : memoryStorage({ [PLAN_ID]: DOCUMENT }),
  });

describe("a public plan", () => {
  test("is served to anyone, with the plan sandbox pinned on", async () => {
    const app = serve({ plan: { visibility: "public" } });

    const response = await app.fetch(`/p/${PLAN_ID}`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(DOCUMENT);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("content-security-policy")).toBe(PLAN_CSP);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  test("may be cached, but must be revalidated before every use", async () => {
    const app = serve({ plan: { visibility: "public" } });

    const response = await app.fetch(`/p/${PLAN_ID}`);

    // A freshness window would let a shared cache keep handing out a plan
    // after its owner made it private, which is a hole in the one control this
    // feature exists to provide.
    expect(response.headers.get("cache-control")).toBe("public, no-cache");
    expect(response.headers.get("vary")).toBeNull();
    expect(response.headers.get("etag")).not.toBeNull();
  });

  test("a matching ETag gets a 304 that still carries the sandbox", async () => {
    const app = serve({ plan: { visibility: "public" } });
    const first = await app.fetch(`/p/${PLAN_ID}`);
    const etag = first.headers.get("etag") ?? "";

    const second = await app.fetch(`/p/${PLAN_ID}`, {
      headers: { "if-none-match": etag },
    });

    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
    // Omit these and the entry middleware fills in the app policy instead,
    // which has no sandbox - and a cache may merge that onto the stored body.
    expect(second.headers.get("content-security-policy")).toBe(PLAN_CSP);
    expect(second.headers.get("etag")).toBe(etag);
    expect(second.headers.get("cache-control")).toBe("public, no-cache");
  });

  test("a stale ETag gets the document again", async () => {
    const app = serve({ plan: { visibility: "public" } });

    const response = await app.fetch(`/p/${PLAN_ID}`, {
      headers: { "if-none-match": '"not-the-current-one"' },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(DOCUMENT);
  });
});

describe("a private plan", () => {
  test("is served to its owner and kept out of shared caches", async () => {
    const app = serve({ sessionUser: OWNER });

    const response = await app.fetch(`/p/${PLAN_ID}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    // It varies by every credential that can open the gate.
    expect(response.headers.get("vary")).toBe("cookie, x-api-key");
    expect(response.headers.get("content-security-policy")).toBe(PLAN_CSP);
  });

  test("is served to a granted account", async () => {
    const app = serve({
      sessionUser: GRANTEE,
      plan: { grants: [GRANTEE] },
    });

    expect((await app.fetch(`/p/${PLAN_ID}`)).status).toBe(200);
  });

  test("is served to the owner's API key", async () => {
    const app = serve({ keyUser: OWNER });

    const response = await app.fetch(`/p/${PLAN_ID}`, {
      headers: { "x-api-key": "bkp_test" },
    });

    expect(response.status).toBe(200);
  });

  test("gates a stranger at 401 rather than 200", async () => {
    const app = serve({ sessionUser: STRANGER });

    const response = await app.fetch(`/p/${PLAN_ID}`);

    // 401 is load-bearing: the plan sandbox is pinned onto `/p/*` at 200 and
    // 304 only, and under it this page could neither sign in nor post a code.
    expect(response.status).toBe(401);
    const body = await response.text();
    expect(body).toContain("This plan is private.");
    expect(response.headers.get("cache-control")).toBe("no-store");
    // Positively the app policy, not merely "not the sandbox": an absent
    // header would satisfy the negative while leaving the page unpoliced.
    expect(response.headers.get("content-security-policy")).toBe(APP_CSP);
    // And it says nothing about the document.
    expect(body).not.toContain("plan</p>");
    // Not the relay. `relay: true` makes the client forward to `/s/{id}`, so
    // the gate that IS `/p/{id}` claiming it would send every refused reader
    // around a loop back to here.
    expect(body).toContain('"relay":false');
  });

  test("gates an anonymous visitor the same way", async () => {
    const app = serve();

    expect((await app.fetch(`/p/${PLAN_ID}`)).status).toBe(401);
  });

  test("a 304 for the owner keeps the private caching rules too", async () => {
    const app = serve({ sessionUser: OWNER });
    const first = await app.fetch(`/p/${PLAN_ID}`);

    const second = await app.fetch(`/p/${PLAN_ID}`, {
      headers: { "if-none-match": first.headers.get("etag") ?? "" },
    });

    expect(second.status).toBe(304);
    expect(second.headers.get("cache-control")).toBe("private, no-store");
    expect(second.headers.get("vary")).toBe("cookie, x-api-key");
  });

  test("the gate offers a code box only when there is a code to enter", async () => {
    const withCode = serve({
      plan: { shareCodeHash: await hashShareCode(CODE) },
    });
    const without = serve();

    expect(await (await withCode.fetch(`/p/${PLAN_ID}`)).text()).toContain(
      "Have a code?",
    );
    expect(await (await without.fetch(`/p/${PLAN_ID}`)).text()).not.toContain(
      "Have a code?",
    );
  });
});

describe("a code-shared plan", () => {
  const gated = async () =>
    buildApp({
      plans: memoryPlans([
        storedPlan({ shareCodeHash: await hashShareCode(CODE) }),
      ]),
      storage: memoryStorage({ [PLAN_ID]: DOCUMENT }),
    });

  test("opens with ?code= and hands back the cookie in the same response", async () => {
    const app = await gated();

    const response = await app.fetch(`/p/${PLAN_ID}?code=${CODE}`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(DOCUMENT);
    // Without this the parameter would be needed on every later request. That
    // the minted header carries Path, HttpOnly, SameSite and Secure is the
    // subject of tests/share-auth.test.ts; what this route owes is returning
    // it at all.
    expect(response.headers.get("set-cookie")).toContain(
      shareCookieName(PLAN_ID),
    );
    /*
     * A code-authenticated read is still a private read of untrusted HTML.
     * `no-store` because a shared cache holding it would serve the document to
     * the next caller with no code at all, and the sandbox because the bytes
     * came from a stranger either way.
     */
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-security-policy")).toBe(PLAN_CSP);
  });

  test("a conditional request carrying ?code= still leaves the cookie", async () => {
    const app = await gated();
    const first = await app.fetch(`/p/${PLAN_ID}?code=${CODE}`);

    const second = await app.fetch(`/p/${PLAN_ID}?code=${CODE}`, {
      headers: { "if-none-match": first.headers.get("etag") ?? "" },
    });

    expect(second.status).toBe(304);
    expect(second.headers.get("set-cookie")).toContain(
      shareCookieName(PLAN_ID),
    );
    // A 304 is a cacheable answer, so it carries the same rules as the 200.
    expect(second.headers.get("cache-control")).toBe("private, no-store");
    expect(second.headers.get("content-security-policy")).toBe(PLAN_CSP);
  });

  test("the cookie alone opens it next time", async () => {
    const app = await gated();
    const opened = await app.fetch(`/p/${PLAN_ID}?code=${CODE}`);
    const cookie = cookiePair(opened, PLAN_ID);

    const response = await app.fetch(`/p/${PLAN_ID}`, { headers: { cookie } });

    expect(response.status).toBe(200);
  });

  test("a wrong code gates rather than opening", async () => {
    const app = await gated();

    // Full length on purpose: a short code is refused by validation before the
    // digest is ever compared, so it would pass this without reaching the
    // branch the test is named for.
    expect(
      (await app.fetch(`/p/${PLAN_ID}?code=wrongcode1234567`)).status,
    ).toBe(401);
  });

  test("a cookie minted for another plan does not open this one", async () => {
    const other = "zzzzzzzzzzzzzzzz";
    const app = buildApp({
      plans: memoryPlans([
        storedPlan({ shareCodeHash: await hashShareCode(CODE) }),
        storedPlan({ id: other, shareCodeHash: await hashShareCode(CODE) }),
      ]),
      storage: memoryStorage({ [PLAN_ID]: DOCUMENT, [other]: DOCUMENT }),
    });
    const opened = await app.fetch(`/p/${other}?code=${CODE}`);
    const minted = cookiePair(opened, other);
    const value = minted.slice(minted.indexOf("=") + 1);

    // The source unlock has to have produced a real cookie: an empty value
    // would earn the same 401 below without testing anything.
    expect(opened.status).toBe(200);
    expect(minted.startsWith(`${shareCookieName(other)}=`)).toBe(true);
    expect(value.length).toBeGreaterThan(0);

    /*
     * Renamed onto this plan's cookie, value untouched. Sending it under its
     * own name only proves the two names differ, and the name is the one part
     * a holder can choose freely - so the refusal has to come from the value
     * being bound to the plan it was minted for.
     */
    const response = await app.fetch(`/p/${PLAN_ID}`, {
      headers: { cookie: `${shareCookieName(PLAN_ID)}=${value}` },
    });

    expect(response.status).toBe(401);
  });

  /**
   * Two apps over one repository: the owner, who changes the code, and the
   * reader holding the cookie. Asking the owner's own session whether the
   * cookie still works would answer yes for a reason that has nothing to do
   * with the cookie.
   */
  const ownerAndReader = async () => {
    const plans = memoryPlans([
      storedPlan({ shareCodeHash: await hashShareCode(CODE) }),
    ]);
    const storage = memoryStorage({ [PLAN_ID]: DOCUMENT });
    const owner = buildApp({ sessionUser: OWNER, plans, storage });
    const reader = buildApp({ plans, storage });
    const opened = await reader.fetch(`/p/${PLAN_ID}?code=${CODE}`);
    const cookie = cookiePair(opened, PLAN_ID);
    return { owner, reader, cookie };
  };

  test("rotating the code retires the cookie bound to the old one", async () => {
    const { owner, reader, cookie } = await ownerAndReader();
    expect(
      (await reader.fetch(`/p/${PLAN_ID}`, { headers: { cookie } })).status,
    ).toBe(200);

    // Asserted, because a mutation that quietly 404'd would leave the reader
    // refused for the wrong reason and this test green.
    expect(
      (
        await owner.fetch(`/api/plans/${PLAN_ID}/share-code`, {
          method: "POST",
        })
      ).status,
    ).toBe(201);

    // Cookies are bound to the digest, so they die with it.
    expect(
      (await reader.fetch(`/p/${PLAN_ID}`, { headers: { cookie } })).status,
    ).toBe(401);
  });

  test("clearing the code closes the plan to a held cookie", async () => {
    const { owner, reader, cookie } = await ownerAndReader();

    expect(
      (
        await owner.fetch(`/api/plans/${PLAN_ID}/share-code`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);

    expect(
      (await reader.fetch(`/p/${PLAN_ID}`, { headers: { cookie } })).status,
    ).toBe(401);
  });

  test("a code redeemed through the API opens the plan on the next plain request", async () => {
    const app = await gated();
    const unlocked = await app.fetch(`/api/plans/${PLAN_ID}/unlock`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [CLIENT_IP_HEADER]: CLIENT_IP,
      },
      body: JSON.stringify({ code: CODE }),
    });
    const cookie = cookiePair(unlocked, PLAN_ID);

    const response = await app.fetch(`/p/${PLAN_ID}`, { headers: { cookie } });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(DOCUMENT);
  });
});

describe("a plan that is not there", () => {
  test("an unknown id renders the site's own 404", async () => {
    const app = buildApp();

    const response = await app.fetch("/p/doesnotexist1234");

    expect(response.status).toBe(404);
    expect(await response.text()).toContain("Nothing lives at this URL.");
    // Trusted HTML, so it takes the app policy rather than the plan sandbox.
    expect(response.headers.get("content-security-policy")).toBe(APP_CSP);
  });

  test("a row with no object 404s rather than serving an empty document", async () => {
    // The window between a deleted object and its row, or a storage write that
    // never landed. Either way there is nothing to serve.
    const app = serve({ sessionUser: OWNER, stored: false });

    const response = await app.fetch(`/p/${PLAN_ID}`);

    expect(response.status).toBe(404);
    expect(await response.text()).toContain("Nothing lives at this URL.");
  });

  test("a deleted plan is indistinguishable from an id never issued", async () => {
    const app = serve({ sessionUser: OWNER });
    const deleted = await app.fetch(`/api/plans/${PLAN_ID}`, {
      method: "DELETE",
    });
    // The premise: a delete that quietly failed would leave a plan that still
    // serves, and "both answered the same" would then be a claim about two
    // live plans.
    expect(deleted.status).toBe(204);

    const gone = await app.fetch(`/p/${PLAN_ID}`);
    const never = await app.fetch("/p/neverissued12345");

    expect(gone.status).toBe(404);
    expect(never.status).toBe(404);
    expect(await gone.text()).toBe(await never.text());
  });

  test("access is resolved before storage is touched", async () => {
    let reads = 0;
    const storage = memoryStorage({ [PLAN_ID]: DOCUMENT });
    const app = buildApp({
      sessionUser: STRANGER,
      plans: memoryPlans([storedPlan()]),
      storage: {
        ...storage,
        get: async (id) => {
          reads += 1;
          return await storage.get(id);
        },
      },
    });

    const response = await app.fetch(`/p/${PLAN_ID}`);

    // An unauthorised visitor costs one row read and never an object read -
    // and the status is what says the refusal is why. A route that 500'd
    // before reaching storage would read zero objects too.
    expect(response.status).toBe(401);
    expect(reads).toBe(0);
  });
});

describe("making a plan private again", () => {
  test("takes effect on the very next read", async () => {
    /*
     * One repository and one bucket, handed to both apps. Reading them back
     * off the first app would make the sharing implicit, and the whole point
     * is that the second app sees the first one's write.
     */
    const plans = memoryPlans([storedPlan({ visibility: "public" })]);
    const storage = memoryStorage({ [PLAN_ID]: DOCUMENT });
    const app = buildApp({ sessionUser: OWNER, plans, storage });
    const anonymous = buildApp({ plans, storage });
    expect((await anonymous.fetch(`/p/${PLAN_ID}`)).status).toBe(200);

    const updated = await app.fetch(`/api/plans/${PLAN_ID}/sharing`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ visibility: "private" }),
    });
    // The premise: a rejected update leaves a public plan, and "the next read
    // is 401" would then be a claim about a request that changed nothing.
    expect(updated.status).toBe(200);

    expect((await anonymous.fetch(`/p/${PLAN_ID}`)).status).toBe(401);
  });
});
