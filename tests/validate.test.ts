import { describe, expect, test } from "bun:test";
import { validateStandaloneHtml } from "../src/html/validate.ts";

const encode = (html: string) => new TextEncoder().encode(html);

function check(html: string) {
  return validateStandaloneHtml(encode(html));
}

const DOC = (body: string) =>
  `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;

describe("validateStandaloneHtml", () => {
  test("accepts a fully inline document", () => {
    const html = `<!doctype html><html><head><style>body{color:red}</style></head>
      <body><script>console.log(1)</script><p>hi</p></body></html>`;
    expect(check(html)).toEqual({ ok: true });
  });

  test("accepts a document starting with <html>", () => {
    expect(check("<html><body>hi</body></html>")).toEqual({ ok: true });
  });

  test("accepts a leading comment before the doctype", () => {
    expect(check(`<!-- generated --> ${DOC("<p>hi</p>")}`)).toEqual({
      ok: true,
    });
  });

  test("rejects an external script", () => {
    expect(
      check(DOC(`<script src="https://cdn.example.com/x.js"></script>`)),
    ).toEqual({
      ok: false,
      reasons: ["external reference: script[src] https://cdn.example.com/x.js"],
      truncated: false,
    });
  });

  test("rejects a relative stylesheet - relative counts as external", () => {
    expect(check(DOC(`<link rel="stylesheet" href="./a.css">`))).toEqual({
      ok: false,
      reasons: [
        "external reference: link[href] ./a.css - inline the stylesheet",
      ],
      truncated: false,
    });
  });

  test("rejects a root-relative stylesheet", () => {
    expect(check(DOC(`<link rel="stylesheet" href="/a.css">`))).toEqual({
      ok: false,
      reasons: [
        "external reference: link[href] /a.css - inline the stylesheet",
      ],
      truncated: false,
    });
  });

  test("rejects a protocol-relative image", () => {
    expect(check(DOC(`<img src="//cdn.example.com/x.png">`))).toEqual({
      ok: false,
      reasons: ["external reference: img[src] //cdn.example.com/x.png"],
      truncated: false,
    });
  });

  test("accepts a data: image", () => {
    const png =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    expect(check(DOC(`<img src="${png}">`))).toEqual({ ok: true });
  });

  test("accepts an external link - user-initiated navigation", () => {
    expect(check(DOC(`<a href="https://example.com">out</a>`))).toEqual({
      ok: true,
    });
  });

  test("accepts a form action and button formaction", () => {
    const html = DOC(
      `<form action="https://example.com/x"><button formaction="/y">go</button></form>`,
    );
    expect(check(html)).toEqual({ ok: true });
  });

  test("rejects every external candidate inside srcset", () => {
    expect(
      check(DOC(`<img srcset="a.png 1x, https://cdn.example.com/b.png 2x">`)),
    ).toEqual({
      ok: false,
      reasons: [
        "external reference: img[srcset] a.png",
        "external reference: img[srcset] https://cdn.example.com/b.png",
      ],
      truncated: false,
    });
  });

  test("rejects @import inside a style element", () => {
    expect(
      check(
        `<!doctype html><html><head><style>@import url(https://x/y.css);</style></head><body></body></html>`,
      ),
    ).toEqual({
      ok: false,
      reasons: ["external reference: style https://x/y.css"],
      truncated: false,
    });
  });

  test("rejects url() inside a style attribute", () => {
    expect(
      check(DOC(`<div style="background:url(//evil/x.png)"></div>`)),
    ).toEqual({
      ok: false,
      reasons: ["external reference: div[style] //evil/x.png"],
      truncated: false,
    });
  });

  test("accepts a data: url() inside a style attribute", () => {
    expect(
      check(
        DOC(`<div style="background:url(data:image/gif;base64,R0lGOD)"></div>`),
      ),
    ).toEqual({ ok: true });
  });

  test("rejects <BASE HREF> case-insensitively", () => {
    expect(
      check(
        `<!DOCTYPE HTML><HTML><HEAD><BASE HREF="https://x/"></HEAD><BODY></BODY></HTML>`,
      ),
    ).toEqual({
      ok: false,
      reasons: ["external reference: base[href] https://x/"],
      truncated: false,
    });
  });

  test("rejects an external meta refresh", () => {
    expect(
      check(
        `<!doctype html><html><head><meta http-equiv="refresh" content="0; url=https://evil.example"></head><body></body></html>`,
      ),
    ).toEqual({
      ok: false,
      reasons: [
        "external reference: meta[http-equiv=refresh] https://evil.example",
      ],
      truncated: false,
    });
  });

  test("rejects an SVG use[xlink:href]", () => {
    expect(
      check(DOC(`<svg><use xlink:href="https://x/sprite.svg#a"></use></svg>`)),
    ).toEqual({
      ok: false,
      reasons: ["external reference: use[xlink:href] https://x/sprite.svg#a"],
      truncated: false,
    });
  });

  test("rejects an iframe src", () => {
    expect(check(DOC(`<iframe src="https://example.com"></iframe>`))).toEqual({
      ok: false,
      reasons: ["external reference: iframe[src] https://example.com"],
      truncated: false,
    });
  });

  test("rejects iframe[srcdoc] carrying an entity-encoded nested document", () => {
    const srcdoc =
      "&lt;script src=&#39;https://cdn.example.com/x.js&#39;&gt;&lt;/script&gt;";
    expect(check(DOC(`<iframe srcdoc="${srcdoc}"></iframe>`))).toEqual({
      ok: false,
      reasons: ["nested document: iframe[srcdoc]"],
      truncated: false,
    });
  });

  test("rejects iframe[srcdoc] even when it looks harmless", () => {
    expect(
      check(DOC(`<iframe srcdoc="&lt;p&gt;hi&lt;/p&gt;"></iframe>`)),
    ).toEqual({
      ok: false,
      reasons: ["nested document: iframe[srcdoc]"],
      truncated: false,
    });
  });

  test("accepts an empty srcdoc", () => {
    expect(check(DOC(`<iframe srcdoc="" src="about:blank"></iframe>`))).toEqual(
      {
        ok: true,
      },
    );
  });

  test("accepts an iframe with about:blank", () => {
    expect(check(DOC(`<iframe src="about:blank"></iframe>`))).toEqual({
      ok: true,
    });
  });

  test("rejects non-UTF-8 bytes", () => {
    expect(
      validateStandaloneHtml(new Uint8Array([0xff, 0xfe, 0x00, 0x41])),
    ).toEqual({ ok: false, reasons: ["not valid UTF-8"], truncated: false });
  });

  test("rejects a JPEG payload", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a]);
    expect(validateStandaloneHtml(jpeg).ok).toBe(false);
  });

  test("rejects plain text that is not an HTML document", () => {
    expect(check("hello world")).toEqual({
      ok: false,
      reasons: ["not an HTML document"],
      truncated: false,
    });
  });
});

