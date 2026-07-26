interface LandingProps {
  /** `null` while a session is still resolving as well as when signed out. */
  handle: string | null;
  error: string | null;
  busy: boolean;
  onRegister: () => void;
  onSignIn: () => void;
}

function Hero() {
  return (
    <div className="hero">
      <h1 className="hero-title">One HTML file in. One public URL out.</h1>
      <p className="lede">
        BunkerPlan hosts self-contained documents - reports, dashboards,
        one-page briefs - at short public URLs. No build step and no framework.
        Uploads must be <a href="#standalone">genuinely standalone</a>: a
        document that statically loads an external resource is refused, though
        links out are fine.
      </p>
    </div>
  );
}

function SignInCard({
  handle,
  error,
  busy,
  onRegister,
  onSignIn,
}: LandingProps) {
  if (handle !== null) {
    return (
      <section className="card card-feature">
        <p className="eyebrow">Signed in</p>
        <h2 className="feature-title">
          You are signed in as <span className="mono">{handle}</span>.
        </h2>
        <p>
          Your plans, API keys, and passkeys are on{" "}
          <a href="/dashboard">your dashboard</a>.
        </p>
      </section>
    );
  }

  return (
    <section className="card card-feature">
      <p className="eyebrow">Get started</p>
      <h2 className="feature-title">A passkey is the whole account.</h2>
      <p>
        No email address, no username, no password to forget or leak. Register
        with the authenticator you already use - Touch&nbsp;ID, Windows Hello, a
        phone, or a hardware key - and that is the entire signup.
      </p>
      <div className="row" style={{ marginTop: "24px" }}>
        <button
          type="button"
          className="btn-clay"
          disabled={busy}
          onClick={onRegister}
        >
          Register with passkey
        </button>
        <button
          type="button"
          className="btn-text"
          disabled={busy}
          onClick={onSignIn}
        >
          I already have one
        </button>
      </div>
      {error !== null && <p className="error">{error}</p>}
    </section>
  );
}

function CurlSnippet() {
  const origin =
    typeof window === "undefined" ? "https://example.com" : location.origin;
  return (
    <code className="snippet">
      {`curl -X PUT ${origin}/api/plans \\\n  -H "x-api-key: $KEY" \\\n  -H "content-type: text/html" \\\n  --data-binary @report.html`}
    </code>
  );
}

function Features() {
  return (
    <div className="card-grid section" id="standalone">
      <section className="card">
        <h2 className="card-title">Standalone only</h2>
        <p>
          Every upload is parsed before it is stored. Reach for an external
          script, stylesheet, image, font, or iframe and the upload is rejected
          with the offending tag named.
        </p>
      </section>
      <section className="card">
        <h2 className="card-title">Served in a sandbox</h2>
        <p>
          Plans are returned in an opaque origin. Scripts inside a document
          still run, but they are not same-origin with this site, so they cannot
          read your session or act as you.
        </p>
      </section>
      <section className="card">
        <h2 className="card-title">Publish from a script</h2>
        <p>Mint an API key and upload from anywhere.</p>
        <CurlSnippet />
      </section>
    </div>
  );
}

export function Landing(props: LandingProps) {
  return (
    <div className="shell">
      <Hero />
      <SignInCard {...props} />
      <Features />
    </div>
  );
}
