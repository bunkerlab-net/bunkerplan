import { useCallback, useEffect, useRef, useState } from "hono/jsx";
import { MAX_PLAN_LABEL_LENGTH } from "../http/plan-label.ts";
import {
  addGrants,
  clearShareCode,
  deletePlan,
  getSharing,
  listPlans,
  type PlanSharing,
  type PlanSummary,
  type PlanVisibility,
  relabelPlan,
  removeGrant,
  replacePlan,
  rotateShareCode,
  setVisibility,
  uploadPlan,
} from "./api.ts";
import { inputOf } from "./dom.ts";

/**
 * What the Sharing column says at a glance.
 *
 * Public is public: a plan cannot carry a code while it is public, because
 * `setVisibility` nulls the hash on the way out of private and `setShareCodeHash`
 * only writes to a private row - so there is no "Public + code" to render.
 *
 * A private plan can carry both a code and named accounts at once. That is a
 * real state, not an accident, so it is named rather than collapsed into
 * whichever half is checked first.
 */
function describeSharing(plan: PlanSummary): string {
  if (plan.visibility === "public") return "Public";
  if (plan.hasShareCode && plan.hasGrants) return "Private + user share + Code";
  if (plan.hasShareCode) return "Private + Code";
  return plan.hasGrants ? "Private + user share" : "Private";
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MiB`;
}

/*
 * Mirrors the `accept` attribute for the drop path, which has no equivalent.
 * The extension is checked as well as the type because a drag off a file
 * manager can arrive with an empty `type`.
 */
function isHtml(file: File): boolean {
  return file.type === "text/html" || /\.html?$/i.test(file.name);
}

/** Runs work through the panel's one busy flag and one error line. */
type Guard = (work: () => Promise<unknown>) => Promise<boolean>;

interface SharingEditorProps {
  plan: PlanSummary;
  busy: boolean;
  guard: Guard;
}

/**
 * The three ways to share one plan.
 *
 * Each block owns the state only it reads - the plaintext code, the handle
 * being typed - so this is the loader and the layout, nothing more.
 */
function SharingEditor({ plan, busy, guard }: SharingEditorProps) {
  const [state, setState] = useState<PlanSharing | null>(null);
  const [failed, setFailed] = useState(false);

  // Reads directly rather than through `guard`: opening a row is not a
  // mutation, and routing it through the panel would flip the shared busy flag
  // and refetch every plan just to fill in one editor. A failure shows the
  // retry instead of the panel's error line.
  const load = useCallback(async () => {
    setFailed(false);
    try {
      setState(await getSharing(plan.id));
    } catch {
      setFailed(true);
    }
  }, [plan.id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state === null) {
    return <SharingPlaceholder failed={failed} busy={busy} onRetry={load} />;
  }

  // A public plan is readable by anyone holding the URL, so neither a code nor
  // a grant gates anything. Grants stay on screen rather than vanishing - they
  // are real state that applies again the moment this goes private - but
  // nothing here acts while public. The code is genuinely gone: going public
  // retires it, rather than leaving a bearer secret to reactivate later.
  const inert = state.visibility === "public";
  const shared = { plan, guard, reload: load, locked: busy || inert };

  return (
    <div className="sharing">
      <VisibilityChoice
        planId={plan.id}
        visibility={state.visibility}
        busy={busy}
        inert={inert}
        hasShareCode={state.hasShareCode}
        onChoose={(visibility) =>
          void guard(async () => {
            setState(await setVisibility(plan.id, visibility));
          })
        }
      />
      <ShareCodeBlock {...shared} hasShareCode={state.hasShareCode} />
      <GrantsBlock {...shared} grants={state.grants} />
    </div>
  );
}

/** The same container as the loaded state, so opening a row shifts nothing. */
function SharingPlaceholder(props: {
  failed: boolean;
  busy: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="sharing">
      {props.failed ? (
        <p className="muted">
          Could not load sharing for this plan.{" "}
          <button
            type="button"
            className="btn-text"
            disabled={props.busy}
            onClick={props.onRetry}
          >
            Try again
          </button>
        </p>
      ) : (
        <p className="muted">Loading…</p>
      )}
    </div>
  );
}

/**
 * What both mutating blocks need to act and then refresh. `locked` already
 * folds in the public-plan case, so neither block needs `inert` itself - only
 * `VisibilityChoice`, which is the one that explains it.
 */
interface BlockProps {
  plan: PlanSummary;
  guard: Guard;
  reload: () => Promise<void>;
  locked: boolean;
}

function VisibilityChoice(props: {
  planId: string;
  visibility: PlanVisibility;
  busy: boolean;
  inert: boolean;
  /** Names the consequence on the control that causes it, before it is used. */
  hasShareCode: boolean;
  onChoose: (visibility: PlanVisibility) => void;
}) {
  // Several editors can be open at once, so the heading id carries the plan.
  const headingId = `visibility-heading-${props.planId}`;
  const inertId = `visibility-inert-${props.planId}`;
  return (
    <div>
      <h3 id={headingId}>Who can open it</h3>
      {/* Without the role the radios are announced one at a time, with no
          statement of what the choice is for. `aria-describedby` carries the
          note below into that announcement, so the reason the accounts are
          inactive arrives with the choice rather than after it. */}
      <div
        className="choices"
        role="radiogroup"
        aria-labelledby={headingId}
        aria-describedby={props.inert ? inertId : undefined}
      >
        {(["private", "public"] as const).map((option) => (
          <label className="choice" key={option}>
            <input
              type="radio"
              name={`visibility-${props.planId}`}
              value={option}
              checked={props.visibility === option}
              disabled={props.busy}
              onChange={() => props.onChoose(option)}
            />
            <span>
              {option === "private"
                ? "Private - you, granted accounts, and anyone with the code"
                : props.hasShareCode
                  ? "Public - anyone holding the URL. Retires the share code."
                  : "Public - anyone holding the URL"}
            </span>
          </label>
        ))}
      </div>
      {props.inert && (
        <p className="muted" id={inertId}>
          Anyone holding the URL can open this plan, so the accounts below grant
          nothing extra. Make it private to use them.
        </p>
      )}
    </div>
  );
}

/**
 * The plaintext code lives here and nowhere else: the server returns it once
 * and stores only a digest, so unmounting this block is the last time anyone
 * can read it.
 */
function ShareCodeBlock(
  props: BlockProps & {
    hasShareCode: boolean;
  },
) {
  const { plan, guard, reload, locked } = props;
  const [code, setCode] = useState<string | null>(null);

  // Going public retires the code, so a plaintext held here can outlive what it
  // opens. Dropped rather than left in state: showing it would hand the owner a
  // link that no longer works, which is worse than showing nothing. The render
  // below is gated too, because this runs after it.
  useEffect(() => {
    if (!props.hasShareCode) setCode(null);
  }, [props.hasShareCode]);

  const rotate = () =>
    void guard(async () => {
      setCode(await rotateShareCode(plan.id));
      await reload();
    });

  const clear = () =>
    void guard(async () => {
      await clearShareCode(plan.id);
      setCode(null);
      await reload();
    });

  return (
    <div>
      <h3>Share code</h3>
      <div className="row">
        <button
          type="button"
          className="btn-text"
          disabled={locked}
          onClick={rotate}
        >
          {props.hasShareCode ? "Regenerate" : "Create code"}
        </button>
        {props.hasShareCode && (
          <button
            type="button"
            className="btn-text btn-text-clay"
            disabled={locked}
            onClick={clear}
          >
            Remove
          </button>
        )}
      </div>
      {code !== null && props.hasShareCode && (
        <ShareLink url={plan.url} id={plan.id} code={code} />
      )}
      {code === null && props.hasShareCode && (
        <p className="muted">
          A code is set. It cannot be read back - regenerate to get a new one,
          which stops the old link working immediately.
        </p>
      )}
    </div>
  );
}

/**
 * The one-time share link, with the copy button the sentence above it asks
 * for - the same shape `ApiKeysPanel`'s `Reveal` uses for the other secret
 * this app shows exactly once.
 */
function ShareLink({
  url,
  id,
  code,
}: {
  url: string;
  id: string;
  code: string;
}) {
  /*
   * `/s/{id}#code=`, and both halves of that are deliberate.
   *
   * The fragment, because a fragment is never sent to a server: the code in the
   * link people paste into chat reaches no access log, no proxy and no
   * `Referer`. And `/s/{id}` rather than the plan's own URL, because `/p/{id}`
   * answers a reader who already has access with the uploaded document - and
   * untrusted HTML can read its own `location.hash`. `/s/{id}` is the app's own
   * page: it spends the code, then sends the reader to the plan.
   *
   * `?code=` on `/p/{id}` remains for a reader without a DOM, which cannot send
   * a fragment at all. SECURITY.md records why both exist.
   *
   * Rebuilt through `URL` rather than by patching the string: the plan URL's
   * origin is the configured one, and that is the part worth keeping.
   *
   * Encoded even though the alphabet is base62 and needs none: the link is
   * built here, and a future alphabet change must not silently start producing
   * broken URLs.
   */
  const relay = new URL(url);
  relay.pathname = `/s/${id}`;
  /*
   * Both of these go through the URL object rather than concatenation, and for
   * the same reason: `planUrl` produces neither a query nor a fragment today,
   * so neither line changes what is emitted - they are what keeps the relay
   * link free of both if the plan URL ever grows one. A query inherited here
   * would ride along beside a share code.
   */
  relay.search = "";
  relay.hash = `code=${encodeURIComponent(code)}`;
  const link = relay.toString();
  const [copyFailed, setCopyFailed] = useState(false);

  // `writeText` rejects on a denied permission or an insecure context, and
  // this is the one secret the app shows once - a copy that quietly did
  // nothing would lose it. The link is on screen either way, so the fallback
  // is to say so rather than to retry.
  const copy = () => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(link);
        setCopyFailed(false);
      } catch {
        setCopyFailed(true);
      }
    })();
  };

  return (
    <>
      <p>
        <strong>This is the only time the code is shown.</strong> Copy the link:
      </p>
      <div className="row">
        {/* A section, not a bare `code`: the block scrolls sideways, so it
            has to be focusable, and a focus stop with no name is worse than
            none. The `code` stays inside it. */}
        <section
          className="snippet"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard (WCAG 2.1.1).
          tabIndex={0}
          aria-label="Share link"
        >
          <code>{link}</code>
        </section>
        <button type="button" className="btn-text" onClick={copy}>
          Copy
        </button>
      </div>
      {copyFailed && (
        <p className="error" role="alert">
          Could not reach the clipboard - select the link above and copy it.
        </p>
      )}
    </>
  );
}