/**
 * Each case here was accepted by an earlier version of the gate. They are
 * grouped so that a change which reopens one is obvious in the failure name.
 */
describe("validateStandaloneHtml - subresource gate regressions", () => {
  test("rejects an SVG script loaded through xlink:href", () => {
    expect(
      check(
        DOC(`<svg><script xlink:href="https://e.example/a.js"></script></svg>`),
      ),
    ).toEqual({
      ok: false,
      reasons: [
        "external reference: script[xlink:href] https://e.example/a.js",
      ],
      truncated: false,
    });
  });

  test("rejects an SVG script loaded through the SVG2 href", () => {
    expect(
      check(DOC(`<svg><script href="https://e.example/a.js"></script></svg>`)),
    ).toEqual({
      ok: false,
      reasons: ["external reference: script[href] https://e.example/a.js"],
      truncated: false,
    });
  });

  test("rejects a preload that fetches through imagesrcset", () => {
    expect(
      check(
        DOC(
          `<link rel="preload" as="image" imagesrcset="https://e.example/x.png 1x">`,
        ),
      ),
    ).toEqual({
      ok: false,
      reasons: [
        "external reference: link[imagesrcset] https://e.example/x.png",
      ],
      truncated: false,
    });
  });

  test("rejects an feImage filter primitive", () => {
    expect(
      check(
        DOC(
          `<svg><filter id="f"><feImage xlink:href="https://e.example/x.png"/></filter></svg>`,
        ),
      ),
    ).toEqual({
      ok: false,
      reasons: [
        "external reference: feimage[xlink:href] https://e.example/x.png",
      ],
      truncated: false,
    });
  });

  test("rejects image-set(), which fetches without writing url()", () => {
    expect(
      check(
        DOC(
          `<style>b{background:image-set("https://e.example/x.png" 1x)}</style>`,
        ),
      ),
    ).toEqual({
      ok: false,
      reasons: ["external reference: style https://e.example/x.png"],
      truncated: false,
    });
  });

  test("rejects the -webkit- spelling of image-set()", () => {
    expect(
      check(
        DOC(
          `<style>b{background:-webkit-image-set("https://e.example/x.png" 1x)}</style>`,
        ),
      ),
    ).toEqual({
      ok: false,
      reasons: ["external reference: style https://e.example/x.png"],
      truncated: false,
    });
  });

  test("accepts image-set() whose candidates travel in the document", () => {
    expect(
      check(
        DOC(
          `<style>b{background:image-set("data:image/gif;base64,R0lGOD" 1x)}</style>`,
        ),
      ),
    ).toEqual({ ok: true });
  });

  /** A comment is a token separator, so it hides `@import` from `@import\s`. */
  test("rejects an @import hidden behind a comment", () => {
    expect(
      check(DOC(`<style>@import/**/"https://e.example/x.css";</style>`)),
    ).toEqual({
      ok: false,
      reasons: ["external reference: style https://e.example/x.css"],
      truncated: false,
    });
  });

  test("still accepts a comment that hides nothing", () => {
    expect(check(DOC(`<style>/* a note */ body{color:red}</style>`))).toEqual({
      ok: true,
    });
  });
});

