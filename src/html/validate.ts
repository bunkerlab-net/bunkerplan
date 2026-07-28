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

/**
 * A refusal carries up to ten distinct references the gate objected to, not
 * just the first: one upload should be enough to learn what has to change.
 * `reasons` holds at least one entry, and `truncated` is true when the cap
 * dropped others.
 */
export type ValidationResult =
  | { ok: true }
  | { ok: false; reasons: readonly string[]; truncated: boolean };

/**
 * Attributes whose value names an external resource. Most of them fetch it
 * automatically on load; two entries are not that simple.
 *
 * `base[href]` fetches nothing - it changes how every relative URL in the
 * document resolves. `link` is not judged by this table alone: `INERT_LINK_RELS`
 * decides first, and an inert `rel` skips the element entirely, so the entry
 * here covers only the relationships that reach the network.
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

/** ASCII whitespace, which is what `srcset` tokenises on. */
const SPACE = " \t\n\r\f";

/**
 * Every external URL in a `srcset`, in order.
 *
 * Tokenised the way the HTML parser does rather than by splitting on commas: a
 * candidate URL is a run of non-whitespace characters, and only a TRAILING
 * comma ends it. Commas INSIDE a URL belong to the URL, which matters because
 * every `data:` URI carries one - splitting first reported the base64 payload
 * after the comma as a relative reference and refused documents whose image
 * travelled inside them.
 */
function* externalCandidates(srcset: string): Generator<string> {
  let index = 0;
  while (index < srcset.length) {
    // Whitespace and commas separate candidates.
    while (
      index < srcset.length &&
      (SPACE.includes(srcset[index] as string) || srcset[index] === ",")
    ) {
      index += 1;
    }
    const start = index;
    while (index < srcset.length && !SPACE.includes(srcset[index] as string)) {
      index += 1;
    }
    if (index === start) return;

    let url = srcset.slice(start, index);
    // Trailing commas end the candidate, so they are separators rather than
    // part of the URL. Anything else keeps its commas.
    const ended = url.endsWith(",");
    while (url.endsWith(",")) url = url.slice(0, -1);
    if (isExternalRef(url)) yield url;
    if (ended) continue;

    // Skip this candidate's descriptors, which run to the next comma.
    while (index < srcset.length && srcset[index] !== ",") index += 1;
  }
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
 * Index of the quote closing the CSS string opening at `open`, or -1.
 * A backslash escapes the next character, so `"a\"b"` is one string.
 */
function endOfString(css: string, open: number): number {
  const quote = css[open];
  let index = open + 1;
  while (index < css.length) {
    const char = css[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === quote) return index;
    index += 1;
  }
  return -1;
}

/**
 * Index of the `)` closing a call whose arguments begin at `start`, or -1.
 *
 * Counts nesting and skips quoted spans, because taking the FIRST `)` instead
 * truncated a span at a nested call and dropped everything after it. That was
 * not merely untidy: `image-set(url(data:...), "https://host/x.png" 2x)` ended
 * its span at the `url(` close, so the external candidate beside it was never
 * scanned and the document was accepted.
 */
function closingParen(css: string, start: number): number {
  let depth = 0;
  let index = start;
  while (index < css.length) {
    const char = css[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === '"' || char === "'") {
      const close = endOfString(css, index);
      // Unterminated, so nothing after it closes either.
      if (close === -1) return -1;
      index = close + 1;
      continue;
    }
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      if (depth === 0) return index;
      depth -= 1;
    }
    index += 1;
  }
  return -1;
}

/**
 * Whether `needle` sits at `index` in `text`, ignoring ASCII case.
 *
 * Rather than comparing against a `toLowerCase()` copy of the whole input.
 * That copy is not index-stable - `"İ".toLowerCase()` is two code units, so a
 * single uploader-supplied character shifts every offset after it and the two
 * strings stop describing the same positions. Every needle here is an ASCII
 * CSS keyword, so folding only ASCII is exact, and it allocates nothing.
 */