function GrantsBlock(props: BlockProps & { grants: string[] }) {
  const { plan, guard, reload, locked } = props;
  const [handle, setHandle] = useState("");
  /** What the last submission named that nothing answers to. */
  const [unknown, setUnknown] = useState<string[]>([]);
  /** What errored rather than being refused; worth trying again as-is. */
  const [failed, setFailed] = useState<string[]>([]);

  const submit = (event: Event) => {
    event.preventDefault();
    // Enter submits even when the button is disabled, so every guard the
    // button carries must be repeated here.
    const wanted = handle.trim();
    if (locked || wanted === "") return;
    // The last attempt's verdict goes before this one starts. Otherwise a
    // corrected handle sits under the alert naming the old typo for as long
    // as the request takes, and keeps it for good if the request throws.
    setUnknown([]);
    setFailed([]);
    void guard(async () => {
      // Sent as typed: the server splits on commas, so a list written here
      // and a list written against the API are parsed by the same code.
      const result = await addGrants(plan.id, wanted);
      setUnknown(result.unknown);
      setFailed(result.failed);
      // Whatever did not land stays in the field, so a typo can be corrected
      // and a failure retried without retyping the ones that worked.
      setHandle([...result.unknown, ...result.failed].join(", "));
      await reload();
    });
  };

  const revoke = (granted: string) =>
    void guard(async () => {
      await removeGrant(plan.id, granted);
      await reload();
    });

  return (
    <div>
      <h3>Shared with</h3>
      <GrantedList grants={props.grants} locked={locked} onRevoke={revoke} />
      <p className="muted">
        A handle is the value shown as <strong>Handle</strong> beside{" "}
        <strong>Sign out</strong> on that person's own dashboard - ask them for
        it. An account id works too. Separate several with commas.
      </p>
      <GrantVerdict unknown={unknown} failed={failed} />
      {/* A real form, not a button beside an input: Enter in a text field
          submitting its form is native behaviour, and typing a handle then
          pressing Enter is what anyone will do. */}
      <form className="row" onSubmit={submit}>
        <input
          type="text"
          placeholder="Handles or account ids, comma-separated"
          aria-label={`Share plan ${plan.id} with accounts`}
          value={handle}
          disabled={locked}
          onChange={(event: Event) => setHandle(inputOf(event).value)}
        />
        <button
          type="submit"
          className="btn-text"
          disabled={locked || handle.trim() === ""}
        >
          Add
        </button>
      </form>
    </div>
  );
}

