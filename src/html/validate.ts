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
 */
const URL_ATTRS: Record<string, readonly string[]> = {
  script: ["src"],
  link: ["href"],
  img: ["src", "srcset"],
  source: ["src", "srcset"],
  iframe: ["src"],
  frame: ["src"],
  embed: ["src"],
  object: ["data"],
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
};

/** Attributes whose value is a comma-separated candidate list. */
const SRCSET_ATTRS: Record<string, true> = { srcset: true };

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

/** `url(...)` and `@import` targets inside CSS text or a style attribute. */
function findExternalInCss(css: string): string | null {
  const urlPattern = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;
  for (const match of css.matchAll(urlPattern)) {
    const target = match[2];
    if (target !== undefined && isExternalRef(target)) return target;
  }
  const importPattern = /@import\s+(['"])([^'"]*)\1/gi;
  for (const match of css.matchAll(importPattern)) {
    const target = match[2];
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
  const lowered: Record<string, string> = {};
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
  walkSync(parse(text), (node) => {
    if (reason !== null) return;
    reason = checkElement(node);
  });

  return reason === null ? { ok: true } : { ok: false, reason };
}