function startsWithAt(text: string, needle: string, index: number): boolean {
  if (index + needle.length > text.length) return false;
  for (let offset = 0; offset < needle.length; offset += 1) {
    let code = text.charCodeAt(index + offset);
    // `A`-`Z` to lowercase; the needle is written lowercase already.
    if (code >= 65 && code <= 90) code += 32;
    if (code !== needle.charCodeAt(offset)) return false;
  }
  return true;
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
 * and 500 KB was enough to hold a CPU for two minutes.
 *
 * Still linear with the matching-paren scan above: spans are disjoint, because
 * the search for the next call resumes past the close of the last one, so no
 * byte is examined by more than one span.
 */
function* callArguments(css: string, name: string): Generator<string> {
  let index = 0;
  while (index < css.length) {
    if (!startsWithAt(css, name, index)) {
      index += 1;
      continue;
    }
    const start = index + name.length;
    const close = closingParen(css, start);
    if (close === -1) return;
    yield css.slice(start, close);
    index = close + 1;
  }
}

/** `\s+` before a required quote only ever walks back over its own run. */
const CSS_IMPORT = /@import\s+(?:"([^"]*)"|'([^']*)')/gi;

/**
 * Every quoted string inside an `image-set()` span that could name an image.
 *
 * `image-set` takes bare strings, so a candidate need never write `url(`. The
 * one string in the span that is NOT a candidate is the argument of a
 * `type(<string>)` descriptor: that is a MIME type, and reporting it refused
 * documents whose image travelled beside it in a `data:` URI.
 *
 * Everything else is yielded rather than only an option's leading value. A
 * leading-value-only scan has to decide where options begin, and getting that
 * wrong loses candidates: commas are legal inside quoted URLs and mandatory
 * inside `data:` URIs, and a nested `image-set()` leads its option with a call
 * rather than a string. Yielding every non-descriptor string cannot miss one.
 */
function* imageSetImages(args: string): Generator<string> {
  let index = 0;
  while (index < args.length) {
    const char = args[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === '"' || char === "'") {
      const close = endOfString(args, index);
      // Unterminated, so nothing after it closes either.
      if (close === -1) return;
      yield args.slice(index + 1, close);
      index = close + 1;
      continue;
    }
    if (startsWithAt(args, "type(", index)) {
      const close = closingParen(args, index + "type(".length);
      if (close === -1) return;
      index = close + 1;
      continue;
    }
    index += 1;
  }
}

/**
 * Every `url(...)`, `@import`, and `image-set(...)` target in CSS text that
 * points outside the document, in that order.
 *
 * A generator rather than an array because the caller stops at a finding cap:
 * a hostile stylesheet can name a million external targets, and lazily is the
 * only way to scan one without collecting them all first.
 */
function* externalInCss(rawCss: string): Generator<string> {
  const css = stripCssComments(rawCss);

  for (const raw of callArguments(css, "url(")) {
    const trimmed = raw.trim();
    const quote = trimmed.charAt(0);
    const target =
      (quote === '"' || quote === "'") && trimmed.endsWith(quote)
        ? trimmed.slice(1, -1)
        : trimmed;
    if (isExternalRef(target)) yield target;
  }

  // `image-set("x.png" 1x)` takes bare strings, so it fetches without ever
  // writing `url(`. Matching the bare name also covers `-webkit-image-set(`.
  for (const args of callArguments(css, "image-set(")) {
    for (const target of imageSetImages(args)) {
      if (isExternalRef(target)) yield target;
    }
  }

  for (const match of css.matchAll(CSS_IMPORT)) {
    const target = match[1] ?? match[2];
    if (target !== undefined && isExternalRef(target)) yield target;
  }
}

