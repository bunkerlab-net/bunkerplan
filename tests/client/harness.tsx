import "./dom-env.ts";
import { afterEach, beforeEach } from "bun:test";
import { type Child, jsx, useState } from "hono/jsx";
import { render } from "hono/jsx/dom";

/**
 * Mounting and driving `hono/jsx` components on a real DOM.
 *
 * The panels are the half of this app a person actually touches, and every
 * one of them is a state machine over a network call: busy flags, refusal
 * text, optimistic rows that have to be rolled back. None of that is
 * reachable from a string render, so the suites here mount into happy-dom and
 * click.
 */

interface Entry {
  host: HTMLElement;
  hide: () => void;
}

const mounted: Entry[] = [];

/**
 * Whether the file whose test is running registered the teardown.
 *
 * `mounted` is module state shared by every suite in the process, so a file
 * that mounts without calling `useHarness()` leaves its trees in the list until
 * some other file's hook happens to sweep them - which is a panel from another
 * suite still answering `window` events, and a teardown running against stubs
 * that have already stood down.
 *
 * Set per test rather than once at module evaluation: a flag latched on import
 * would stay true for the rest of the process, so the first file to call
 * `useHarness()` would vouch for every file after it - which is the exact
 * cross-file leak this is meant to catch.
 */
let registered = false;

/**
 * Unmounts every tree this file mounted. Call it once, at the top of a suite
 * that mounts anything.
 *
 * Not a module-level `afterEach`, and that distinction is load-bearing: a
 * module is evaluated once per process, so a top-level hook binds to whichever
 * file imported the harness first and every later file silently gets no
 * teardown at all. Under `--isolate` each file has its own registry and the
 * bug is invisible; in one process it surfaces as a panel from three files ago
 * still answering `window` events.
 *
 * Register this before any stub arming, so trees come down while their stubs
 * are still standing in.
 */
export function useHarness(): void {
  beforeEach(() => {
    registered = true;
  });
  afterEach(async () => {
    try {
      const entries = mounted.splice(0);
      // `hono/jsx/dom` has no imperative unmount and dropping the host element
      // runs no effect teardown, so each tree is rendered away through its own
      // parent's state - which is what runs the cleanups.
      for (const entry of entries) entry.hide();
      if (entries.length > 0) await flush();
      for (const entry of entries) entry.host.remove();
    } finally {
      registered = false;
    }
  });
}

/**
 * Lets the renderer catch up.
 *
 * `hono/jsx/dom` defers effect callbacks to `requestAnimationFrame` and state
 * updates to a microtask, and an effect that sets state schedules another
 * round of both. Draining several turns is what makes "mount, then assert on
 * what the first fetch produced" work without sprinkling sleeps through the
 * assertions.
 */
export async function flush(turns = 6): Promise<void> {
  for (let turn = 0; turn < turns; turn++) {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        resolve();
      });
    });
    await Promise.resolve();
  }
}

/**
 * The queries are generic in the node type but unconstrained, and that is
 * deliberate: `@happy-dom/global-registrator` installs happy-dom's own
 * `HTMLSelectElement` and friends over the ones `lib.dom` declares, so a
 * `T extends Element` constraint compares two different `Element`s and
 * rejects every subtype. The cast is made once here rather than at each of
 * the several hundred call sites.
 */
export interface Mounted {
  host: HTMLElement;
  /** First match, or a throw naming the selector - never a silent `null`. */
  find: <T = HTMLElement>(selector: string) => T;
  all: <T = HTMLElement>(selector: string) => T[];
  /** The one element whose text contains `text`, first match wins. */
  byText: <T = HTMLElement>(selector: string, text: string) => T;
  maybe: <T = HTMLElement>(selector: string) => T | null;
  text: () => string;
}

export function mount(node: Child): Mounted {
  if (!registered) {
    throw new Error(
      "this file mounts but never called useHarness(), so nothing will unmount it",
    );
  }
  const host = document.createElement("div");
  document.body.appendChild(host);

  // The root exists only so the teardown above has something to render the
  // component away with; it adds no element of its own.
  let hide = (): void => {};
  // Returns `Child` rather than an element, which JSX cannot type - the point
  // is to render whatever it was handed, including a bare string.
  const Root = (): unknown => {
    const [shown, setShown] = useState(true);
    hide = () => setShown(false);
    return shown ? node : null;
  };

  mounted.push({ host, hide: () => hide() });
  render(jsx(Root as never, {}) as never, host);

  const all = (selector: string): HTMLElement[] => [
    ...host.querySelectorAll<HTMLElement>(selector),
  ];

  const find = <T,>(selector: string): T => {
    const node = host.querySelector(selector);
    if (node === null) {
      throw new Error(`no element matches ${selector} in:\n${host.innerHTML}`);
    }
    return node as T;
  };

  return {
    host,
    find,
    maybe: <T,>(selector: string) => host.querySelector(selector) as T | null,
    all: <T,>(selector: string) => all(selector) as T[],
    byText: <T,>(selector: string, text: string) => {
      const match = all(selector).find((node) =>
        (node.textContent ?? "").includes(text),
      );
      if (match === undefined) {
        throw new Error(
          `no ${selector} contains ${JSON.stringify(text)} in:\n${host.innerHTML}`,
        );
      }
      return match as T;
    },
    text: () => host.textContent ?? "",
  };
}

