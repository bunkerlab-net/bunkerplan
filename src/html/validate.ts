/**
 * Standalone-HTML gate for uploads.
 *
 * WHAT THIS CANNOT DO: runtime `fetch`, `XMLHttpRequest`, `WebSocket`,
 * `EventSource`, and dynamic `import()` inside inline scripts are invisible to
 * static parsing. This check enforces "no static subresources", not "no network
 * access". The `Content-Security-Policy: sandbox` header on GET /{id} is the
 * runtime control, and it is what actually protects the uploader's session.
 *
 * `HTMLRewriter` is Workers-only and would behave differently under Bun, so
 * ultrahtml (zero dependencies, pure ESM) does the parsing on both runtimes.
 */
import { ELEMENT_NODE, type Node, parse, TEXT_NODE, walkSync } from "ultrahtml";

export type ValidationResult = { ok: true } | { ok: false; reason: string };

/**
 * Subresource-loading attributes per tag. These fetch automatically on load.
 *
 * Deliberately ABSENT: `a[href]`, `area[href]`, `form[action]`,
 * `button[formaction]`, `a[ping]`. Those are user-initiated navigations, not
 * automatic loads, and rejecting them would reject ordinary documents that
 * merely link out.
 *
 * Null-prototype because the lookup key is a tag name straight out of the
 * document: a plain object literal answers `URL_ATTRS["constructor"]` with a
 * function, which is not iterable, and `<constructor>` is a parseable tag.
 */
const URL_ATTRS: Record<string, readonly string[]> = Object.assign(
  Object.create(null),
  {
    // SVG `<script>` takes `href`/`xlink:href`, not `src`, and browsers fetch
    // it. Same element name as the HTML one, different attribute.
    script: ["src", "href", "xlink:href"],
    link: ["href", "imagesrcset"],
    img: ["src", "srcset"],
    source: ["src", "srcset"],
    iframe: ["src"],
    frame: ["src"],
    embed: ["src"],
    object: ["data", "archive", "classid"],
    video: ["src", "poster"],
    audio: ["src"],
    track: ["src"],
    input: ["src"],
    base: ["href"],
    html: ["manifest"],
    body: ["background"],
    table: ["background"],
    tr: ["background"],
    td: ["background"],
    th: ["background"],
    use: ["href", "xlink:href"],
    image: ["href", "xlink:href"],
    // SVG filter primitive; fetches like any other image.
    feimage: ["href", "xlink:href"],
  },
);

/** Attributes whose value is a comma-separated candidate list. */
const SRCSET_ATTRS: Record<string, true> = {
  srcset: true,
  // `<link rel=preload as=image imagesrcset=...>` fetches on load exactly as
  // `img[srcset]` does.
  imagesrcset: true,
};

/**
 * Allowed: nothing to fetch, or the bytes travel inside the document.
 * Rejected: every scheme, protocol-relative `//host`, AND every relative path -
 * a standalone file has no siblings to resolve against.
 */
function isExternalRef(raw: string): boolean {
  const value = raw.trim();
  if (value === "") return false;
  if (value.startsWith("#")) return false;
  const lowered = value.toLowerCase();
  if (lowered.startsWith("data:")) return false;
  if (lowered.startsWith("blob:")) return false;
  if (lowered === "about:blank") return false;
  return true;
}

function firstExternalCandidate(srcset: string): string | null {
  for (const candidate of srcset.split(",")) {
    const url = candidate.trim().split(/\s+/)[0];
    if (url !== undefined && isExternalRef(url)) return url;
  }
  return null;
}

/**
 * Comments are token separators, so `@import/**` + `/"evil.css"` is a valid
 * import that no pattern anchored on `@import\s` would see. Removing them
 * first is cheaper than teaching every pattern to skip them, and it closes
 * the whole class rather than one spelling of it. Hand-scanned rather than
 * regex-replaced: a lazy `[\s\S]*?` retried at every unterminated `/*` is
 * quadratic, and the input is attacker-supplied.
 */
function stripCssComments(css: string): string {
  if (!css.includes("/*")) return css;
  let out = "";
  let index = 0;
  for (;;) {
    const start = css.indexOf("/*", index);
    if (start === -1) return out + css.slice(index);
    out += `${css.slice(index, start)} `;
    const end = css.indexOf("*/", start + 2);
    if (end === -1) return out;
    index = end + 2;
  }
}

/**
 * The argument text of every `name(` call, in order.
 *
 * Hand-scanned, because every regex spelling of this rescans. `url\(\s*(...)?
 * \s*\)` has two whitespace runs either side of a value that may match empty,
 * so a `url(` followed by a long run of spaces and no closing paren makes the
 * engine try each way of splitting that run between them. `[^)]*\)` is no
 * better: with no `)` anywhere, it walks back over the whole remainder from
 * every call site. Both are quadratic or worse on bytes an uploader chooses,
 * and 500 KB was enough to hold a CPU for two minutes. `indexOf` only ever
 * moves forward.
 *
 * A `)` inside a quoted value ends the span early, which can only make the
 * extracted text look more external than it is - the safe direction.
 */
function* callArguments(
  css: string,
  lowered: string,
  name: string,
): Generator<string> {
  let index = 0;
  for (;;) {
    const open = lowered.indexOf(name, index);
    if (open === -1) return;
    const start = open + name.length;
    const close = css.indexOf(")", start);
    // No `)` in the remainder, so nothing after this can close either.
    if (close === -1) return;
    yield css.slice(start, close);
    index = close + 1;
  }
}

