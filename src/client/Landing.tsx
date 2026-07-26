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
      <h1 className="hero-title">
        Upload one HTML file. Get a URL that opens.
      </h1>
      <div>
        <p>
          You asked Claude or GPT to render a plan, a pull-request review, or a
          diff as an HTML page - inline CSS, SVG diagrams, the whole thing -
          because it is far easier to follow than a wall of Markdown.
        </p>
        <p>
          Then you tried to share it. GitHub does not render HTML in a comment,
          and clicking the attachment downloads the file instead of showing it.
          BunkerPlan takes that file and hands back a link that just opens.
        </p>
      </div>
    </div>
  );
}

/**
 * The card carries the flow first and the account second. Registering is a
 * single passkey ceremony, which is a footnote to the button rather than a
 * headline of its own.
 */
function HowItWorks({
  handle,
  error,
  busy,
  onRegister,
  onSignIn,
}: LandingProps) {
  return (
    <section className="card card-feature">
      <p className="eyebrow">How it works</p>
      <h2 className="feature-title">From your terminal to their browser.</h2>
      <ol className="steps">
        <li>
          <span className="step-lead">Ask for one file.</span> Have the model
          emit a single <a href="#standalone">self-contained document</a> -
          styles inline, diagrams inline, nothing fetched from elsewhere.
        </li>
        <li>
          <span className="step-lead">Upload it.</span> Drag it onto your
          dashboard, or <code>PUT</code> it from a script with an API key.
        </li>
        <li>
          <span className="step-lead">Paste the link.</span> You get back a
          short <code>/p/</code> URL. Anyone holding it can read the page; it is
          listed nowhere else.
        </li>
        <li>
          <span className="step-lead">Revised it? Upload again.</span> Replacing
          a plan keeps its id, so the link you already sent shows the new
          version.
        </li>
      </ol>
      {handle !== null ? (
        <p className="notice">
          Signed in as <span className="mono">{handle}</span> - your plans, API
          keys, and passkeys are on <a href="/dashboard">your dashboard</a>.
        </p>
      ) : (
        <>
          <div className="row" style={{ marginTop: "32px" }}>
            <button
              type="button"
              className="btn-clay"
              disabled={busy}
              onClick={onRegister}
            >
              Create an account
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
          <p className="caption" style={{ marginTop: "16px" }}>
            An account is one passkey - Touch&nbsp;ID, Windows Hello, a phone,
            or a hardware key. No email, no password, free.
          </p>
        </>
      )}
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
          with the offending tag named. Links out are fine. What you shared is
          what they see, a year from now included.
        </p>
      </section>
      <section className="card">
        <h2 className="card-title">Safe to hand around</h2>
        <p>
          Plans are served from an opaque origin. Scripts inside a document
          still run, so interactive diagrams work, but they are not same-origin
          with this site and cannot read anyone's session.
        </p>
      </section>
      <section className="card">
        <h2 className="card-title">Publish from a script</h2>
        <p>
          Mint an API key and upload from a CI job, a git hook, or the agent
          that wrote the page.
        </p>
        <CurlSnippet />
      </section>
    </div>
  );
}

export function Landing(props: LandingProps) {
  return (
    <div className="shell">
      <Hero />
      <HowItWorks {...props} />
      <Features />
    </div>
  );
}
