import "./dom-env.ts";
import { describe, expect, test } from "bun:test";
import { controlValue, inputOf } from "../../src/client/dom.ts";
import { messageOf } from "../../src/client/errors.ts";

/**
 * The two helpers every panel routes its failures and its form reads through.
 * Small, and worth pinning exactly because of it: `messageOf` decides what a
 * person is told when something goes wrong, and its whole reason for existing
 * is the shapes that would otherwise render as "[object Object]" or as an
 * empty line.
 */

const FALLBACK = "could not do the thing";

describe("messageOf", () => {
  test("an Error's own message wins", () => {
    expect(messageOf(new Error("disk is full"), FALLBACK)).toBe("disk is full");
  });

  test("a subclass is still an Error", () => {
    expect(messageOf(new TypeError("bad input"), FALLBACK)).toBe("bad input");
  });

  test("an Error with an empty message falls back rather than blanking the line", () => {
    expect(messageOf(new Error(""), FALLBACK)).toBe(FALLBACK);
  });

  test("Better Auth's plain { message } shape is read", () => {
    expect(messageOf({ message: "passkey not recognised" }, FALLBACK)).toBe(
      "passkey not recognised",
    );
  });

  test("a { message } that is empty falls back", () => {
    expect(messageOf({ message: "" }, FALLBACK)).toBe(FALLBACK);
  });

  test("a message of only whitespace falls back, because it renders blank", () => {
    expect(messageOf(new Error("   "), FALLBACK)).toBe(FALLBACK);
    expect(messageOf({ message: "\n\t " }, FALLBACK)).toBe(FALLBACK);
  });

  test("a padded message is kept, not trimmed on the way out", () => {
    // The trim decides whether there is anything to show, and nothing more: the
    // message is relayed as the thrower wrote it. Trimming the returned value
    // would quietly edit an operator-facing string this only has to carry.
    expect(messageOf(new Error("  disk is full\n"), FALLBACK)).toBe(
      "  disk is full\n",
    );
  });

  test("a non-string message is not rendered", () => {
    expect(messageOf({ message: 404 }, FALLBACK)).toBe(FALLBACK);
  });

  test("an Error whose message is not a string falls back rather than throwing", () => {
    // `Error.message` is writable. Calling `trim()` on a replaced one would
    // throw from inside the catch handler that was reporting the failure.
    const mutated = new Error("original");
    (mutated as { message: unknown }).message = 500;

    expect(messageOf(mutated, FALLBACK)).toBe(FALLBACK);
  });

  test("an object with no message would be [object Object], so it falls back", () => {
    expect(messageOf({ code: "NOPE" }, FALLBACK)).toBe(FALLBACK);
  });

  test("null does not throw on the `in` check", () => {
    expect(messageOf(null, FALLBACK)).toBe(FALLBACK);
  });

  test("primitives fall back", () => {
    expect(messageOf(undefined, FALLBACK)).toBe(FALLBACK);
    expect(messageOf("a bare string", FALLBACK)).toBe(FALLBACK);
    expect(messageOf(42, FALLBACK)).toBe(FALLBACK);
  });

  test("a message inherited from the prototype chain is still a message", () => {
    // `in` walks the chain, which is the behaviour a thrown class instance
    // with a getter relies on.
    const cause = Object.create({ message: "from the prototype" }) as unknown;
    expect(messageOf(cause, FALLBACK)).toBe("from the prototype");
  });
});

/** An event whose `target` is `node`, which is what a real dispatch gives. */
function eventOn(node: EventTarget): Event {
  const event = new Event("change");
  Object.defineProperty(event, "target", { value: node });
  return event;
}

describe("inputOf", () => {
  test("returns the input the event fired on", () => {
    const node = document.createElement("input");
    expect(inputOf(eventOn(node))).toBe(node);
  });

  test("a select is not an input, and that is a programming error", () => {
    const node = document.createElement("select");
    expect(() => inputOf(eventOn(node))).toThrow(TypeError);
  });

  test("an event with no target throws rather than returning null", () => {
    expect(() => inputOf(new Event("change"))).toThrow(
      "handler is not bound to an input element",
    );
  });
});

describe("controlValue", () => {
  test("reads an input", () => {
    const node = document.createElement("input");
    node.value = "typed";
    expect(controlValue(eventOn(node))).toBe("typed");
  });

  test("reads a select", () => {
    const node = document.createElement("select");
    const option = document.createElement("option");
    option.value = "2";
    node.appendChild(option);
    node.value = "2";
    expect(controlValue(eventOn(node))).toBe("2");
  });

  test("reads a textarea", () => {
    const node = document.createElement("textarea");
    node.value = "several\nlines";
    expect(controlValue(eventOn(node))).toBe("several\nlines");
  });

  test("a button is not a form control this reads", () => {
    const node = document.createElement("button");
    expect(() => controlValue(eventOn(node))).toThrow(
      "handler is not bound to a form control",
    );
  });

  test("an event with no target throws", () => {
    expect(() => controlValue(new Event("change"))).toThrow(TypeError);
  });
});
