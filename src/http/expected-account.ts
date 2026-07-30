/**
 * The account a delete request believes it is deleting.
 *
 * Account deletion is the one irreversible action here, and the client cannot
 * make its own check safe: it reads the session, compares, and then calls
 * `deleteUser` in a second request. A sign-in in another tab between those two
 * swaps the cookie, and the delete lands on whoever the session names now -
 * an account whose handle was never typed into the box.
 *
 * Naming the expectation in the request itself closes that. Better Auth
 * resolves the session and runs `beforeDelete` inside one request, so the id
 * this header carries is compared against the account that same request
 * authenticated, with no window between the two. A mismatch throws before
 * anything is deleted.
 *
 * Required, not optional. A caller that omits it is refused rather than
 * defaulted to its own session: a check a request can skip is one a client
 * regression drops silently, and what it guards is the deletion of an account
 * nobody named. A script deleting its own account says which one that is.
 */
export const EXPECTED_ACCOUNT_HEADER = "x-expected-account";

/**
 * The code both refusals carry: a header naming another account, and no header
 * at all.
 *
 * One code for both because the client does one thing with either - stops, and
 * says the page is holding somebody else. Named here rather than spelled at
 * the throw and again at the read, since a rename that missed one would turn a
 * blocked delete back into a retryable one silently.
 */
export const WRONG_ACCOUNT_CODE = "WRONG_ACCOUNT";