/**
 * The target is the whole point of the refusal: without it a caller has to
 * bisect their own document to find the one reference that offended.
 */
describe("validateStandaloneHtml - the reported target", () => {
  test("names the font stylesheet a branded document reaches for", () => {
    const url = "https://fonts.googleapis.com/css2?family=Inter";
    expect(check(DOC(`<link rel="stylesheet" href="${url}">`))).toEqual({
      ok: false,
      reasons: [
        `external reference: link[href] ${url} - inline the stylesheet`,
      ],
      truncated: false,
    });
  });

  test("names an @import target, which has no attribute to name", () => {
    const url = "https://fonts.googleapis.com/css2?family=Inter";
    expect(check(DOC(`<style>@import url("${url}");</style>`))).toEqual({
      ok: false,
      reasons: [`external reference: style ${url}`],
      truncated: false,
    });
  });

  test("points a font file at @font-face rather than at inlining CSS", () => {
    expect(
      check(DOC(`<style>@font-face{src:url(/f/inter.woff2)}</style>`)),
    ).toEqual({
      ok: false,
      reasons: [
        "external reference: style /f/inter.woff2 - embed fonts as data: URIs in @font-face",
      ],
      truncated: false,
    });
  });

  test("hints fonts over stylesheets when a link points straight at a face", () => {
    expect(
      check(DOC(`<link rel="stylesheet" href="https://e.example/i.otf">`)),
    ).toEqual({
      ok: false,
      reasons: [
        "external reference: link[href] https://e.example/i.otf - embed fonts as data: URIs in @font-face",
      ],
      truncated: false,
    });
  });

  test("leaves an ordinary stylesheet unhinted about fonts", () => {
    const reason = check(DOC(`<link rel="stylesheet" href="/site.css">`));
    expect(reason).toEqual({
      ok: false,
      reasons: [
        "external reference: link[href] /site.css - inline the stylesheet",
      ],
      truncated: false,
    });
  });

  test("truncates a target long enough to bloat a log line", () => {
    const url = `https://e.example/${"a".repeat(400)}.js`;
    const result = check(DOC(`<script src="${url}"></script>`));
    expect(result).toEqual({
      ok: false,
      reasons: [`external reference: script[src] ${url.slice(0, 120)}...`],
      truncated: false,
    });
  });

  test("still hints fonts when the extension falls past the truncation", () => {
    const url = `https://e.example/${"a".repeat(400)}.woff2`;
    expect(check(DOC(`<style>@font-face{src:url(${url})}</style>`))).toEqual({
      ok: false,
      reasons: [
        `external reference: style ${url.slice(0, 120)}... - embed fonts as data: URIs in @font-face`,
      ],
      truncated: false,
    });
  });

  /**
   * A bidi override in the reported target would reorder the text around it and
   * let one refusal read as another, which is why `parsePlanLabel` refuses the
   * same characters in labels.
   */
  test("flattens newlines and bidi overrides out of the target", () => {
    expect(
      check(DOC(`<img src="https://e.example/\u202ea\nb\u202c.png">`)),
    ).toEqual({
      ok: false,
      reasons: ["external reference: img[src] https://e.example/ a b .png"],
      truncated: false,
    });
  });
});

