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
- **A share code in a URL is visible wherever that URL is, so the link people
  paste does not put it in one a server sees.** The dashboard hands out
  `/s/{id}#code=…`. A fragment is never sent to a server, so it reaches no
  request line, no access log and no `Referer`. The code itself does reach this
  deployment when it is redeemed, in the body of `POST /api/plans/{id}/unlock` -
  a code has to be presented to be checked - so a proxy that logs request bodies
  sees it there; what the fragment buys is that no URL carries it. `/s/{id}` is
  the app's own page, under the app policy, and it strips the code from the
  address bar before it tries to redeem it - so a wrong code or a dropped connection
  does not leave it in history either. It is deliberately not `/p/{id}#code=`:
  that path answers a reader who already holds access with the uploaded
  document, and a plan can read its own `location.hash`, so the credential would
  be handed to HTML the reader did not write.

  The `?code=` parameter on `/p/{id}` is kept for a client that can only fetch
  a URL. No client sends a fragment - that is what makes the share link safe -
  so using one is a two-step: read the code out of the URL you were given, then
  `POST /api/plans/{id}/unlock` with it in the JSON body and keep the cookie.
  Anything that can make that request should, and a script holding the link
  already can. The query form skips the two steps and pays for it: the code
  reaches the deployment's own access log and that browser's history, and a plan
  served in the same request can read `location.search`.

  Rotating the code (`POST /api/plans/{id}/share-code`) is the remedy in every
  case: the cookie is signed over a digest of the code current when it was
  minted, so rotation invalidates every cookie issued under the old one.

## Supported versions

`master` only. There are no maintained release branches.
