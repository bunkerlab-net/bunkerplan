/**
 * Standalone-HTML gate for uploads.
 *
 * WHAT THIS CANNOT DO: runtime `fetch`, `XMLHttpRequest`, `WebSocket`,
 * `EventSource`, and dynamic `import()` inside inline scripts are invisible to
 * static parsing. This check enforces "no static subresources", not "no network
 * access". The `Content-Security-Policy: sandbox` header on GET /{id} is the
 * runtime control, and it is what actually protects the uploader's session.
 *
 * `HTMLRewriter` is Workers-only and would behave differently under Bun, so a
 * JS parser does the work on both runtimes. It must be parser-equivalent to a
 * browser, because every difference is a reference the browser acts on and this
 * gate never mentioned. `parse5` is the spec reference implementation; the
 * `SAXParser` wrapper owns the `ParserFeedbackSimulator`, which is the part that
 * matters here - tokenising alone is not enough:
 *
 *   - `<image src=...>` is rewritten to `img`, so the reference has to be
 *     judged as `img[src]`. A bare tokeniser reports `image`, whose entry in
 *     `URL_ATTRS` is the SVG one and lists no `src` at all.
 *   - `title` and `textarea` hold text, not markup, so a `<img>` written inside
 *     one fetches nothing and must not be refused.
 *   - SVG and MathML change how the tokeniser reads what follows.
 *
 * Driven through `tokenizer.write(text, true)` rather than the stream API: the
 * whole document is already in memory, that call delivers every token AND the
 * EOF synchronously, and it keeps this function synchronous for its callers.
 *
 * Streaming rather than building a tree, because the tree is not affordable.
 * At the default 2 MiB `MAX_UPLOAD_BYTES`, a document of nothing but nested
 * tags costs ~135 MB of heap as a `parse5` tree, over the 128 MB a Worker gets,
 * and it is allocated inside `parse()` where no cap downstream can refuse it.
 * The same document streams in ~5 MB, because nesting depth costs a token
 * stream nothing. Nothing here accumulates per element: the only buffer is one
 * `<style>` block's text, bounded by the upload itself.
 */
import type { Token } from "parse5";
import { SAXParser, type StartTag } from "parse5-sax-parser";

type Attribute = Token.Attribute;

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

/** ASCII whitespace, which is what `srcset` and CSS both tokenise on. */
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
 * The CSS with its comments replaced by a space.
 *
 * Comments are token separators, so `@import/**` + `/"evil.css"` is a valid
 * import that no pattern anchored on `@import\s` would see. Removing them first
 * closes that whole class rather than one spelling of it, and keeps a comment
 * between a function name and its `(` from reading as a call.
 *
 * String-aware, because `/*` is ordinary text inside one. Scanning for `/*`
 * without checking let `content:"/*"` open a comment that never closed, which
 * discarded the rest of the stylesheet - and with it any reference below, which
 * a browser would still have fetched.
 *
 * Hand-scanned rather than regex-replaced: a lazy `[\s\S]*?` retried at every
 * unterminated `/*` is quadratic, and the input is attacker-supplied.
 */
function stripCssComments(css: string): string {
  if (!css.includes("/*")) return css;
  let out = "";
  let copied = 0;
  let index = 0;
  while (index < css.length) {
    const char = css[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === '"' || char === "'") {
      const end = endOfString(css, index);
      // The input ends inside a string, so no comment can open after it.
      if (end === -1) break;
      index = end + 1;
      continue;
    }
    if (char === "/" && css[index + 1] === "*") {
      out += `${css.slice(copied, index)} `;
      const end = css.indexOf("*/", index + 2);
      // Nothing closes it, so the rest of the input is commented out.
      if (end === -1) return out;
      index = end + 2;
      copied = index;
      continue;
    }
    index += 1;
  }
  return out + css.slice(copied);
}

/**
 * Index of the character that ends the CSS string opening at `open` - its
 * matching quote, or the newline that makes it a BAD string. -1 only when the
 * input runs out first.
 *
 * A CSS string cannot span an unescaped newline: the newline ends it and the
 * parser resumes on the next line. Treating an unterminated quote as running to
 * the end instead let a stylesheet hide behind one - everything after
 * `url("oops` was outside the scan, so an external reference on the next line
 * was never seen. Callers tell the two apart by looking at the character found.
 *
 * A backslash escapes the next character, so `"a\"b"` is one string, and a
 * backslash before a newline is a line continuation rather than a terminator.
 */