/** Mounts and lets the first round of effects settle. */
export async function mountAsync(node: Child): Promise<Mounted> {
  const view = mount(node);
  await flush();
  return view;
}

export async function click(node: Element): Promise<void> {
  node.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true }),
  );
  await flush();
}

/**
 * Activates a control the way a keyboard user does: focused first.
 *
 * Deliberately separate from `click`. Focus-on-pointer-click is not universal
 * - macOS Safari and Firefox do not focus a `<button>` when it is clicked -
 * so folding it into `click` would quietly assert a browser behaviour that
 * does not hold everywhere. `useExpandedPlan` restores focus by remembering
 * `document.activeElement`, which is a keyboard journey; this is how a test
 * says it means that one.
 */
export async function keyboardClick(node: HTMLElement): Promise<void> {
  node.focus();
  node.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true }),
  );
  await flush();
}

/**
 * Submits a form the way the runtime expects.
 *
 * `hono/jsx`'s intrinsic `form` intercepts `submit` and, for an untrusted
 * event, reads its action out of `event.detail`. A bare `Event` has none, so
 * the listener throws past the assertions and into the test runner's stderr
 * while the test still passes. A `CustomEvent` carrying a detail object is
 * what a synthetic submit has to be here.
 *
 * Returns the event, so a caller can check it was prevented.
 */
export async function submitForm(form: Element): Promise<Event> {
  const event = new CustomEvent("submit", {
    bubbles: true,
    cancelable: true,
    detail: {},
  });
  form.dispatchEvent(event);
  await flush();
  return event;
}

/**
 * A call the test releases by hand.
 *
 * The panels' busy flags only exist while a request is outstanding, so every
 * "held while in flight" assertion needs a call that is genuinely pending
 * rather than one that has already resolved.
 */
export function deferred<T>(): {
  answer: () => Promise<T>;
  release: (value: T) => void;
} {
  const { promise, resolve } = Promise.withResolvers<T>();
  return { answer: () => promise, release: resolve };
}

/**
 * Types into a controlled input.
 *
 * The value is assigned before the event so the handler's `event.target.value`
 * reads what was typed, which is how the panels' `controlValue` works.
 */
export async function type(
  node: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): Promise<void> {
  node.value = value;
  node.dispatchEvent(new Event("input", { bubbles: true }));
  node.dispatchEvent(new Event("change", { bubbles: true }));
  await flush();
}

export async function choose(
  node: HTMLSelectElement,
  value: string,
): Promise<void> {
  node.value = value;
  node.dispatchEvent(new Event("input", { bubbles: true }));
  node.dispatchEvent(new Event("change", { bubbles: true }));
  await flush();
}

/**
 * Fires a file-picker change with `files` populated.
 *
 * happy-dom's `HTMLInputElement.files` is read-only in the way the platform
 * says it is, so the list is installed as an own property. The panels only
 * ever read `.files`, which is what makes that enough.
 *
 * `input` as well as `change`, and that is not belt and braces: `hono/jsx`
 * aliases `onChange` onto the `input` event, so a handler written as
 * `onChange` is never reached by a `change` alone.
 */
export async function pickFiles(
  node: HTMLInputElement,
  files: File[],
): Promise<void> {
  // A copy: `Object.assign(files, ...)` would bolt `item` onto the caller's own
  // array, so the array a test still holds is no longer a plain one.
  const list = Object.assign([...files], {
    item: (i: number) => files[i] ?? null,
  });
  Object.defineProperty(node, "files", { configurable: true, value: list });
  node.dispatchEvent(new Event("input", { bubbles: true }));
  node.dispatchEvent(new Event("change", { bubbles: true }));
  await flush();
}

export function htmlFile(name = "plan.html", body = "<p>hi</p>"): File {
  return new File([`<!doctype html><html><body>${body}</body></html>`], name, {
    type: "text/html",
  });
}
