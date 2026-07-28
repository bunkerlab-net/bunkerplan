import { describe, expect, test } from "bun:test";
import { samePathOnly } from "../src/client/passkey.ts";

/**
 * Where a passkey ceremony lands.
 *
 * This is the one place the app hands a string to `location.assign`, and an
 * open redirect out of a *signed-in* ceremony is a phishing primitive: the
 * victim has just authenticated, so an attacker's page catches them at the
 * moment they are least suspicious. Nothing can reach it with a scheme today,
 * which is exactly why the behaviour is pinned here rather than argued about
 * from the call sites.
 */

const ORIGIN = "https://plans.example.test";
const FALLBACK = "/dashboard";

describe("samePathOnly", () => {
  test.each([
    ["/dashboard"],
    ["/p/k3mp7q2xr9vt4nzb"],
    ["/p/abc?code=xyz"],
    ["/p/abc#section"],
    ["/p/abc?code=xyz#section"],
  ])("keeps the same-origin path %s", (destination) => {
    expect(samePathOnly(destination, ORIGIN)).toBe(destination);
  });

  test.each([
    ["an absolute URL", "https://evil.example/steal"],
    ["another scheme", "javascript:alert(1)"],
    ["a data URL", "data:text/html,<script>x</script>"],
    ["protocol-relative", "//evil.example/steal"],
    ["a bare path with no leading slash", "evil.example"],
    ["an empty string", ""],
  ])("refuses %s", (_, destination) => {
    expect(samePathOnly(destination, ORIGIN)).toBe(FALLBACK);
  });

  /**
   * The cases a string check alone misses. A URL parser strips tab, newline,
   * and carriage return before parsing, so each of these *becomes*
   * `//evil.example` after it has already passed a `startsWith("//")` test.
   * Backslashes go with them because some browsers fold them to slashes.
   */
  test.each([
    ["a tab", "/\t/evil.example"],
    ["a newline", "/\n/evil.example"],
    ["a carriage return", "/\r/evil.example"],
    ["a tab inside the host", "//evil\t.example"],
    ["a backslash", "/\\evil.example"],
    ["double backslashes", "\\\\evil.example"],
  ])("refuses %s, which a parser would strip", (_, destination) => {
    expect(samePathOnly(destination, ORIGIN)).toBe(FALLBACK);
  });

  test("refuses a path that normalises into a protocol-relative one", () => {
    // `/..//evil.example` resolves onto this origin with a pathname of
    // `//evil.example`. Handing that to `location.assign` navigates to
    // someone else's host, so the resolved path is checked as well as the
    // input - the leading-`//` test cannot see a `//` that normalisation
    // produced.
    expect(samePathOnly("/..//evil.example", ORIGIN)).toBe(FALLBACK);
  });

  test("normalises rather than trusting the string it was given", () => {
    // `new URL` collapses the traversal, so what reaches `assign` is a path
    // this origin actually has.
    expect(samePathOnly("/p/../dashboard", ORIGIN)).toBe("/dashboard");
  });
});
