/**
 * The line a credentials panel shows where its table would be.
 *
 * Three states share that spot and only two of them say anything. A list still
 * in flight says "Loading…" rather than claiming the account has nothing; a
 * list that answered with nothing says so; and a list that failed says nothing
 * here at all, because the error line above it is the whole story and a second
 * one beside it would contradict it.
 *
 * Shared by ApiKeysPanel and PasskeysPanel, which had a copy each. They have to
 * keep answering the same way: one of them drifting is a panel telling a
 * visitor their keys are gone while the request that would have listed them is
 * still in flight.
 */
export function EmptyOrLoading(props: {
  loaded: boolean;
  /** What to say once the list has answered and held nothing. */
  empty: string;
}) {
  return (
    <p className="empty" style={{ marginTop: "24px" }}>
      {props.loaded ? props.empty : "Loading…"}
    </p>
  );
}