function endOfString(css: string, open: number): number {
  const quote = css[open];
  let index = open + 1;
  while (index < css.length) {
    const char = css[index];
    if (char === "\\") {
      // `\r\n` is one escaped newline, not an escaped `\r` beside a live `\n`.
      index += css[index + 1] === "\r" && css[index + 2] === "\n" ? 3 : 2;
      continue;
    }
    if (char === quote) return index;
    if (char === "\n" || char === "\r" || char === "\f") return index;
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
 * What an open `(` belongs to. Only these three change what a value means:
 * everything else - `calc(`, a selector's parentheses - is `PLAIN`.
 *
 * `IMPORT_URL` is not one `callKind` ever returns: it is the `url()` an
 * `@import` was waiting for, substituted where the frame is pushed, so the
 * stack itself remembers that the target is a stylesheet. Held there rather
 * than in a variable because a bad string voids every open call at once, and
 * a frame that no longer exists cannot go on speaking for a later `url()`.
 */
const PLAIN = 0;
const URL = 1;
const IMAGE_SET = 2;
const TYPE = 3;
const IMPORT_URL = 4;

/** CSS identifier characters, which a function name is made of. */
function identChar(code: number): boolean {
  return (
    (code >= 97 && code <= 122) ||
    (code >= 65 && code <= 90) ||
    (code >= 48 && code <= 57) ||
    code === 45 ||
    code === 95 ||
    code >= 128
  );
}

/**
 * What the function whose `(` sits at `paren` is, read from its WHOLE name.
 *
 * Matching a keyword against any offset instead made `myurl(https://host/x)`
 * a `url(` and `my-image-set(...)` an `image-set(`, refusing documents that
 * fetch nothing. Reading the name backwards also lets the vendor spelling be
 * named rather than caught by accident: `-webkit-image-set` shares its tail
 * with `image-set`, but so does `my-image-set`, and only one of them fetches.
 */
function callKind(css: string, paren: number): number {
  let start = paren;
  while (start > 0 && identChar(css.charCodeAt(start - 1))) start -= 1;
  const name = css.slice(start, paren).toLowerCase();
  if (name === "url") return URL;
  if (name === "image-set" || name === "-webkit-image-set") return IMAGE_SET;
  if (name === "type") return TYPE;
  return PLAIN;
}

/** The target a `url()` names, with a quoted value unwrapped. */
function urlTarget(span: string): string {
  const trimmed = span.trim();
  const quote = trimmed.charAt(0);
  return (quote === '"' || quote === "'") && trimmed.endsWith(quote)
    ? trimmed.slice(1, -1)
    : trimmed;
}

/**
 * A target found in CSS, and whether an `@import` is what named it. The two
 * need different answers: an `@import` is a stylesheet to be inlined, and a
 * `url()` in a declaration is the image or face it points at.
 */
type CssRef = { target: string; stylesheet: boolean };

/**
 * The reference the call closing at `paren` named, or null when it named none:
 * an unclosed frame, any call that is not a `url()`, or a target that travels
 * inside the document.
 */
function closedRef(
  css: string,
  paren: number,
  open: number[],
  starts: number[],
): CssRef | null {
  const start = starts.pop();
  const kind = open.pop();
  if ((kind !== URL && kind !== IMPORT_URL) || start === undefined) return null;
  const target = urlTarget(css.slice(start, paren));
  if (!isExternalRef(target)) return null;
  return { target, stylesheet: kind === IMPORT_URL };
}

/**
 * An `@import` at-rule opens at `index`. Its name has to end where it looks
 * like it does, or `@important` would read as one.
 */
function importAt(css: string, index: number): boolean {
  return (
    startsWithAt(css, "@import", index) &&
    !identChar(css.charCodeAt(index + "@import".length))
  );
}

/**
 * Whether a quoted string is the next thing after `index`, past whitespace.
 *
 * What arms an `@import`, so only an at-rule that really is followed by a
 * target waits for one. `@import foo;` names nothing, and leaving the wait
 * armed made the next string anywhere in the stylesheet its target: a plain
 * `content:"https://host/x"` several rules later was reported as an import.
 */
function quotedTargetFollows(css: string, index: number): boolean {
  let at = index;
  while (at < css.length && SPACE.includes(css[at] as string)) at += 1;
  const char = css[at];
  return char === '"' || char === "'";
}

/**
 * Whether a `url(` call is the next thing after `index`, past whitespace.
 *
 * The other half of what an `@import` can name, and armed the same way and for
 * the same reason as a quoted one: `@import screen;` names nothing, and a wait
 * left armed would hand the next `url()` anywhere in the stylesheet a
 * stylesheet's answer. Exact rather than a guess, because CSS puts nothing
 * between a function name and its `(`.
 */
function urlCallFollows(css: string, index: number): boolean {
  let at = index;
  while (at < css.length && SPACE.includes(css[at] as string)) at += 1;
  return startsWithAt(css, "url", at) && css[at + 3] === "(";
}

/**
 * Yields the target the string spanning `index` to `end` names, and returns
 * whether an `@import` is still waiting for one.
 *
 * A string names something only as an `@import` target or an `image-set()`
 * candidate. Inside `url()` the whole span is the target and is read when the
 * call closes; inside `type()` it is a MIME type; anywhere else it is text.
 * A bad string - one a newline ended - voids the calls open around it.
 *
 * `importing` therefore also says WHICH of the two this is: a call opening
 * clears it, so an `image-set()` candidate never arrives with it still set.
 */
function* stringAt(
  css: string,
  index: number,
  end: number,
  importing: boolean,
  open: number[],
  starts: number[],
): Generator<CssRef, boolean> {
  if (css[end] !== css[index]) {
    open.length = 0;
    starts.length = 0;
    return false;
  }
  if (!importing && open[open.length - 1] !== IMAGE_SET) return importing;
  const text = css.slice(index + 1, end);
  if (isExternalRef(text)) yield { target: text, stylesheet: importing };
  return false;
}

/**
 * Pushes the frame the `(` at `paren` opens, and returns the kind of call it
 * is - which is `URL` even where the frame was pushed as `IMPORT_URL`, because
 * what an `@import` is waiting for changes nothing about how the value reads.
 */
function openCall(
  css: string,
  paren: number,
  open: number[],
  starts: number[],
  awaitingUrl: boolean,
): number {
  const kind = callKind(css, paren);
  // The `url()` an `@import` was waiting for carries the at-rule with it, so
  // the refusal can say to inline the stylesheet rather than only that
  // something outside was named.
  open.push(kind === URL && awaitingUrl ? IMPORT_URL : kind);
  starts.push(paren + 1);
  return kind;
}

/**
 * Every target in CSS text that points outside the document, in order.
 *
 * ONE pass with a stack of open calls, because separate keyword scans could not
 * agree on what was a value and what was text. Each mistake that removes was a
 * real one:
 *
 * - `content:"url(https://host/x)"` was refused. A string is text; nothing is
 *   fetched from one. A scan that did not know whether an offset sat inside a
 *   string could not tell, and even `"see url(/docs) for more"` was refused.
 * - `url(data:...` left unclosed swallowed the rest of the file, so a real
 *   reference below it went unseen. Here an unclosed call simply never pops and
 *   the scan carries on.
 * - A bad string - one a newline ends, which CSS does not allow - voids its
 *   declaration, so it drops the calls around it and resumes on the next line,
 *   which is what a browser does.
 *
 * What it still cannot see is a name spelled with CSS escapes: `u\72l(...)`
 * fetches in a browser and reads as an unknown function here. That is the
 * documented boundary of this check rather than an oversight - see `PLAN_CSP`
 * in src/http/security-headers.ts, whose `default-src 'none'` is what actually
 * stops a plan fetching.
 *
 * Linear by construction: the index only moves forward, and a string is walked
 * once by `endOfString` before the scan resumes past it.
 */
function* externalInCss(rawCss: string): Generator<CssRef> {
  const css = stripCssComments(rawCss);
  const open: number[] = [];
  // Where each open call's value begins, pushed and popped beside `open`.
  const starts: number[] = [];
  // Set by `@import`, cleared by the target it takes or by the next call.
  let importing = false;
  // Set by an `@import` that named a `url()`, cleared by that call opening.
  let awaitingUrl = false;
  let index = 0;

  while (index < css.length) {
    const char = css[index];

    if (char === "\\") {
      index += 2;
      continue;
    }

    if (char === '"' || char === "'") {
      const end = endOfString(css, index);
      // The input ended inside a string, so nothing after it is readable.
      if (end === -1) return;
      importing = yield* stringAt(css, index, end, importing, open, starts);
      index = end + 1;
      continue;
    }

    if (char === "(") {
      const kind = openCall(css, index, open, starts, awaitingUrl);
      awaitingUrl = false;
      // `type()` carries no target, so an `@import` is still waiting after it.
      if (kind !== TYPE) importing = false;
      index += 1;
      continue;
    }

    if (char === ")") {
      const ref = closedRef(css, index, open, starts);
      if (ref !== null) yield ref;
      index += 1;
      continue;
    }

    if (char === "@" && importAt(css, index)) {
      // Either spelling names the target; they arrive at different frames.
      index += "@import".length;
      importing = quotedTargetFollows(css, index);
      awaitingUrl = urlCallFollows(css, index);
      continue;
    }

    index += 1;
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
 * Hints are clauses appended to a refusal, joined by `; ` after a single dash.
 *
 * Four signals, each naming only what it supports. Two are declared by the
 * reference - `rel="stylesheet"` and a CSS `@import` are stylesheets, and
 * `as="font"` is a face whatever its URL looks like, which is the only way to
 * place a signed or extensionless font URL. Two are read from the target: a
 * path ending in a font extension IS a face, and a target that says `fonts` in
 * a host label or a path segment - `fonts.googleapis.com`,
 * `fonts.gstatic.com`, `/fonts/faces.css` - serves fonts without being one.
 *
 * That last one is read on three references and nowhere else. A stylesheet -
 * `rel="stylesheet"` or `@import` - can be a font stylesheet, and a
 * `rel="preconnect"` or `rel="dns-prefetch"` names a HOST rather than a
 * resource, which is the whole ambiguity: `fonts.gstatic.com` is what a
 * document warms up before fetching faces from it. Every other reference has
 * already said what it is - an `img`, a `script`, a `rel="icon"`, a
 * `rel="preload" as="image"`, a `url()` in a declaration - and
 * `<img src="/fonts/logo.png">` is an image sitting in a directory, whose
 * author would be answered with advice about a font they do not have.
 *
 * A face gets the font clause alone: there is no CSS at that URL to inline.
 * Anything merely font-NAMED joins rather than replaces, because a font
 * stylesheet has to be inlined AND have its faces embedded.
 *
 * The size is in the clause because the refusal is where the wrong conclusion
 * gets drawn. Told only that a font cannot be linked, a caller - a coding
 * agent especially - weighs embedding against the upload limit, guesses that
 * a typeface is megabytes, and drops the fonts instead. A latin subset of a
 * variable face is about 65 KB encoded, which settles that guess in the one
 * place it is made. The recipe stays in the docs, where it can be a worked
 * example rather than a paragraph appended to every refusal.
 */
const FONT_FILE = /\.(?:woff2?|[ot]tf|eot)(?:[?#]|$)/i;
const NAMES_FONTS = /(?:^|[./])fonts?(?:[./?#]|$)/i;
const FONT_HINT =
  "embed fonts as data: URIs in @font-face (a latin subset costs about 65 KB)";
const STYLESHEET_HINT = "inline the stylesheet";

/**
 * What the reference said it was. `HOST_ONLY` is a `link` that named a host
 * and no resource, which with a stylesheet is where a font-named target is
 * read. `DECLARED_STYLESHEET` covers a `rel="stylesheet"` and a CSS `@import`
 * alike: both are CSS that has to come inside the document.
 */
const UNDECLARED = 0;
const HOST_ONLY = 1;
const DECLARED_STYLESHEET = 2;
const DECLARED_FACE = 3;

/**
 * `flat` cut to `MAX_TARGET_LENGTH` characters for display, with an ellipsis
 * when it was longer.
 *
 * Counted in code points, so the cut never lands inside a surrogate pair: half
 * a pair survives `JSON.stringify` as a `\ud800` escape and renders as a
 * replacement glyph, leaving a target the uploader cannot search for. Stops at
 * the limit rather than walking the value, which can be nearly as long as the
 * upload.
 */
function forDisplay(flat: string): string {
  let end = 0;
  let characters = 0;
  for (const character of flat) {
    if (characters === MAX_TARGET_LENGTH) return `${flat.slice(0, end)}...`;
    end += character.length;
    characters += 1;
  }
  return flat;
}

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
  declared: number = UNDECLARED,
): void {
  const flat = target.replace(UNPRINTABLE, " ").trim();
  // Classified from the whole target, truncated only for display: a `.woff2`
  // sitting past the cut is still a font, and a long URL is exactly when the
  // caller needs to be told so.
  const clauses: string[] = [];
  if (declared === DECLARED_FACE || FONT_FILE.test(flat)) {
    clauses.push(FONT_HINT);
  } else {
    if (declared === DECLARED_STYLESHEET) clauses.push(STYLESHEET_HINT);
    // A font-named target is only read where the reference is a stylesheet or
    // a `link` that named a host - never where it said what it fetches.
    if (declared !== UNDECLARED && NAMES_FONTS.test(flat)) {
      clauses.push(FONT_HINT);
    }
  }
  const hint = clauses.length === 0 ? "" : ` - ${clauses.join("; ")}`;
  const shown = forDisplay(flat);
  const full = `external reference: ${location} ${flat}${hint}`;
  found.set(full, `external reference: ${location} ${shown}${hint}`);
}

/**
 * The tokeniser's attribute list as a lookup keyed by qualified name.
 *
 * Names are folded to lower case for the same reason the tag name is: the
 * tokeniser lowercases them, but inside SVG the parser then restores camelCase
 * spellings such as `viewBox`, and a `URL_ATTRS` entry that ever landed in that
 * map would stop matching silently.
 *
 * `prefix` is rejoined because that is the name `URL_ATTRS` lists: inside SVG
 * the parser splits `xlink:href` into a prefix and a name, and dropping the
 * prefix would leave a bare `href` that matches the wrong entry.
 *
 * First occurrence wins, which is what a browser does with a repeated
 * attribute. Taking the last would let `<img src="EXT" src="data:,">` hide the
 * reference the browser actually fetches behind an inert one.
 *
 * Null-prototype for the same reason as `URL_ATTRS`: the keys come from the
 * document, so `__proto__` on a plain literal would not be an ordinary entry.
 */
function attributeMap(attrs: readonly Attribute[]): Record<string, string> {
  const map: Record<string, string> = Object.create(null);
  for (const attr of attrs) {
    const name = (
      attr.prefix === undefined ? attr.name : `${attr.prefix}:${attr.name}`
    ).toLowerCase();
    if (name in map) continue;
    map[name] = attr.value;
  }
  return map;
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
  declared: number,
  found: Map<string, string>,
): void {
  for (const attr of URL_ATTRS[tag] ?? []) {
    const value = attributes[attr];
    if (value === undefined) continue;
    if (SRCSET_ATTRS[attr] === true) {
      for (const candidate of externalCandidates(value)) {
        addExternal(found, `${tag}[${attr}]`, candidate, declared);
        if (found.size > MAX_FINDINGS) return;
      }
      continue;
    }
    if (isExternalRef(value)) {
      addExternal(found, `${tag}[${attr}]`, value, declared);
      if (found.size > MAX_FINDINGS) return;
    }
  }
}

/** What a `link` says its own reference is: a face, a stylesheet, or a host. */
function declaredBy(attributes: Record<string, string>): number {
  if (attributes["as"]?.toLowerCase() === "font") return DECLARED_FACE;
  const tokens = attributes["rel"]?.toLowerCase().split(/\s+/) ?? [];
  if (tokens.includes("stylesheet")) return DECLARED_STYLESHEET;
  // An opt-in pair rather than everything left over: `rel=icon` and
  // `rel=preload as=image` have named a resource, and a font-named target
  // does not overrule them.
  const host = tokens.includes("preconnect") || tokens.includes("dns-prefetch");
  return host ? HOST_ONLY : UNDECLARED;
}

/** Records a refusal for every refusable reference on one start tag. */
function collectStartTag(tag: StartTag, found: Map<string, string>): void {
  const attributes = attributeMap(tag.attrs);
  // Inside SVG the parser restores the camelCase spelling of the real element -
  // `feimage` arrives as `feImage`, `textpath` as `textPath` - so the name is
  // folded back to match how `URL_ATTRS` is keyed and how refusals have always
  // read. ASCII-only in practice: the tokeniser has already lowered everything
  // else, and these adjustments introduce ASCII capitals and nothing more.
  const name = tag.tagName.toLowerCase();

  // From what the element declared, not inferred from the URL. `as="font"`
  // is how a `<link rel="preload">` names a face whose URL says nothing -
  // signed, hashed, or extensionless - and it outranks `rel` because a face
  // is a face however it was linked.
  const rel = name === "link" ? attributes["rel"] : undefined;
  const declared = name === "link" ? declaredBy(attributes) : UNDECLARED;

  // An inert `link` reaches the network through no attribute, so the whole
  // element is skipped rather than just its `href`: `imagesrcset` only fetches
  // under `rel=preload as=image`, which is not inert.
  if (name !== "link" || !inertLink(rel)) {
    collectAttributes(name, attributes, declared, found);
    if (found.size > MAX_FINDINGS) return;
  }

  if (
    name === "meta" &&
    attributes["http-equiv"]?.toLowerCase() === "refresh"
  ) {
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
  // automatically. Its value arrives HTML-entity DECODED here, but validating
  // it would mean re-entering the parser on uploader-controlled markup and
  // trusting that recursion as a security boundary. A standalone document gains
  // nothing from `srcdoc`, so it is rejected outright.
  if (name === "iframe" && (attributes["srcdoc"] ?? "").trim() !== "") {
    const refusal = "nested document: iframe[srcdoc]";
    found.set(refusal, refusal);
    if (found.size > MAX_FINDINGS) return;
  }

  const inlineStyle = attributes["style"];
  if (inlineStyle !== undefined) {
    for (const ref of externalInCss(inlineStyle)) {
      const kind = ref.stylesheet ? DECLARED_STYLESHEET : UNDECLARED;
      addExternal(found, `${name}[style]`, ref.target, kind);
      if (found.size > MAX_FINDINGS) return;
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

/**
 * `SAXParser` keeps its tokenizer `protected`, and a subclass is how that access
 * is meant to be had. Everything the gate needs is already in memory, so the
 * stream API buys nothing and costs the one thing that matters: `end()` defers
 * `_final`, and `_final` is where EOF - and with it the last pending text - is
 * delivered. A document ending inside an unclosed `<style>` would have its CSS
 * arrive after the verdict had been returned.
 */
class DocumentScanner extends SAXParser {
  /** Every token, and the EOF, delivered before this returns. */
  scan(text: string): void {
    this.tokenizer.write(text, true);
  }

  /**
   * Whether the simulator believes it is inside SVG or MathML. Everything about
   * how the rest of the document is read follows from it: raw-text elements,
   * the `<image>` to `img` rewrite, SVG name and attribute adjustment, and
   * whether a `<style>` bears a stylesheet.
   */
  get inForeignContent(): boolean {
    return this.parserFeedbackSimulator.inForeignContent;
  }
}

/**
 * The simulator's namespace no longer matches the document's.
 *
 * It enters SVG on `<svg>` whether or not the tag closed itself, and it leaves
 * only when an end tag matches its innermost entry, where a browser pops until
 * one matches. So `<svg/>` leaves it in SVG for the rest of the document, and
 * `<svg><math></svg>` leaves it in MathML, and from there EVERYTHING downstream
 * is read wrong: raw-text elements are read as markup, `<image>` is not rewritten
 * to `img` so its `src` is never checked, SVG name and attribute adjustment is
 * applied to HTML.
 *
 * Each of those could be corrected one at a time; the list is the reason not to.
 * Where the parse has stopped describing the document, a verdict about the
 * document is not worth giving, so this says so instead. It costs nothing real:
 * the trigger is a self-closed `<svg/>` or `<math/>`, or foreign end tags that
 * cross, and both have a plain spelling that is not affected.
 */
const DIVERGED_NAMESPACE =
  "unsupported nesting: a self-closing <svg/> or <math/>, or crossed svg/math " +
  "end tags - give each one its own end tag";

/**
 * An SVG `<style>` holding anything this cannot account for.
 *
 * Refused rather than half-scanned: see `StyleText`. Deliberately vague about
 * WHAT the markup is, because the two triggers differ - a child element, or an
 * end tag that may be closing an ancestor or may be stray - and naming one of
 * them would misdescribe the other. The instruction is the useful part, and it
 * is the same either way.
 */
const UNACCOUNTABLE_STYLE =
  "unsupported markup inside an svg style - keep the stylesheet to text only";

/**
 * The CSS of the `<style>` element currently open.
 *
 * A stylesheet is the element's CHILD text content - "the child text content of
 * a style element must be that of a conformant style sheet" - its direct
 * text-node children and nothing deeper. Aggregating descendant text instead
 * lets markup fabricate a reference no browser parses, because
 * `<style>a{background:u<g>rl("...")</g>}</style>` has child text content
 * `a{background:u}`, with no `url(` in it anywhere.
 *
 * Text-only styles are therefore exact, and that is every style anyone writes.
 * An element opening inside an SVG one is refused instead, because the direct
 * text AFTER it cannot be accounted for without knowing where the element ends,
 * and inside an `<foreignObject>` island that is HTML tree construction: special
 * elements blocking an unmatched end tag, implied end tags, the adoption agency.
 * Matching end tags by name looks close and is not - in
 * `<svg><style>a{}<foreignObject><div/></foreignObject>b{url(...)}</style>`
 * HTML ignores the slash on `<div>`, so `</foreignObject>` is blocked by it and
 * `b{...}` lands inside the `<div>`, outside the stylesheet entirely. Refusing
 * says so; guessing either invented a reference or hid one.
 *
 * An end tag needs none of that. Whatever closes the element - `</style>`,
 * `</svg>`, anything - the child text is already complete, because collection
 * would have stopped at a child element.
 *
 * Buffered whole rather than scanned per event, because text arrives in as many
 * pieces as the tokeniser cares to emit and `url(` can straddle any two.
 */
class StyleText {
  /** The open element's CSS so far, or null when none is collecting. */
  private css: string | null = null;
  /**
   * Innermost SVG or MathML root, which decides whether a foreign `<style>`
   * bears a stylesheet at all. SVG has one; MathML does not - its styling
   * element is `mstyle`, so an element merely named `style` there is ordinary
   * foreign content and its text is not CSS.
   *
   * Kept as runs rather than one entry per element, because only the innermost
   * name is ever read and `<svg>` nests to whatever depth an uploader likes: a
   * 2 MiB document of nothing else held 400,000 entries and 31 MB.
   */
  private roots: { name: string; depth: number }[] = [];
  /**
   * Elements open per tracked name, so an end tag is classified in constant time.
   * Scanning `roots` instead was quadratic: alternating names never collapse into
   * runs, so every stray end tag walked one entry per open element.
   */
  private svgOpen = 0;
  private mathOpen = 0;

  /**
   * True when no SVG or MathML root is open, so the document is in HTML content
   * and its raw-text elements are raw text - whatever the simulator's namespace
   * flag has been left saying.
   */
  get inHtmlContent(): boolean {
    return this.roots.length === 0;
  }

  private get root(): string | undefined {
    return this.roots.at(-1)?.name;
  }

  constructor(
    /** Called with the child text content of each `<style>`, once it ends. */
    private readonly onBlock: (css: string) => void,
    /** Called when an element inside an SVG `<style>` makes it unaccountable. */
    private readonly onUnaccountable: () => void,
  ) {}

  /**
   * A start tag. Any tag ends the text this can vouch for, and a `<style>` then
   * begins the next block.
   *
   * The self-closing slash is where the namespaces part. HTML ignores it on a
   * non-void element and the tokeniser enters raw text regardless, so `<style/>`
   * there holds every byte up to `</style>`. SVG honours it, so `<svg><style/>`
   * is empty and the text after it belongs to the SVG.
   */
  startTag(tag: StartTag, inForeignContent: boolean): void {
    // A tag arriving while a block is open proves the block was never raw text:
    // raw text hides every tag from the tokeniser, which is the point of it. So
    // this covers the SVG `<style>` that is ordinary markup AND the one the
    // simulator left in the wrong namespace, where `<style>` is HTML but never
    // switched to RAWTEXT and a `<` in the CSS emits a start tag of its own.
    const unaccountable = this.css !== null;
    this.end();
    if (unaccountable) this.onUnaccountable();

    if (tag.tagName === "svg" || tag.tagName === "math") {
      if (!tag.selfClosing) this.pushRoot(tag.tagName);
      return;
    }
    if (tag.tagName !== "style") return;
    if (!inForeignContent) {
      // Raw text, at the top level or inside an integration point.
      this.css = "";
      return;
    }
    if (tag.selfClosing) return;
    if (this.root === "svg") this.css = "";
  }

  append(chunk: string): void {
    if (this.css !== null) this.css += chunk;
  }

  /**
   * An end tag.
   *
   * `</style>` completes the block, and so does the end tag of any SVG or MathML
   * root the element sits inside - both say exactly where the child text stopped.
   * Any other end tag does not: `</g>` may close an ancestor of the `<style>`, or
   * may be stray and ignored, in which case the CSS carries on past it. Only the
   * foreign roots are tracked, so the two cannot be told apart, and the document
   * is refused rather than half-scanned.
   */
  endTag(tagName: string): void {
    const closesRoot = this.opened(tagName);
    const ambiguous = this.css !== null && tagName !== "style" && !closesRoot;
    this.end();
    if (ambiguous) this.onUnaccountable();
    if (closesRoot) this.closeRoot(tagName);
  }

  /** Whether an element of this name is open. False for every untracked name. */
  private opened(name: string): boolean {
    if (name === "svg") return this.svgOpen > 0;
    if (name === "math") return this.mathOpen > 0;
    return false;
  }

  /** Only ever called with a tracked name, from `pushRoot` and `closeRoot`. */
  private count(name: string, by: number): void {
    if (name === "svg") this.svgOpen += by;
    else this.mathOpen += by;
  }

  private pushRoot(name: string): void {
    this.count(name, 1);
    const innermost = this.roots.at(-1);
    if (innermost?.name === name) innermost.depth += 1;
    else this.roots.push({ name, depth: 1 });
  }

  /**
   * Closes the innermost root of this name AND everything opened inside it, the
   * way a parser pops until the name matches: `<svg><math></svg>` leaves neither
   * open.
   *
   * Entered only when `opened` says the name is there, so the search always
   * finds it and every entry it passes is one it drops. Each element is pushed
   * once and dropped once, so the whole document costs a walk of its elements.
   */
  private closeRoot(name: string): void {
    for (let index = this.roots.length - 1; index >= 0; index -= 1) {
      const run = this.roots[index];
      if (run === undefined || run.name !== name) continue;
      for (let above = index; above < this.roots.length; above += 1) {
        const dropped = this.roots[above];
        if (dropped !== undefined) this.count(dropped.name, -dropped.depth);
      }
      this.roots.length = index;
      if (run.depth > 1) {
        this.roots.push({ name, depth: run.depth - 1 });
        this.count(name, run.depth - 1);
      }
      return;
    }
  }

  /** Reports the block still open, if any. Also the end of input. */
  end(): void {
    if (this.css === null) return;
    const css = this.css;
    this.css = null;
    this.onBlock(css);
  }
}

/** Records every refusable reference in the document. */
function scanDocument(text: string, found: Map<string, string>): void {
  const parser = new DocumentScanner();

  /** Past the cap the remaining bytes cannot change the verdict. */
  const capped = (): boolean => {
    if (found.size <= MAX_FINDINGS) return false;
    parser.stop();
    return true;
  };

  const style = new StyleText(
    (css) => {
      for (const ref of externalInCss(css)) {
        const kind = ref.stylesheet ? DECLARED_STYLESHEET : UNDECLARED;
        addExternal(found, "style", ref.target, kind);
        if (capped()) return;
      }
    },
    () => {
      found.set(UNACCOUNTABLE_STYLE, UNACCOUNTABLE_STYLE);
      capped();
    },
  );

  /**
   * One-way on purpose. `roots` empty while the simulator still says foreign
   * means it never left, and nothing after that point is read as the document
   * says. The reverse - roots open while the simulator says HTML - is ordinary
   * and correct: that is an integration point such as `<foreignObject>`, whose
   * content IS HTML inside a subtree that is still open.
   */
  const diverged = (): boolean => {
    if (!style.inHtmlContent || !parser.inForeignContent) return false;
    found.set(DIVERGED_NAMESPACE, DIVERGED_NAMESPACE);
    // Nothing further can be trusted, so nothing further is read.
    parser.stop();
    return true;
  };

  parser.on("startTag", (tag) => {
    style.startTag(tag, parser.inForeignContent);
    if (diverged()) return;
    collectStartTag(tag, found);
    capped();
  });

  parser.on("text", (token) => {
    style.append(token.text);
  });

  parser.on("endTag", (tag) => {
    style.endTag(tag.tagName);
    diverged();
  });

  parser.scan(text);
  // A `<style>` left unclosed never sees an end tag, and a browser applies its
  // CSS regardless, so whatever is still open is reported at EOF.
  style.end();
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

  // Deliberately not wrapped in a catch that refuses the upload. There is no
  // exception left for one to handle: the tokeniser is error-tolerant by spec and
  // reports malformed input as tokens rather than throwing, the scan is iterative
  // so no depth overflows a stack, and the collectors do string work on values
  // already in hand. What a blanket catch WOULD cover is a defect in this file,
  // reported to the uploader as a fault in their document - which is worse than a
  // 500, because a 500 is a signal and a false refusal sends them looking for
  // something that is not there. The recursive parser that could overflow, and
  // the `could not parse document` refusal that admitted it, are both gone.
  const found = new Map<string, string>();
  scanDocument(text, found);

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