/** The `url=` part of `<meta http-equiv="refresh" content="0; url=...">`. */
function refreshTarget(content: string): string | null {
  const match = /url\s*=\s*(['"]?)([^'";]+)\1/i.exec(content);
  return match?.[2]?.trim() ?? null;
}

/**
 * The reported target is uploader-supplied and reaches a JSON error body, a
 * log line, and the dashboard's error text. `Response.json` escapes it for
 * transport and the dashboard renders it into a text node, so there is no
 * injection to close here; what this does is keep the line bounded and
 * readable. Controls and bidi overrides collapse to a space for the reason
 * `parsePlanLabel` refuses them outright - reordered text lets one reported
 * target impersonate another.
 */
const MAX_TARGET_LENGTH = 120;
const UNPRINTABLE = /[\s\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]+/gu;

/**
 * How many distinct refusals one response carries.
 *
 * A cap because the walk is over attacker-supplied bytes: a 2 MB document can
 * name far more external references than anybody wants in an error body, and
 * an uncapped collector would build that list before anyone could refuse it.
 * Ten is past the point where a document has a systemic problem rather than a
 * typo, and the count of what was dropped travels with the response so a
 * caller cannot mistake the cap for the whole truth.
 *
 * A keyed collection rather than an array: identical references appearing twice
 * produce an identical refusal, and reporting it once is more useful than
 * reporting it as many times as it was written.
 */
const MAX_FINDINGS = 10;

/**
 * Hinted only where the document says so, never guessed from a URL. A path
 * ending in a font extension is a font; `rel="stylesheet"` is a stylesheet
 * because the document declared it.
 *
 * Each hint names only what its signal supports. Most external stylesheets are
 * ordinary CSS, so the stylesheet hint says nothing about fonts - a font
 * *stylesheet* such as `fonts.googleapis.com/css2?family=...` is CSS that
 * happens to serve fonts, and it is named by the target now being visible.
 * The embedding workflow belongs in the docs, where it can be a recipe rather
 * than a guess appended to every refusal.
 */
const FONT_FILE = /\.(?:woff2?|[ot]tf|eot)(?:[?#]|$)/i;
const FONT_HINT = " - embed fonts as data: URIs in @font-face";
const STYLESHEET_HINT = " - inline the stylesheet";

/**
 * Records one refusal: where the reference was found, and what it pointed at.
 * The target is what makes a 422 actionable - without it a caller has to bisect
 * their own document to find the one `url()` that offended.
 *
 * Keyed on the UNTRUNCATED reason, so two findings collapse only when the whole
 * refusal would read identically. Keying on anything smaller hides a fix behind
 * another upload, which is the round trip this collector exists to remove: two
 * distinct URLs can share their first 120 characters, and the same URL under
 * `rel=stylesheet` and `rel=preconnect` needs two different answers.
 */
function addExternal(
  found: Map<string, string>,
  location: string,
  target: string,
  stylesheet = false,
): void {
  const flat = target.replace(UNPRINTABLE, " ").trim();
  // Classified from the whole target, truncated only for display: a `.woff2`
  // sitting past the cut is still a font, and a long URL is exactly when the
  // caller needs to be told so.
  let hint = "";
  if (FONT_FILE.test(flat)) hint = FONT_HINT;
  else if (stylesheet) hint = STYLESHEET_HINT;
  const shown =
    flat.length > MAX_TARGET_LENGTH
      ? `${flat.slice(0, MAX_TARGET_LENGTH)}...`
      : flat;
  const full = `external reference: ${location} ${flat}${hint}`;
  found.set(full, `external reference: ${location} ${shown}${hint}`);
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

/**
 * `rel` tokens that cause no network activity whatsoever. A `link` whose every
 * token is one of these fetches nothing, resolves nothing, and connects to
 * nothing, so refusing it would refuse ordinary documents over a reference no
 * browser would ever act on.
 *
 * The test is that EVERY token must be inert, which is what keeps
 * `rel="alternate stylesheet"` refused: an alternate stylesheet is still a
 * stylesheet, fetched on selection and preloaded by some browsers, so the
 * `stylesheet` token has to veto the inert `alternate` beside it.
 *
 * An allowlist rather than a denylist, so an unknown or newly minted `rel`
 * stays refused, and deliberately only the values a document was actually
 * observed to need. Absent on purpose: `preconnect` opens a TCP connection and
 * completes a TLS handshake, `dns-prefetch` resolves a third-party name, and
 * `prerender` fetches the document outright. None of them display anything, and
 * all three reach the network, which is the line that matters rather than
 * whether a subresource appears on the page.
 */
const INERT_LINK_RELS: Record<string, true> = Object.assign(
  Object.create(null),
  {
    canonical: true,
    alternate: true,
    license: true,
    prev: true,
    next: true,
    me: true,
  },
);

/**
 * True when `rel` names only inert relationships. An absent or empty `rel`
 * is NOT inert: a `link` with no relationship is a malformed reference rather
 * than a known-harmless one, and refusing it keeps the conservative default.
 */
function inertLink(rel: string | undefined): boolean {
  if (rel === undefined) return false;
  const tokens = rel.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  return tokens.every((token) => INERT_LINK_RELS[token] === true);
}

/** Records every `URL_ATTRS` attribute on one element that names something external. */
function collectAttributes(
  tag: string,
  attributes: Record<string, string>,
  stylesheet: boolean,
  found: Map<string, string>,
): void {
  for (const attr of URL_ATTRS[tag] ?? []) {
    const value = attributes[attr];
    if (value === undefined) continue;
    if (SRCSET_ATTRS[attr] === true) {
      for (const candidate of externalCandidates(value)) {
        addExternal(found, `${tag}[${attr}]`, candidate, stylesheet);
        if (found.size > MAX_FINDINGS) return;
      }
      continue;
    }
    if (isExternalRef(value)) {
      addExternal(found, `${tag}[${attr}]`, value, stylesheet);
      if (found.size > MAX_FINDINGS) return;
    }
  }
}

/** Records a refusal for every refusable reference on one element. */
function collectElement(node: Node, found: Map<string, string>): void {
  if (node.type !== ELEMENT_NODE) return;
  const tag = String(node.name).toLowerCase();
  const attributes = lowerAttributes(node.attributes);

  // From the declared `rel`, not inferred from the URL, so the stylesheet hint
  // states what the document says rather than what a path looks like.
  const rel = tag === "link" ? attributes["rel"] : undefined;
  const stylesheet =
    rel?.toLowerCase().split(/\s+/).includes("stylesheet") === true;

  // An inert `link` reaches the network through no attribute, so the whole
  // element is skipped rather than just its `href`: `imagesrcset` only fetches
  // under `rel=preload as=image`, which is not inert.
  if (tag !== "link" || !inertLink(rel)) {
    collectAttributes(tag, attributes, stylesheet, found);
    if (found.size > MAX_FINDINGS) return;
  }

  if (tag === "meta" && attributes["http-equiv"]?.toLowerCase() === "refresh") {
    const target = attributes["content"];
    if (target !== undefined) {
      const url = refreshTarget(target);
      if (url !== null && isExternalRef(url)) {
        addExternal(found, "meta[http-equiv=refresh]", url);
        if (found.size > MAX_FINDINGS) return;
      }
    }
  }

  // `srcdoc` carries a whole nested document whose own subresources would load
  // automatically. Its value is HTML-entity encoded, and ultrahtml does not
  // decode attribute entities - validating it recursively would mean writing an
  // entity decoder and trusting it as a security boundary. A standalone
  // document gains nothing from `srcdoc`, so it is rejected outright.
  if (tag === "iframe" && (attributes["srcdoc"] ?? "").trim() !== "") {
    const refusal = "nested document: iframe[srcdoc]";
    found.set(refusal, refusal);
    if (found.size > MAX_FINDINGS) return;
  }

  const inlineStyle = attributes["style"];
  if (inlineStyle !== undefined) {
    for (const target of externalInCss(inlineStyle)) {
      addExternal(found, `${tag}[style]`, target);
      if (found.size > MAX_FINDINGS) return;
    }
  }

  if (tag === "style") {
    for (const child of node.children ?? []) {
      if (child.type !== TEXT_NODE) continue;
      for (const target of externalInCss(String(child.value))) {
        addExternal(found, "style", target);
        if (found.size > MAX_FINDINGS) return;
      }
    }
  }
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
    return { ok: false, reasons: ["not valid UTF-8"], truncated: false };
  }

  const head = stripPreamble(text).slice(0, 64).toLowerCase();
  if (!head.startsWith("<!doctype html") && !head.startsWith("<html")) {
    return { ok: false, reasons: ["not an HTML document"], truncated: false };
  }

  const found = new Map<string, string>();
  try {
    // `walkSync` cannot be stopped from its callback, so the tree is traversed
    // either way; past the cap this stops validating rather than stops walking.
    walkSync(parse(text), (node) => {
      if (found.size > MAX_FINDINGS) return;
      collectElement(node, found);
    });
  } catch (cause) {
    // ultrahtml parses and walks recursively, so a document too deeply nested
    // overflows the stack rather than returning. What the parser cannot see
    // through, this check cannot vouch for, so that is an upload error rather
    // than a 500. Only that: every other exception is a defect in the collector
    // and is rethrown, because a bug reported as a refusal blames the document.
    if (!(cause instanceof RangeError)) throw cause;
    return {
      ok: false,
      reasons: ["could not parse document"],
      truncated: false,
    };
  }

  if (found.size === 0) return { ok: true };
  // Collecting one past the cap is what makes the flag precise: it reports
  // "there are more than these", never "there might be".
  const truncated = found.size > MAX_FINDINGS;
  const reasons = [...found.values()];
  return {
    ok: false,
    reasons: truncated ? reasons.slice(0, MAX_FINDINGS) : reasons,
    truncated,
  };
}