/**
 * What the last submission did to the accounts that did not land.
 *
 * Two separate lines, and neither says what the other's entries did:
 * "everyone else was added" is false the moment something failed.
 */
function GrantVerdict(props: { unknown: string[]; failed: string[] }) {
  return (
    <>
      {props.unknown.length > 0 && (
        <p className="error" role="alert">
          No account holds {props.unknown.join(", ")} - check the spelling.
        </p>
      )}
      {props.failed.length > 0 && (
        <p className="error" role="alert">
          Could not share with {props.failed.join(", ")} just now. Adding them
          again is safe.
        </p>
      )}
    </>
  );
}

/** The accounts a plan is already shared with, each with a way out. */
function GrantedList(props: {
  grants: string[];
  locked: boolean;
  onRevoke: (handle: string) => void;
}) {
  if (props.grants.length === 0) {
    return <p className="empty">No accounts yet.</p>;
  }
  return (
    <ul className="tag-list">
      {props.grants.map((granted) => (
        <li key={granted}>
          <span className="mono">{granted}</span>
          <button
            type="button"
            className="btn-text btn-text-clay"
            // Every row's button reads "Remove" otherwise, so a list of them
            // is a list of identical controls out of context.
            aria-label={`Remove ${granted}`}
            disabled={props.locked}
            onClick={() => props.onRevoke(granted)}
          >
            Remove
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The id of the editor a row's Share button controls, wherever it renders. */
const sharingRegionId = (planId: string) => `sharing-${planId}`;

interface RowProps {
  plan: PlanSummary;
  busy: boolean;
  /** True when this row's editor is the one open below the table. */
  expanded: boolean;
  onToggleSharing: () => void;
  onRelabel: (id: string, label: string | null) => Promise<boolean>;
  onReplace: (id: string, files: FileList | null) => void;
  onDelete: (id: string) => void;
}

function PlanRow({
  plan,
  busy,
  expanded,
  onToggleSharing,
  onRelabel,
  onReplace,
  onDelete,
}: RowProps) {
  const stored = plan.label ?? "";
  const [draft, setDraft] = useState(stored);

  // A refresh can bring a different label for this row - the id is the React
  // key, so the component survives and the draft has to follow.
  useEffect(() => {
    setDraft(stored);
  }, [stored]);

  // Blur is the commit, which covers Enter (it blurs), tabbing out, and
  // clicking away. Unchanged text sends nothing.
  const commit = () => {
    const next = draft.trim();
    setDraft(next);
    if (next === stored) return;
    void onRelabel(plan.id, next === "" ? null : next).then((ok) => {
      // A refused relabel leaves the row's stored value alone, so nothing
      // re-seeds the draft: without this the field keeps showing text the
      // server never accepted, beside an error saying it did not.
      if (!ok) setDraft(stored);
    });
  };

  return (
    <tr>
      <td>
        <input
          className="label-input"
          type="text"
          placeholder="Add a label"
          aria-label={`Label for plan ${plan.id}`}
          maxLength={MAX_PLAN_LABEL_LENGTH}
          value={draft}
          disabled={busy}
          onChange={(event: Event) => setDraft(inputOf(event).value)}
          onBlur={commit}
          onKeyDown={(event: KeyboardEvent) => {
            if (event.key === "Enter") inputOf(event).blur();
            if (event.key === "Escape") setDraft(stored);
          }}
        />
      </td>
      <td>
        <a className="mono" href={plan.url}>
          {plan.id}
        </a>
      </td>
      <td>{formatBytes(plan.size)}</td>
      <td>{new Date(plan.createdAt).toLocaleString()}</td>
      <td>{describeSharing(plan)}</td>
      <RowActions
        plan={plan}
        busy={busy}
        expanded={expanded}
        onToggleSharing={onToggleSharing}
        onReplace={onReplace}
        onDelete={onDelete}
      />
    </tr>
  );
}

function RowActions({
  plan,
  busy,
  expanded,
  onToggleSharing,
  onReplace,
  onDelete,
}: Omit<RowProps, "onRelabel">) {
  const replaceInput = useRef<HTMLInputElement>(null);

  return (
    <td className="actions">
      <button
        type="button"
        className="btn-text"
        disabled={busy}
        onClick={() => replaceInput.current?.click()}
      >
        Replace
      </button>
      {/* The button above is the accessible control; this only carries the
          picker, so it stays out of the tab order. */}
      <input
        ref={replaceInput}
        className="file-input"
        type="file"
        accept=".html,.htm,text/html"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event: Event) => {
          const input = inputOf(event);
          onReplace(plan.id, input.files);
          input.value = "";
        }}
      />
      <button
        type="button"
        className="btn-text"
        disabled={busy}
        onClick={onToggleSharing}
        // A string, not the boolean: the server renderer writes
        // `aria-expanded="false"`, but `hono/jsx/dom` drops a false attribute
        // and writes `""` for true - so hydrating this row would strip the
        // state a disclosure control is announced by.
        aria-expanded={expanded ? "true" : "false"}
        aria-controls={sharingRegionId(plan.id)}
      >
        Share
      </button>
      <button
        type="button"
        className="btn-text btn-text-clay"
        disabled={busy}
        onClick={() => onDelete(plan.id)}
      >
        Delete
      </button>
    </td>
  );
}

/**
 * Puts focus back where closing the editor left a hole.
 *
 * Closing moves focus nowhere on its own, which drops a keyboard user at the
 * top of the document. Three steps, because each one can be gone: the control
 * they pressed; the table its row was in, when deleting that row is what
 * closed the editor; and the panel heading, because deleting the *last* plan
 * unmounts the table too and there would otherwise be nothing left to land
 * on.
 *
 * Does nothing when no opener was remembered. The effect calling this also
 * runs on mount, where nothing was ever open, and taking focus off whatever
 * the page had it on would be worse than the hole.
 */
function restoreFocus(
  openedBy: { current: HTMLElement | null },
  table: { current: HTMLElement | null },
  heading: { current: HTMLElement | null },
): void {
  const opener = openedBy.current;
  openedBy.current = null;
  if (opener === null) return;
  const target = opener.isConnected
    ? opener
    : (table.current ?? heading.current);
  target?.focus();
}

/**
 * Which row's sharing editor is open, and the element it renders into.
 *
 * Held above the rows because the editor renders below the table: inside it,
 * the editor would be as wide as the widest row and scroll off-screen with it.
 */
function useExpandedPlan(plans: PlanSummary[]) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const editorRef = useRef<HTMLElement>(null);
  /** The Share button that opened the editor, so closing can go back to it. */
  const openedByRef = useRef<HTMLElement | null>(null);
  /** Where focus goes when that button has gone with its row. */
  const tableRef = useRef<HTMLElement>(null);
  /** And when the table has gone too, because that was the last plan. */
  const headingRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (expanded === null) {
      restoreFocus(openedByRef, tableRef, headingRef);
      return;
    }

    // Runs before focus is moved below, so this is still the Share button.
    const active = document.activeElement;
    if (active instanceof HTMLElement) openedByRef.current = active;

    // The editor sits below the whole table, which can be well off-screen on
    // a long list. Move to it, so opening one is not a change to go hunting
    // for.
    editorRef.current?.scrollIntoView({ block: "nearest" });
    editorRef.current?.focus();
  }, [expanded]);

  // A refresh can take the open row away - deleting it, or another tab doing
  // so. Clearing the selection rather than leaving it dangling is what routes
  // that case through the close branch above, so focus is restored and the
  // remembered button is dropped instead of being held detached.
  const stillListed = plans.some((item) => item.id === expanded);
  useEffect(() => {
    if (expanded !== null && !stillListed) setExpanded(null);
  }, [expanded, stillListed]);

  return {
    expanded,
    setExpanded,
    // A refresh can remove the open row - deleting it, or another tab doing
    // so - and the editor follows the list rather than the click that opened
    // it.
    expandedPlan: plans.find((item) => item.id === expanded),
    editorRef,
    tableRef,
    headingRef,
  };
}

