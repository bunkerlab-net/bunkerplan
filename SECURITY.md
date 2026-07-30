# Security policy

## Reporting a vulnerability

Report privately through
[GitHub Security Advisories](https://github.com/bunkerlab-net/bunkerplan/security/advisories/new).
Please do not open a public issue for a vulnerability.

Include what you need to make the finding reproducible: the affected version or
commit, the request or document that triggers it, and what you observed.

You should get an acknowledgement within 7 days. If a fix is warranted it lands
on `master` and is noted in the advisory.

## Scope

This repository is the application. A deployment of it is not: how a given
instance is hosted, proxied, and configured is the operator's own. Reports
about a third-party instance belong to whoever runs it.

Findings that depend on a configuration the documentation warns against are
out of scope. `docs/self-hosting.md` records those explicitly - `CLIENT_IP_HEADER`
naming a header the proxy does not overwrite is the main one.

## What a plan may and may not do

Plans are arbitrary HTML supplied by an authenticated user and served publicly
at `/p/{id}`. Being able to run script inside a plan is the design, not a
finding. What matters is what that script can reach.

`src/http/security-headers.ts` pins the policy, and every plan response carries
it. Under it a plan is in an opaque origin, so it is **not** same-origin with
the application it shares a hostname with: it cannot read the session cookie or
storage, and it cannot call `/api/*` with a caller's credentials. It also loads
nothing - `default-src 'none'` and `connect-src 'none'` mean no subresources,
no `fetch`, no `XMLHttpRequest`, no `WebSocket`, no `EventSource`, no
`sendBeacon`.

Anything that gets past that is in scope, and the sandbox escape is the
interesting class: a plan reaching the app origin, another user's session, or
another account's plans.

Known and accepted, so please do not report these as new:

- **A plan can still cause an outbound request by navigating.** CSP has no
  deployable `navigate-to`, and the top-navigation sandbox tokens govern only
  embedded documents, so script in a plan can assign `location` or open a
  window and thereby disclose a reader's IP. Only removing `allow-scripts`
  would close it, and that would stop plans being documents.
- **The upload-time HTML check is not the boundary.** It refuses static
  subresources so an author learns at upload time, but it permits inline
  script by design and CSS escapes such as `u\72l(...)` parse in a browser
  while defeating any token scan. Bypasses of it are worth reporting as bugs;
  they are not sandbox escapes.
- **Plan ids are identifiers, not credentials.** They are unguessable and
  unlisted, and that is all they are. A public plan is readable by anyone
  holding its URL, by design. A private one is not: it still needs its share
  code, the cookie a redemption left, an API key whose owner may read it, or a
  session for the owner or a granted account.
- **`?code=` is visible wherever a URL is, and still exists.** The share link
  the dashboard hands out carries the code as `#code=`, and a fragment is never
  sent to a server: it reaches no access log, no proxy, and no `Referer`. The
  gate page redeems it and strips it from the address bar before it can fail, so
  a wrong code does not leave it in history either. The `?code=` parameter is
  kept because a reader without a DOM cannot send a fragment, and one used that
  way does reach the deployment's logs and that browser's history. Rotating the
  code (`POST /api/plans/{id}/share-code`) is the remedy: the cookie is signed
  over a digest of the code current when it was minted, so rotation invalidates
  every cookie issued under the old one.

## Supported versions

`master` only. There are no maintained release branches.
