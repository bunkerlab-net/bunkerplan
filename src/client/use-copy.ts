import { useState } from "hono/jsx";

/**
 * Puts a value on the clipboard, and says so when it could not.
 *
 * `navigator.clipboard.writeText` rejects on a denied permission or an insecure
 * context, and the whole API is absent on an older browser - so reading it can
 * throw where the handler runs, not only reject. Both paths matter here because
 * both callers are showing a secret exactly once: an API key at the moment it
 * is minted, and a share link carrying a code that is never readable again.
 *
 * A copy that quietly did nothing would take the only copy with it. The value
 * is on screen either way, so the fallback is to say so rather than to retry.
 */
export function useCopy(value: string): {
  copy: () => void;
  copyFailed: boolean;
} {
  const [failedFor, setFailedFor] = useState<string | null>(null);

  const copy = () => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(value);
        // Only this attempt's own value. A copy of the previous secret can
        // still be in flight when a new one is on screen, and clearing
        // unconditionally would let it hide a failure it knows nothing about.
        setFailedFor((failed) => (failed === value ? null : failed));
      } catch {
        setFailedFor(value);
      }
    })();
  };

  /*
   * Keyed on the value rather than a bare boolean, because `ShareLink` stays
   * mounted across a regenerate: the code swaps while the block rendering it
   * never goes false, so a boolean would leave the last code's failure sitting
   * under a link nobody has tried to copy. Comparing beats an effect - there
   * is no render in between to clear it in.
   */
  return { copy, copyFailed: failedFor === value };
}
