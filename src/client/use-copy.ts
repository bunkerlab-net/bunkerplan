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
  const [copyFailed, setCopyFailed] = useState(false);

  const copy = () => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(value);
        setCopyFailed(false);
      } catch {
        setCopyFailed(true);
      }
    })();
  };

  return { copy, copyFailed };
}
