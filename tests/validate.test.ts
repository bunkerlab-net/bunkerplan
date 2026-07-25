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
    ).toEqual({ ok: false, reason: "external reference: script[src]" });
  });

  test("rejects a relative stylesheet — relative counts as external", () => {
    expect(check(DOC(`<link rel="stylesheet" href="./a.css">`))).toEqual({
      ok: false,
      reason: "external reference: link[href]",
    });
  });

  test("rejects a root-relative stylesheet", () => {
    expect(check(DOC(`<link rel="stylesheet" href="/a.css">`))).toEqual({
      ok: false,
      reason: "external reference: link[href]",
    });
  });

  test("rejects a protocol-relative image", () => {
    expect(check(DOC(`<img src="//cdn.example.com/x.png">`))).toEqual({
      ok: false,
      reason: "external reference: img[src]",
    });
  });

  test("accepts a data: image", () => {
    const png =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    expect(check(DOC(`<img src="${png}">`))).toEqual({ ok: true });
  });

  test("accepts an external link — user-initiated navigation", () => {
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
    ).toEqual({ ok: false, reason: "external reference: img[srcset]" });
  });

  test("rejects @import inside a style element", () => {
    expect(
      check(
        `<!doctype html><html><head><style>@import url(https://x/y.css);</style></head><body></body></html>`,
      ),
    ).toEqual({ ok: false, reason: "external reference: style" });
  });

  test("rejects url() inside a style attribute", () => {
    expect(
      check(DOC(`<div style="background:url(//evil/x.png)"></div>`)),
    ).toEqual({ ok: false, reason: "external reference: div[style]" });
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
    ).toEqual({ ok: false, reason: "external reference: base[href]" });
  });

  test("rejects an external meta refresh", () => {
    expect(
      check(
        `<!doctype html><html><head><meta http-equiv="refresh" content="0; url=https://evil.example"></head><body></body></html>`,
      ),
    ).toEqual({
      ok: false,
      reason: "external reference: meta[http-equiv=refresh]",
    });
  });

  test("rejects an SVG use[xlink:href]", () => {
    expect(
      check(DOC(`<svg><use xlink:href="https://x/sprite.svg#a"></use></svg>`)),
    ).toEqual({ ok: false, reason: "external reference: use[xlink:href]" });
  });

  test("rejects an iframe src", () => {
    expect(check(DOC(`<iframe src="https://example.com"></iframe>`))).toEqual({
      ok: false,
      reason: "external reference: iframe[src]",
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