/**
 * Without this the browser navigates to any file dropped outside the zone,
 * throwing the dashboard away - the behaviour the drop zone exists to replace.
 * Drops inside the zone bubble up here too, but its handler has already taken
 * the file and a second preventDefault costs nothing.
 *
 * Narrowed to file drags so that dragging text into the other panels' inputs
 * still works.
 */
function useSwallowedFileDrags() {
  useEffect(() => {
    const swallow = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
    };
    window.addEventListener("dragover", swallow);
    window.addEventListener("drop", swallow);
    return () => {
      window.removeEventListener("dragover", swallow);
      window.removeEventListener("drop", swallow);
    };
  }, []);
}

/**
 * The plan list, and the one wrapper every mutation goes through so the panel
 * keeps a single busy flag and a single error line.
 */
function usePlanList() {
  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * False until the first list call has answered. Without it the panel says
   * "No plans yet" for the length of that request, which is the wrong thing
   * to tell someone who has plans.
   */
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setPlans(await listPlans());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Resolves false when `work` threw, so a caller can undo its optimism.
   *
   * Memoised for a stable prop identity: it is handed down to the table and
   * to the sharing editor on every render. The editor no longer loads through
   * it - reading a row is not a mutation, so it fetches directly - and
   * nothing has it in a dependency array today, but a changing identity is
   * the kind of thing that turns a future `useEffect` here into a loop.
   */
  const guard = useCallback(
    async (work: () => Promise<unknown>): Promise<boolean> => {
      setBusy(true);
      try {
        await work();
        setError(null);
        await refresh();
        return true;
      } catch (cause) {
        // The validator's reason is rendered verbatim so a rejection is
        // actionable rather than a bare 422.
        setError(cause instanceof Error ? cause.message : String(cause));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  return { plans, error, setError, busy, guard, loaded };
}

/** The one HTML file in `files`, or null with the reason already shown. */
function vetFile(
  files: FileList | null,
  onError: (reason: string) => void,
): File | null {
  const [file, ...rest] = Array.from(files ?? []);
  if (file === undefined) return null;
  if (rest.length > 0) {
    onError("Upload one file at a time.");
    return null;
  }
  if (!isHtml(file)) {
    onError(`${file.name} is not an HTML document.`);
    return null;
  }
  return file;
}

function usePlanUploads(guard: Guard, onError: (reason: string) => void) {
  return {
    submit: (files: FileList | null) => {
      const file = vetFile(files, onError);
      // Always private. `?visibility=code` is a real upload option on the API
      // - it stores the plan private and mints a code in the same request -
      // but the dashboard declines it and mints from the row's Share editor
      // instead, so there is one place a plaintext code is ever revealed.
      if (file !== null) void guard(() => uploadPlan(file, "private"));
    },
    replace: (id: string, files: FileList | null) => {
      const file = vetFile(files, onError);
      if (file !== null) void guard(() => replacePlan(id, file));
    },
  };
}

export function PlansPanel() {
  const { plans, error, setError, busy, guard, loaded } = usePlanList();
  const {
    expanded,
    setExpanded,
    expandedPlan,
    editorRef,
    tableRef,
    headingRef,
  } = useExpandedPlan(plans);
  const { submit, replace } = usePlanUploads(guard, setError);
  const [dragging, setDragging] = useState(false);

  useSwallowedFileDrags();

  return (
    <section className="card">
      {/* `tabIndex={-1}` so focus can land here after the last plan is
          deleted, without adding a tab stop nobody asked for. */}
      <h2 className="card-title" ref={headingRef} tabIndex={-1}>
        Plans
      </h2>
      <p className="muted">
        Upload a standalone HTML document. External scripts, stylesheets,
        images, fonts, and iframes are all refused. A new plan is private - use{" "}
        <strong>Share</strong> on its row to open it up.
      </p>
      <DropZone
        busy={busy}
        dragging={dragging}
        setDragging={setDragging}
        onFiles={submit}
      />
      {error !== null && <p className="error">{error}</p>}
      {plans.length === 0 ? (
        // Nothing is claimed while the first list is still in flight, and
        // nothing at all when it failed: the error line above is the whole
        // story then, and "No plans yet" beside it would be a second, wrong
        // one.
        error === null && (
          <p className="empty" style={{ marginTop: "24px" }}>
            {loaded ? "No plans yet." : "Loading…"}
          </p>
        )
      ) : (
        <>
          <PlansTable
            plans={plans}
            busy={busy}
            expanded={expanded}
            setExpanded={setExpanded}
            guard={guard}
            onReplace={replace}
            containerRef={tableRef}
          />
          {expandedPlan !== undefined && (
            <ExpandedSharing
              containerRef={editorRef}
              plan={expandedPlan}
              busy={busy}
              guard={guard}
            />
          )}
        </>
      )}
    </section>
  );
}

function PlansTable(props: {
  plans: PlanSummary[];
  busy: boolean;
  expanded: string | null;
  setExpanded: (id: string | null) => void;
  guard: Guard;
  onReplace: (id: string, files: FileList | null) => void;
  /**
   * Structural rather than a `ref` prop: `ref` on a custom component is JSX
   * machinery, not an ordinary prop. Focus lands here when the editor closes
   * because its row was deleted, so the button that opened it has gone.
   */
  containerRef: { current: HTMLElement | null };
}) {
  const { plans, busy, expanded, setExpanded, guard } = props;
  return (
    <section
      ref={props.containerRef}
      className="table-scroll"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard (WCAG 2.1.1).
      tabIndex={0}
      aria-label="Plans"
    >
      <table>
        <thead>
          <tr>
            <th>Label</th>
            <th>Id</th>
            <th>Size</th>
            <th>Created</th>
            <th>Sharing</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {plans.map((item) => (
            <PlanRow
              key={item.id}
              plan={item}
              busy={busy}
              expanded={expanded === item.id}
              onToggleSharing={() =>
                setExpanded(expanded === item.id ? null : item.id)
              }
              onRelabel={(id, label) => guard(() => relabelPlan(id, label))}
              onReplace={props.onReplace}
              onDelete={(id) => void guard(() => deletePlan(id))}
            />
          ))}
        </tbody>
      </table>
    </section>
  );
}

function DropZone(props: {
  busy: boolean;
  dragging: boolean;
  setDragging: (dragging: boolean) => void;
  onFiles: (files: FileList | null) => void;
}) {
  return (
    <label
      className={props.dragging ? "dropzone is-dragging" : "dropzone"}
      htmlFor="plan-file"
      onDragOver={(event: DragEvent) => {
        event.preventDefault();
        if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "copy";
        if (!props.busy) props.setDragging(true);
      }}
      onDragLeave={(event: DragEvent) => {
        // Children fire their own dragleave as the pointer crosses them; only
        // a departure from the zone itself counts.
        const next = event.relatedTarget;
        const zone = event.currentTarget;
        if (next instanceof Node && zone instanceof Node && zone.contains(next))
          return;
        props.setDragging(false);
      }}
      onDrop={(event: DragEvent) => {
        event.preventDefault();
        props.setDragging(false);
        if (!props.busy) props.onFiles(event.dataTransfer?.files ?? null);
      }}
    >
      <span className="btn-ivory">Choose a file</span>
      <span className="muted">or drop one here</span>
      <input
        id="plan-file"
        className="file-input"
        type="file"
        accept=".html,.htm,text/html"
        disabled={props.busy}
        onChange={(event: Event) => {
          // Consume before clearing: `files` is the input's live FileList and
          // `value = ""` empties it. The reset still has to happen, or
          // re-picking the same file fires no second change event.
          const input = inputOf(event);
          props.onFiles(input.files);
          input.value = "";
        }}
      />
    </label>
  );
}

/**
 * The editor, below the table rather than inside it: it is a detail panel
 * rather than tabular data, and within the scrolling table it would be as wide
 * as the widest row and scroll away with it.
 */
function ExpandedSharing(props: {
  /**
   * Structural rather than a `Ref` import, and deliberately not named `ref`:
   * `ref` on a custom component is JSX machinery, not an ordinary prop. This
   * shape is exactly what `useRef` returns.
   */
  containerRef: { current: HTMLElement | null };
  plan: PlanSummary;
  busy: boolean;
  guard: Guard;
}) {
  const { plan } = props;
  return (
    <section
      ref={props.containerRef}
      id={sharingRegionId(plan.id)}
      tabIndex={-1}
      aria-label={`Sharing for ${plan.label ?? plan.id}`}
    >
      {/* Named, because the editor sits below the table rather than under the
          row it belongs to. */}
      <h3 className="card-title" style={{ marginTop: "24px" }}>
        Sharing <span className="mono">{plan.label ?? plan.id}</span>
      </h3>
      {/* Keyed, so switching rows remounts. One element position now serves
          every plan, and without this React would reuse the instance - leaving
          the previous plan's loaded state, and its one-time plaintext code, on
          screen under this plan's name. */}
      <SharingEditor
        key={plan.id}
        plan={plan}
        busy={props.busy}
        guard={props.guard}
      />
    </section>
  );
}
