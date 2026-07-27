import { useCallback, useEffect, useRef, useState } from "hono/jsx";
import { MAX_PLAN_LABEL_LENGTH } from "../http/plan-label.ts";
import {
  addGrant,
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

/** What the Sharing column says at a glance. */
function describeSharing(plan: PlanSummary): string {
  if (plan.visibility === "public") return "Public";
  return plan.hasShareCode ? "Private + code" : "Private";
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
  // a grant gates anything. Both stay on screen rather than vanishing - they
  // are real state that applies again the moment this goes private, and hiding
  // them would read as having cleared them - but nothing here acts.
  const inert = state.visibility === "public";
  const shared = { plan, guard, reload: load, inert, locked: busy || inert };

  return (
    <div className="sharing">
      <VisibilityChoice
        planId={plan.id}
        visibility={state.visibility}
        busy={busy}
        inert={inert}
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

/** What both mutating blocks need to act and then refresh. */
interface BlockProps {
  plan: PlanSummary;
  guard: Guard;
  reload: () => Promise<void>;
  inert: boolean;
  locked: boolean;
}

function VisibilityChoice(props: {
  planId: string;
  visibility: PlanVisibility;
  busy: boolean;
  inert: boolean;
  onChoose: (visibility: PlanVisibility) => void;
}) {
  return (
    <div>
      <h3>Who can open it</h3>
      <div className="choices">
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
                : "Public - anyone holding the URL"}
            </span>
          </label>
        ))}
      </div>
      {props.inert && (
        <p className="muted">
          Anyone holding the URL can open this plan, so the code and the
          accounts below grant nothing extra. Make it private to use them.
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
  const { plan, guard, reload, inert, locked } = props;
  const [code, setCode] = useState<string | null>(null);

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
    <div className={inert ? "sharing-inert" : undefined}>
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
      {code !== null && (
        <>
          <p>
            <strong>This is the only time the code is shown.</strong> Copy the
            link:
          </p>
          {/* Encoded even though the alphabet is base62 and needs none: the
              link is built here, and a future alphabet change must not
              silently start producing broken URLs. */}
          <code className="snippet">
            {`${plan.url}?code=${encodeURIComponent(code)}`}
          </code>
        </>
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

function GrantsBlock(props: BlockProps & { grants: string[] }) {
  const { plan, guard, reload, inert, locked } = props;
  const [handle, setHandle] = useState("");

  const submit = (event: Event) => {
    event.preventDefault();
    // Enter submits even when the button is disabled, so every guard the
    // button carries must be repeated here.
    const wanted = handle.trim();
    if (locked || wanted === "") return;
    void guard(async () => {
      await addGrant(plan.id, wanted);
      setHandle("");
      await reload();
    });
  };

  const revoke = (granted: string) =>
    void guard(async () => {
      await removeGrant(plan.id, granted);
      await reload();
    });

  return (
    <div className={inert ? "sharing-inert" : undefined}>
      <h3>Shared with</h3>
      {props.grants.length === 0 ? (
        <p className="empty">No accounts yet.</p>
      ) : (
        <ul className="tag-list">
          {props.grants.map((granted) => (
            <li key={granted}>
              <span className="mono">{granted}</span>
              <button
                type="button"
                className="btn-text btn-text-clay"
                disabled={locked}
                onClick={() => revoke(granted)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="muted">
        A handle is the value shown as <strong>Handle</strong> beside{" "}
        <strong>Sign out</strong> on that person's own dashboard - ask them for
        it.
      </p>
      {/* A real form, not a button beside an input: Enter in a text field
          submitting its form is native behaviour, and typing a handle then
          pressing Enter is what anyone will do. */}
      <form className="row" onSubmit={submit}>
        <input
          type="text"
          placeholder="Account handle"
          aria-label={`Share plan ${plan.id} with an account`}
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
        aria-expanded={expanded}
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
 * Which row's sharing editor is open, and the element it renders into.
 *
 * Held above the rows because the editor renders below the table: inside it,
 * the editor would be as wide as the widest row and scroll off-screen with it.
 */
function useExpandedPlan(plans: PlanSummary[]) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const editorRef = useRef<HTMLElement>(null);

  // The editor sits below the whole table, which can be well off-screen on a
  // long list. Move to it, so opening one is not a change to go hunting for.
  useEffect(() => {
    if (expanded === null) return;
    editorRef.current?.scrollIntoView({ block: "nearest" });
    editorRef.current?.focus();
  }, [expanded]);

  return {
    expanded,
    setExpanded,
    // A refresh can remove the open row - deleting it, or another tab doing
    // so - and the editor follows the list rather than the click that opened
    // it.
    expandedPlan: plans.find((item) => item.id === expanded),
    editorRef,
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

  const refresh = useCallback(async () => {
    try {
      setPlans(await listPlans());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Resolves false when `work` threw, so a caller can undo its optimism.
   *
   * Memoised because the sharing editor loads through it from an effect: an
   * identity that changed every render would re-run that effect forever - each
   * run flips `busy`, which rerenders, which rebuilds `guard`.
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

  return { plans, error, setError, busy, guard };
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
      // Always private. The dashboard never sends `visibility=code`: it
      // uploads, then mints a code from the row's Share editor, which is the
      // one place a plaintext code is ever revealed.
      if (file !== null) void guard(() => uploadPlan(file, "private"));
    },
    replace: (id: string, files: FileList | null) => {
      const file = vetFile(files, onError);
      if (file !== null) void guard(() => replacePlan(id, file));
    },
  };
}

export function PlansPanel() {
  const { plans, error, setError, busy, guard } = usePlanList();
  const { expanded, setExpanded, expandedPlan, editorRef } =
    useExpandedPlan(plans);
  const { submit, replace } = usePlanUploads(guard, setError);
  const [dragging, setDragging] = useState(false);

  useSwallowedFileDrags();

  return (
    <section className="card">
      <h2 className="card-title">Plans</h2>
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
        <p className="empty" style={{ marginTop: "24px" }}>
          No plans yet.
        </p>
      ) : (
        <>
          <PlansTable
            plans={plans}
            busy={busy}
            expanded={expanded}
            setExpanded={setExpanded}
            guard={guard}
            onReplace={replace}
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
}) {
  const { plans, busy, expanded, setExpanded, guard } = props;
  return (
    <section
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