/**
 * One upload should be enough to learn everything that has to change. The gate
 * used to stop at the first offender, so a document with three external
 * references cost three uploads to diagnose.
 */
describe("validateStandaloneHtml - every offender at once", () => {
  test("reports all three references a font-linking document carries", () => {
    const result = check(
      `<!doctype html><html><head>` +
        `<link rel="preconnect" href="https://fonts.googleapis.com">` +
        `<link rel="preconnect" href="https://fonts.gstatic.com">` +
        `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">` +
        `</head><body>x</body></html>`,
    );
    expect(result).toEqual({
      ok: false,
      reasons: [
        "external reference: link[href] https://fonts.googleapis.com",
        "external reference: link[href] https://fonts.gstatic.com",
        "external reference: link[href] https://fonts.googleapis.com/css2?family=Inter - inline the stylesheet",
      ],
      truncated: false,
    });
  });

  test("reports every offending target inside one stylesheet", () => {
    expect(
      check(
        DOC(
          `<style>a{background:url(/a.png)}b{background:url(/b.png)}@import "https://e.example/c.css";</style>`,
        ),
      ),
    ).toEqual({
      ok: false,
      reasons: [
        "external reference: style /a.png",
        "external reference: style /b.png",
        "external reference: style https://e.example/c.css",
      ],
      truncated: false,
    });
  });

  test("reports one reference written many times only once", () => {
    expect(
      check(DOC(`<img src="/a.png"><img src="/a.png"><img src="/a.png">`)),
    ).toEqual({
      ok: false,
      reasons: ["external reference: img[src] /a.png"],
      truncated: false,
    });
  });

  /**
   * Same location, same target, different `rel`, so the two need different
   * answers. Collapsing them would hide one fix behind another upload.
   */
  test("keeps one URL twice when the two refusals differ", () => {
    expect(
      check(
        `<!doctype html><html><head>` +
          `<link rel="stylesheet" href="https://e.example/x">` +
          `<link rel="preconnect" href="https://e.example/x">` +
          `</head><body>x</body></html>`,
      ),
    ).toEqual({
      ok: false,
      reasons: [
        "external reference: link[href] https://e.example/x - inline the stylesheet",
        "external reference: link[href] https://e.example/x",
      ],
      truncated: false,
    });
  });

  /**
   * Distinct URLs can share the first 120 characters, and the reported target is
   * cut there. Deduplicating on the displayed text would drop the second.
   */
  test("keeps two targets that differ only past the truncation", () => {
    const prefix = `https://e.example/${"a".repeat(400)}`;
    const result = check(
      DOC(`<img src="${prefix}-one.png"><img src="${prefix}-two.png">`),
    );
    expect(result).toMatchObject({ ok: false, truncated: false });
    if (result.ok) throw new Error("expected a refusal");
    expect(result.reasons).toHaveLength(2);
    // Both render identically, which is the point: the displayed text cannot be
    // what distinguishes them, so the raw target has to be.
    const shown = `external reference: img[src] ${prefix.slice(0, 120)}...`;
    expect(result.reasons[0]).toBe(shown);
    expect(result.reasons[1]).toBe(shown);
  });

  test("caps the list and says so when a document is all offenders", () => {
    const images = Array.from(
      { length: 40 },
      (_, n) => `<img src="/img-${n}.png">`,
    ).join("");
    const result = check(DOC(images));
    expect(result).toMatchObject({ ok: false, truncated: true });
    if (result.ok) throw new Error("expected a refusal");
    // The first ten in document order, not ten arbitrary ones: a caller fixes
    // them from the top of the file down.
    expect(result.reasons).toEqual(
      Array.from(
        { length: 10 },
        (_, n) => `external reference: img[src] /img-${n}.png`,
      ),
    );
  });

  /** Exactly at the cap is the boundary that must NOT report truncation. */
  test("reports ten offenders in full, with nothing dropped", () => {
    const images = Array.from(
      { length: 10 },
      (_, n) => `<img src="/img-${n}.png">`,
    ).join("");
    const result = check(DOC(images));
    expect(result).toMatchObject({ ok: false, truncated: false });
    if (result.ok) throw new Error("expected a refusal");
    expect(result.reasons).toHaveLength(10);
    expect(result.reasons[9]).toBe("external reference: img[src] /img-9.png");
  });

  test("leaves a single offender reporting exactly one reason", () => {
    expect(check(DOC(`<img src="/a.png">`))).toEqual({
      ok: false,
      reasons: ["external reference: img[src] /a.png"],
      truncated: false,
    });
  });
});