/** `\s+` before a required quote only ever walks back over its own run. */
const CSS_IMPORT = /@import\s+(?:"([^"]*)"|'([^']*)')/gi;
const CSS_STRING = /"([^"]*)"|'([^']*)'/g;

/** `url(...)`, `@import`, and `image-set(...)` targets in CSS text. */
function findExternalInCss(rawCss: string): string | null {
  const css = stripCssComments(rawCss);
  const lowered = css.toLowerCase();

  for (const raw of callArguments(css, lowered, "url(")) {
    const trimmed = raw.trim();
    const quote = trimmed.charAt(0);
    const target =
      (quote === '"' || quote === "'") && trimmed.endsWith(quote)
        ? trimmed.slice(1, -1)
        : trimmed;
    if (isExternalRef(target)) return target;
  }

  // `image-set("x.png" 1x)` takes bare strings, so it fetches without ever
  // writing `url(`. Matching the bare name also covers `-webkit-image-set(`.
  for (const args of callArguments(css, lowered, "image-set(")) {
    for (const candidate of args.matchAll(CSS_STRING)) {
      const target = candidate[1] ?? candidate[2];
      if (target !== undefined && isExternalRef(target)) return target;
    }
  }

  for (const match of css.matchAll(CSS_IMPORT)) {
    const target = match[1] ?? match[2];
    if (target !== undefined && isExternalRef(target)) return target;
  }

  return null;
}

/** The `url=` part of `<meta http-equiv="refresh" content="0; url=...">`. */
function refreshTarget(content: string): string | null {
  const match = /url\s*=\s*(['"]?)([^'";]+)\1/i.exec(content);
  return match?.[2]?.trim() ?? null;
}

function lowerAttributes(
  attributes: Record<string, string>,
): Record<string, string> {
  // Null-prototype for the same reason as `URL_ATTRS`: the keys come from the
  // document, so `__proto__` on a plain literal would not be an ordinary entry.
  const lowered: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(attributes)) {
    lowered[key.toLowerCase()] = value;
  }
  return lowered;
}

function checkElement(node: Node): string | null {
  if (node.type !== ELEMENT_NODE) return null;
  const tag = String(node.name).toLowerCase();
  const attributes = lowerAttributes(node.attributes);

  for (const attr of URL_ATTRS[tag] ?? []) {
    const value = attributes[attr];
    if (value === undefined) continue;
    if (SRCSET_ATTRS[attr] === true) {
      if (firstExternalCandidate(value) !== null) {
        return `external reference: ${tag}[${attr}]`;
      }
      continue;
    }
    if (isExternalRef(value)) return `external reference: ${tag}[${attr}]`;
  }

  if (tag === "meta" && attributes["http-equiv"]?.toLowerCase() === "refresh") {
    const target = attributes["content"];
    if (target !== undefined) {
      const url = refreshTarget(target);
      if (url !== null && isExternalRef(url)) {
        return "external reference: meta[http-equiv=refresh]";
      }
    }
  }

  // `srcdoc` carries a whole nested document whose own subresources would load
  // automatically. Its value is HTML-entity encoded, and ultrahtml does not
  // decode attribute entities - validating it recursively would mean writing an
  // entity decoder and trusting it as a security boundary. A standalone
  // document gains nothing from `srcdoc`, so it is rejected outright.
  if (tag === "iframe" && (attributes["srcdoc"] ?? "").trim() !== "") {
    return "nested document: iframe[srcdoc]";
  }

  const inlineStyle = attributes["style"];
  if (inlineStyle !== undefined && findExternalInCss(inlineStyle) !== null) {
    return `external reference: ${tag}[style]`;
  }

  if (tag === "style") {
    for (const child of node.children ?? []) {
      if (child.type !== TEXT_NODE) continue;
      if (findExternalInCss(String(child.value)) !== null) {
        return "external reference: style";
      }
    }
  }

  return null;
}

/** Strip a BOM, leading whitespace, and leading comments before the shape test. */
function stripPreamble(text: string): string {
  let rest = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (;;) {
    const trimmed = rest.trimStart();
    if (!trimmed.startsWith("<!--")) return trimmed;
    const end = trimmed.indexOf("-->");
    if (end === -1) return trimmed;
    rest = trimmed.slice(end + 3);
  }
}

export function validateStandaloneHtml(bytes: Uint8Array): ValidationResult {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: "not valid UTF-8" };
  }

  const head = stripPreamble(text).slice(0, 64).toLowerCase();
  if (!head.startsWith("<!doctype html") && !head.startsWith("<html")) {
    return { ok: false, reason: "not an HTML document" };
  }

  let reason: string | null = null;
  try {
    walkSync(parse(text), (node) => {
      if (reason !== null) return;
      reason = checkElement(node);
    });
  } catch {
    // ultrahtml parses and walks recursively, so a deeply nested document
    // overflows the stack rather than returning. Anything the parser cannot
    // see through, this check cannot vouch for, so refuse it as an upload
    // error instead of letting a `RangeError` surface as a 500.
    return { ok: false, reason: "could not parse document" };
  }

  return reason === null ? { ok: true } : { ok: false, reason };
}
