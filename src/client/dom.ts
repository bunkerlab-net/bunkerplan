/**
 * React's synthetic events carried the element type in the handler signature,
 * so `event.target.value` type-checked. `hono/jsx` hands the DOM event through
 * untouched, where `target` is an `EventTarget | null` like the platform says
 * it is. Narrowing it once here keeps that difference out of every handler
 * rather than scattering casts through the panels.
 *
 * A throw rather than a null return: every call site is bound to a literal
 * form control in the same JSX, so anything else is a programming error and
 * not a condition worth branching on.
 */

/** The `<input>` an event fired on, for `.files`, `.blur()`, and assignment. */
export function inputOf(event: Event): HTMLInputElement {
  const node = event.target;
  if (!(node instanceof HTMLInputElement)) {
    throw new TypeError("handler is not bound to an input element");
  }
  return node;
}

/** The current value of whichever form control an event fired on. */
export function controlValue(event: Event): string {
  const node = event.target;
  if (
    node instanceof HTMLInputElement ||
    node instanceof HTMLSelectElement ||
    node instanceof HTMLTextAreaElement
  ) {
    return node.value;
  }
  throw new TypeError("handler is not bound to a form control");
}