/**
 * Each of these was a delimiter bug: a comma or a parenthesis inside a value was
 * treated as the separator around it. Two refused documents that were valid, and
 * two let an external reference through.
 */
describe("validateStandaloneHtml - delimiters inside values", () => {
  test("accepts a data: URI in srcset, whose comma is mandatory", () => {
    expect(
      check(DOC(`<img srcset="data:image/gif;base64,R0lGOD 1x">`)),
    ).toEqual({ ok: true });
  });

  test("accepts a data: URI in imagesrcset", () => {
    expect(
      check(
        DOC(
          `<link rel="preload" as="image" imagesrcset="data:image/gif;base64,R0lGOD 1x">`,
        ),
      ),
    ).toEqual({ ok: true });
  });

  test("keeps a srcset URL that contains a comma", () => {
    expect(check(DOC(`<img srcset="https://e.example/a,b.png 1x">`))).toEqual({
      ok: false,
      reasons: ["external reference: img[srcset] https://e.example/a,b.png"],
      truncated: false,
    });
  });

  test("accepts image-set() carrying a type() descriptor beside a data: URI", () => {
    expect(
      check(
        DOC(
          `<style>b{background:image-set("data:image/gif;base64,R0lGOD" type("image/gif") 1x)}</style>`,
        ),
      ),
    ).toEqual({ ok: true });
  });

  /**
   * The span used to end at the first `)`, which the nested `url(` supplied, so
   * the candidate after it was never scanned.
   */
  test("sees an image-set() candidate that follows a nested url()", () => {
    expect(
      check(
        DOC(
          `<style>b{background:image-set(url(data:image/gif;base64,x), "https://evil.example/x.png" 2x)}</style>`,
        ),
      ),
    ).toEqual({
      ok: false,
      reasons: ["external reference: style https://evil.example/x.png"],
      truncated: false,
    });
  });

  test("sees an image-set() candidate that follows a type() descriptor", () => {
    expect(
      check(
        DOC(
          `<style>b{background:image-set("data:image/gif;base64,x" type("image/gif"), "https://evil.example/x.png" 2x)}</style>`,
        ),
      ),
    ).toEqual({
      ok: false,
      reasons: ["external reference: style https://evil.example/x.png"],
      truncated: false,
    });
  });

  test("keeps an image-set() URL that contains a comma", () => {
    expect(
      check(
        DOC(
          `<style>b{background:image-set("https://e.example/a,b.png" 1x)}</style>`,
        ),
      ),
    ).toEqual({
      ok: false,
      reasons: ["external reference: style https://e.example/a,b.png"],
      truncated: false,
    });
  });
});

