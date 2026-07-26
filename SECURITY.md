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
- **Plan ids are unguessable, not secret.** A plan URL is public and unlisted.
  Anyone holding the URL can read it, by design.

## Supported versions

`master` only. There are no maintained release branches.
