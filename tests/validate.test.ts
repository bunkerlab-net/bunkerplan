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
      reason: "external reference: script[src] https://cdn.example.com/x.js",
    });
  });

  test("rejects a relative stylesheet - relative counts as external", () => {
    expect(check(DOC(`<link rel="stylesheet" href="./a.css">`))).toEqual({
      ok: false,
      reason: "external reference: link[href] ./a.css - inline the stylesheet",
    });
  });

  test("rejects a root-relative stylesheet", () => {
    expect(check(DOC(`<link rel="stylesheet" href="/a.css">`))).toEqual({
      ok: false,
      reason: "external reference: link[href] /a.css - inline the stylesheet",
    });
  });

  test("rejects a protocol-relative image", () => {
    expect(check(DOC(`<img src="//cdn.example.com/x.png">`))).toEqual({
      ok: false,
      reason: "external reference: img[src] //cdn.example.com/x.png",
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

  test("rejects an external candidate inside srcset", () => {
    expect(
      check(DOC(`<img srcset="a.png 1x, https://cdn.example.com/b.png 2x">`)),
    ).toEqual({ ok: false, reason: "external reference: img[srcset] a.png" });
  });

  test("rejects @import inside a style element", () => {
    expect(
      check(
        `<!doctype html><html><head><style>@import url(https://x/y.css);</style></head><body></body></html>`,
      ),
    ).toEqual({
      ok: false,
      reason: "external reference: style https://x/y.css",
    });
  });

  test("rejects url() inside a style attribute", () => {
    expect(
      check(DOC(`<div style="background:url(//evil/x.png)"></div>`)),
    ).toEqual({
      ok: false,
      reason: "external reference: div[style] //evil/x.png",
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
      reason: "external reference: base[href] https://x/",
    });
  });

  test("rejects an external meta refresh", () => {
    expect(
      check(
        `<!doctype html><html><head><meta http-equiv="refresh" content="0; url=https://evil.example"></head><body></body></html>`,
      ),
    ).toEqual({
      ok: false,
      reason:
        "external reference: meta[http-equiv=refresh] https://evil.example",
    });
  });

  test("rejects an SVG use[xlink:href]", () => {
    expect(
      check(DOC(`<svg><use xlink:href="https://x/sprite.svg#a"></use></svg>`)),
    ).toEqual({
      ok: false,
      reason: "external reference: use[xlink:href] https://x/sprite.svg#a",
    });
  });

  test("rejects an iframe src", () => {
    expect(check(DOC(`<iframe src="https://example.com"></iframe>`))).toEqual({
      ok: false,
      reason: "external reference: iframe[src] https://example.com",
    });
  });

  test("rejects iframe[srcdoc] carrying an entity-encoded nested document", () => {
    const srcdoc =
      "&lt;script src=&#39;https://cdn.example.com/x.js&#39;&gt;&lt;/script&gt;";
    expect(check(DOC(`<iframe srcdoc="${srcdoc}"></iframe>`))).toEqual({
      ok: false,
      reason: "nested document: iframe[srcdoc]",
    });
  });

  test("rejects iframe[srcdoc] even when it looks harmless", () => {
    expect(
      check(DOC(`<iframe srcdoc="&lt;p&gt;hi&lt;/p&gt;"></iframe>`)),
    ).toEqual({ ok: false, reason: "nested document: iframe[srcdoc]" });
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
    ).toEqual({ ok: false, reason: "not valid UTF-8" });
  });

  test("rejects a JPEG payload", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a]);
    expect(validateStandaloneHtml(jpeg).ok).toBe(false);
  });

  test("rejects plain text that is not an HTML document", () => {
    expect(check("hello world")).toEqual({
      ok: false,
      reason: "not an HTML document",
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
      reason: "external reference: script[xlink:href] https://e.example/a.js",
    });
  });

  test("rejects an SVG script loaded through the SVG2 href", () => {
    expect(
      check(DOC(`<svg><script href="https://e.example/a.js"></script></svg>`)),
    ).toEqual({
      ok: false,
      reason: "external reference: script[href] https://e.example/a.js",
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
      reason: "external reference: link[imagesrcset] https://e.example/x.png",
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
      reason: "external reference: feimage[xlink:href] https://e.example/x.png",
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
      reason: "external reference: style https://e.example/x.png",
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
      reason: "external reference: style https://e.example/x.png",
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
      reason: "external reference: style https://e.example/x.css",
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
      reason: `external reference: link[href] ${url} - inline the stylesheet`,
    });
  });

  test("names an @import target, which has no attribute to name", () => {
    const url = "https://fonts.googleapis.com/css2?family=Inter";
    expect(check(DOC(`<style>@import url("${url}");</style>`))).toEqual({
      ok: false,
      reason: `external reference: style ${url}`,
    });
  });

  test("points a font file at @font-face rather than at inlining CSS", () => {
    expect(
      check(DOC(`<style>@font-face{src:url(/f/inter.woff2)}</style>`)),
    ).toEqual({
      ok: false,
      reason:
        "external reference: style /f/inter.woff2 - embed fonts as data: URIs in @font-face",
    });
  });

  test("hints fonts over stylesheets when a link points straight at a face", () => {
    expect(
      check(DOC(`<link rel="stylesheet" href="https://e.example/i.otf">`)),
    ).toEqual({
      ok: false,
      reason:
        "external reference: link[href] https://e.example/i.otf - embed fonts as data: URIs in @font-face",
    });
  });

  test("leaves an ordinary stylesheet unhinted about fonts", () => {
    const reason = check(DOC(`<link rel="stylesheet" href="/site.css">`));
    expect(reason).toEqual({
      ok: false,
      reason:
        "external reference: link[href] /site.css - inline the stylesheet",
    });
  });

  test("truncates a target long enough to bloat a log line", () => {
    const url = `https://e.example/${"a".repeat(400)}.js`;
    const result = check(DOC(`<script src="${url}"></script>`));
    expect(result).toEqual({
      ok: false,
      reason: `external reference: script[src] ${url.slice(0, 120)}...`,
    });
  });

  test("still hints fonts when the extension falls past the truncation", () => {
    const url = `https://e.example/${"a".repeat(400)}.woff2`;
    expect(check(DOC(`<style>@font-face{src:url(${url})}</style>`))).toEqual({
      ok: false,
      reason: `external reference: style ${url.slice(0, 120)}... - embed fonts as data: URIs in @font-face`,
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
      reason: "external reference: img[src] https://e.example/ a b .png",
    });
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
      reason: "could not parse document",
    });
  });

  test("still walks a normally nested document", () => {
    expect(check(DOC("<i>".repeat(500) + "</i>".repeat(500)))).toEqual({
      ok: true,
    });
  });
});