/**
 * The CSS scan reads a stylesheet the way a browser tokenises one, because
 * every shortcut short of that was wrong in one direction or the other: either
 * it refused text that fetches nothing, or it lost a reference that does.
 */
describe("validateStandaloneHtml - CSS text is not CSS code", () => {
  const style = (css: string) => DOC(`<style>${css}</style>`);

  test.each([
    ['content:"url(https://e.example/x)"', "a quoted url("],
    ["content:'url(https://e.example/x)'", "a single-quoted url("],
    ['content:"see url(/docs) for more"', "a sentence mentioning url("],
    ['content:"@import \\"https://e.example/x.css\\";"', "a quoted @import"],
    ['content:"/*"', "a quoted comment opener"],
  ])("accepts %s - %s is text", (css) => {
    expect(check(style(`p::after{${css}}`))).toEqual({ ok: true });
  });

  test.each([
    ["myurl(", "a{background:myurl(https://e.example/x.png)}"],
    ["-my-url(", "a{background:-my-url(https://e.example/x.png)}"],
    [
      "my-image-set(",
      `a{background:my-image-set("https://e.example/x.png" 1x)}`,
    ],
    ["@important", `a{color:red}@important "https://e.example/x.css";`],
  ])("accepts %s, which is not the function it resembles", (_name, css) => {
    expect(check(style(css))).toEqual({ ok: true });
  });

  test("still reads -webkit-image-set(, which is a real spelling", () => {
    expect(
      check(
        style(`a{background:-webkit-image-set("https://e.example/x.png" 1x)}`),
      ),
    ).toEqual({
      ok: false,
      reasons: ["external reference: style https://e.example/x.png"],
      truncated: false,
    });
  });

  /**
   * A CSS string cannot span a newline: the newline ends a bad string and the
   * parser recovers on the next line, so a reference below one still loads.
   * Treating the quote as running to the end hid the rest of the stylesheet.
   */
  test.each([
    ['a{background:url("oops', "inside url("],
    ["a{background:url('oops", "inside url( with single quotes"],
    ['a{background:image-set("oops', "inside image-set("],
    ['a{content:"oops', "in a plain declaration"],
  ])("sees past an unterminated string %s", (opener) => {
    expect(
      check(
        style(`${opener}\n}\nb{background:url(https://evil.example/x.png)}`),
      ),
    ).toMatchObject({
      ok: false,
      reasons: ["external reference: style https://evil.example/x.png"],
    });
  });

  /** An unclosed call must not swallow the reference below it either. */
  test.each([
    [
      "with a newline after it",
      "a{background:url(data:image/gif;base64,x\n}\n",
    ],
    ["on the same line", "a{background:url(data:image/gif;base64,x "],
  ])("sees past an unclosed url( %s", (_name, opener) => {
    expect(
      check(style(`${opener}b{background:url(https://evil.example/y.png)}`)),
    ).toMatchObject({
      ok: false,
      reasons: ["external reference: style https://evil.example/y.png"],
    });
  });

  test("sees past a comment opened inside a string", () => {
    expect(
      check(
        style(
          `p::after{content:"/*"}\na{background:url(https://evil.example/z.png)}`,
        ),
      ),
    ).toMatchObject({
      ok: false,
      reasons: ["external reference: style https://evil.example/z.png"],
    });
  });

  test("reads a url() whose value is quoted behind a comment", () => {
    expect(
      check(style(`a{background:url(/*c*/"data:image/gif;base64,R0lGOD")}`)),
    ).toEqual({ ok: true });
  });

  /**
   * The documented boundary of this check, not an oversight: a name spelled
   * with CSS escapes fetches in a browser and reads as an unknown function
   * here. `PLAN_CSP` is what stops the fetch - see src/http/security-headers.ts.
   */
  test("does not see a url( spelled with CSS escapes", () => {
    expect(
      check(style(String.raw`a{background:u\72l(https://e.example/x.png)}`)),
    ).toEqual({ ok: true });
  });

  /**
   * `@import` takes its target FIRST, then any `layer()`, `supports()` or media
   * clause. So a prelude before the target is invalid CSS and imports nothing,
   * and only an at-rule actually followed by a quoted target waits for one.
   */
  test.each([
    ['@import "https://e.example/a.css" layer(base);', "a layer prelude after"],
    [
      '@import "https://e.example/a.css" supports(display:grid);',
      "a supports prelude after",
    ],
    [
      '@import "https://e.example/a.css" screen and (min-width:1px);',
      "a media query after",
    ],
    ['@import url("https://e.example/a.css") layer(base);', "url() then layer"],
  ])("reads an @import target with %s", (css) => {
    expect(check(style(css))).toMatchObject({
      ok: false,
      reasons: ["external reference: style https://e.example/a.css"],
    });
  });

  /**
   * An `@import` that names nothing must not leave the next string in the file
   * looking like its target.
   */
  test.each([
    ["@import foo;", "a bare identifier"],
    ["@import;", "nothing at all"],
    ["@import layer(base);", "only a prelude"],
  ])("does not adopt a later string after %s", (opener) => {
    expect(
      check(style(`${opener}\np::after{content:"https://e.example/text"}`)),
    ).toEqual({ ok: true });
  });
});

/**
 * `link[href]` was refused for every `rel`, including values that fetch nothing.
 * The deciding question is whether the reference reaches the network without the
 * reader acting, NOT whether it loads a subresource: the two come apart here.
 */
describe("validateStandaloneHtml - link rel", () => {
  test.each(["canonical", "alternate", "license", "prev", "next", "me"])(
    "accepts rel=%s, which fetches nothing",
    (rel) => {
      expect(
        check(DOC(`<link rel="${rel}" href="https://e.example/x">`)),
      ).toEqual({ ok: true });
    },
  );

  test("accepts several inert tokens together", () => {
    expect(
      check(DOC(`<link rel="alternate  license" href="https://e.example/x">`)),
    ).toEqual({ ok: true });
  });

  test("accepts an inert rel in any case", () => {
    expect(
      check(DOC(`<link REL="Canonical" href="https://e.example/x">`)),
    ).toEqual({ ok: true });
  });

  /**
   * An alternate stylesheet is still a stylesheet: browsers fetch it on
   * selection and some preload it, so the `stylesheet` token has to veto the
   * inert `alternate` beside it.
   */
  test("refuses rel='alternate stylesheet'", () => {
    expect(
      check(
        DOC(`<link rel="alternate stylesheet" href="https://e.example/x.css">`),
      ),
    ).toEqual({
      ok: false,
      reasons: [
        "external reference: link[href] https://e.example/x.css - inline the stylesheet",
      ],
      truncated: false,
    });
  });

  test.each([
    "preconnect",
    "dns-prefetch",
    "prerender",
    "stylesheet",
    "icon",
    "preload",
    "prefetch",
    "modulepreload",
    "manifest",
  ])("refuses rel=%s, which reaches the network", (rel) => {
    expect(
      check(DOC(`<link rel="${rel}" href="https://e.example/x">`)),
    ).toMatchObject({ ok: false });
  });

  test("refuses an unknown rel, so a new one is not admitted by default", () => {
    expect(
      check(DOC(`<link rel="somethingnew" href="https://e.example/x">`)),
    ).toMatchObject({ ok: false });
  });

  /**
   * EVERY token has to be inert, not merely one of them: an unrecognised token
   * beside `canonical` could be anything, including something that fetches.
   */
  test("refuses an inert token beside an unknown one", () => {
    expect(
      check(
        DOC(`<link rel="canonical somethingnew" href="https://e.example/x">`),
      ),
    ).toMatchObject({ ok: false });
  });

  test("refuses a link with no rel at all", () => {
    expect(check(DOC(`<link href="https://e.example/x">`))).toMatchObject({
      ok: false,
    });
  });

  test("refuses an empty rel carrying an href", () => {
    expect(
      check(DOC(`<link rel="" href="https://e.example/x.css">`)),
    ).toMatchObject({ ok: false });
  });

  test("refuses an empty rel carrying an imagesrcset", () => {
    expect(
      check(DOC(`<link rel="" imagesrcset="https://e.example/x.png 1x">`)),
    ).toMatchObject({ ok: false });
  });

  /**
   * The inert check skips the whole element rather than only its `href`, because
   * `imagesrcset` fetches only under `rel=preload as=image` - which is not
   * inert, so an inert `rel` leaves nothing on the element that can fetch.
   */
  test("accepts imagesrcset on an inert rel, which cannot fetch it", () => {
    expect(
      check(
        DOC(`<link rel="canonical" imagesrcset="https://e.example/x.png 1x">`),
      ),
    ).toEqual({ ok: true });
  });
});

describe("validateStandaloneHtml - resistance to hostile input", () => {
  /**
   * A `url(` with no closing paren used to make the scanner try every way of
   * splitting the whitespace run, which was cubic: 10 KB held a CPU for almost
   * three minutes. The budget is deliberately loose - the point is the shape
   * of the curve, not the constant.
   */
  test("scans a pathological url( in linear time", () => {
    const spaces = " ".repeat(500_000);
    const started = performance.now();
    check(DOC(`<style>a{background:url(${spaces}X</style>`));
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("scans a full-size document of unterminated calls quickly", () => {
    const started = performance.now();
    check(DOC(`<style>${"image-set(".repeat(100_000)}</style>`));
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  /**
   * Tag names index the attribute table directly, so a name that also names
   * something on `Object.prototype` used to yield a function and throw.
   */
  test.each(["constructor", "__proto__", "__defineGetter__", "toString"])(
    "treats <%s> as an ordinary unknown element",
    (tag) => {
      expect(check(DOC(`<${tag}></${tag}>`))).toEqual({ ok: true });
    },
  );

  test("refuses a document too deeply nested to walk", () => {
    const depth = 60_000;
    expect(check(DOC("<i>".repeat(depth) + "</i>".repeat(depth)))).toEqual({
      ok: false,
      reasons: ["could not parse document"],
      truncated: false,
    });
  });

  /** Unclosed tags nest just as deeply, by another spelling. */
  test("refuses a document of unclosed tags too deep to walk", () => {
    expect(check(DOC("<i>".repeat(60_000)))).toEqual({
      ok: false,
      reasons: ["could not parse document"],
      truncated: false,
    });
  });

  test("still walks a normally nested document", () => {
    expect(check(DOC("<i>".repeat(500) + "</i>".repeat(500)))).toEqual({
      ok: true,
    });
  });
});
