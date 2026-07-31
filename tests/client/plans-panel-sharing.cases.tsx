import "./dom-env.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PlansPanel } from "../../src/client/PlansPanel.tsx";
import {
  api,
  argsOf,
  countOf,
  grantResult,
  plan,
  sharing,
} from "./api-stub.ts";
import type { Mounted } from "./harness.tsx";
import {
  click,
  deferred,
  flush,
  mountAsync,
  submitForm,
  type,
} from "./harness.tsx";

/**
 * The sharing editor: the three ways one plan can be opened up.
 *
 * The share code is why this suite is careful. The server returns the
 * plaintext exactly once and keeps only a digest, so the block holding it has
 * to reveal it on rotation, keep it until the row goes away, and drop it the
 * moment going public retires the code it opens - a link on screen that no
 * longer works is worse than no link at all.
 */

/**
 * The Share control on a given row, failing at the lookup rather than handing
 * back an `undefined` for a caller to cast away.
 *
 * Re-queried per call on purpose: opening one editor re-renders the table, so
 * a handle taken before the first click can be stale by the second.
 *
 * Exported because plans-panel.test.tsx drives the same control from the other
 * half of this suite.
 */
export const shareButton = (view: Mounted, index: number): Element => {
  const row = view.all("tbody tr")[index];
  const button = row
    ? [...row.querySelectorAll("button")].find(
        (node) => node.textContent === "Share",
      )
    : undefined;
  if (button === undefined) {
    throw new Error(`no Share button on row ${index} in:\n${view.text()}`);
  }
  return button;
};

/**
 * Registered from plans-panel.test.tsx rather than collected as its own file.
 *
 * Both halves exercise one 1000-line component, and Bun instruments per worker:
 * split across two files they land in two workers, and the merged report
 * credits each half only with the lines its own worker executed. One entry
 * point, one instrumentation map, one honest number - the suites stay separate
 * here for the same reason they always were.
 *
 * The registering file must have called `useHarness()` and `useApiStub()`
 * first. These cases drive the panel through the armed api stub and mount onto
 * the harness's DOM; registered from a file that armed neither, they would
 * reach the real module and the real network.
 */
export function registerSharingCases(): void {
  describe("the sharing editor", () => {
    const PLAN_ID = "abc123";

    beforeEach(() => {
      api.listPlans = async () => [plan({ id: PLAN_ID, label: "Q3" })];
    });

    /** Mounts the panel and opens the one row's editor. */
    async function openEditor(): Promise<Mounted> {
      const view = await mountAsync(<PlansPanel />);
      await click(view.byText("button", "Share"));
      return view;
    }

    const radios = (view: Mounted) =>
      view.all<HTMLInputElement>('input[type="radio"]');

    /**
     * One radio by position, failing at the lookup rather than handing back an
     * `undefined` for the caller to cast away or read through `?.`.
     */
    const radio = (view: Mounted, index: number): HTMLInputElement => {
      const node = radios(view)[index];
      if (node === undefined) {
        throw new Error(`no radio ${index} in:\n${view.text()}`);
      }
      return node;
    };

    /** Picks a radio the way the browser does: checked, then an input event. */
    async function choose(node: HTMLInputElement): Promise<void> {
      node.checked = true;
      node.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
    }

    /*
     * Put back after every test: `navigator.clipboard` is one object for the
     * whole process, so a stub left in place keeps answering for the tests
     * that run after it.
     */
    const realClipboard = Object.getOwnPropertyDescriptor(
      navigator,
      "clipboard",
    );
    afterEach(() => {
      if (realClipboard === undefined) {
        Reflect.deleteProperty(navigator, "clipboard");
      } else {
        Object.defineProperty(navigator, "clipboard", realClipboard);
      }
    });

    /** Installs a clipboard that either records or refuses. */
    function clipboard(mode: { allow: boolean }): string[] {
      const written: string[] = [];
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (value: string) => {
            if (!mode.allow) throw new Error("NotAllowedError");
            written.push(value);
          },
        },
      });
      return written;
    }

    /** A plan whose code state changes as the test rotates and clears it. */
    function codeState(initial = false) {
      const state = { hasShareCode: initial };
      api.getSharing = async () =>
        sharing({ hasShareCode: state.hasShareCode });
      api.rotateShareCode = async () => {
        state.hasShareCode = true;
        return "abcd1234efgh5678";
      };
      api.clearShareCode = async () => {
        state.hasShareCode = false;
      };
      return state;
    }

    describe("loading the editor", () => {
      test("says so while the read is in flight", async () => {
        const read = deferred<unknown>();
        api.getSharing = read.answer;
        const view = await mountAsync(<PlansPanel />);

        await click(view.byText("button", "Share"));
        expect(view.find(".sharing").textContent).toBe("Loading…");

        read.release(sharing());
        await flush();
        expect(view.find(".sharing").textContent).not.toBe("Loading…");
      });

      test("reads directly rather than through the panel's busy flag", async () => {
        const read = deferred<unknown>();
        api.getSharing = read.answer;
        const view = await mountAsync(<PlansPanel />);

        await click(view.byText("button", "Share"));

        // Opening a row is not a mutation: routing it through the guard would
        // hold every other control and refetch the whole list to fill one editor.
        expect(
          view.byText<HTMLButtonElement>("button", "Delete").disabled,
        ).toBe(false);
        expect(countOf("listPlans")).toBe(1);

        read.release(sharing());
        await flush();
      });

      test("a failed read offers a retry rather than the panel's error line", async () => {
        api.getSharing = async () => {
          throw new Error("not yours");
        };
        const view = await openEditor();

        expect(view.find(".sharing").textContent).toContain(
          "Could not load sharing for this plan.",
        );
        expect(view.maybe(".error")).toBeNull();
      });

      test("the retry loads the editor", async () => {
        let attempt = 0;
        api.getSharing = async () => {
          attempt += 1;
          if (attempt === 1) throw new Error("network is down");
          return sharing({ grants: ["brisk-heron"] });
        };
        const view = await openEditor();

        await click(view.byText("button", "Try again"));

        expect(view.find(".tag-list").textContent).toContain("brisk-heron");
      });

      test("the retry is held while another mutation is in flight", async () => {
        const removal = deferred<void>();
        api.getSharing = async () => {
          throw new Error("network is down");
        };
        api.deletePlan = removal.answer;
        const view = await openEditor();

        view
          .byText("button", "Delete")
          .dispatchEvent(
            new MouseEvent("click", { bubbles: true, cancelable: true }),
          );
        await flush();

        expect(
          view.byText<HTMLButtonElement>("button", "Try again").disabled,
        ).toBe(true);
        removal.release();
        await flush();
      });
    });

    describe("visibility", () => {
      beforeEach(() => {
        api.getSharing = async () => sharing();
      });

      test("the current visibility is the checked radio", async () => {
        const view = await openEditor();

        expect(radio(view, 0).checked).toBe(true);
        expect(radio(view, 1).checked).toBe(false);
      });

      test("choosing public sends it and re-renders from the answer", async () => {
        api.setVisibility = async () => sharing({ visibility: "public" });
        const view = await openEditor();

        await choose(radio(view, 1));

        expect(argsOf("setVisibility")).toEqual([PLAN_ID, "public"]);
        expect(radio(view, 1).checked).toBe(true);
      });

      test("a public plan says why the accounts below grant nothing", async () => {
        api.getSharing = async () => sharing({ visibility: "public" });
        const view = await openEditor();

        expect(view.find(`#visibility-inert-${PLAN_ID}`).textContent).toContain(
          "Make it private to use them.",
        );
        // Carried into the radiogroup's announcement, so the reason arrives with
        // the choice rather than after it.
        expect(
          view.find('[role="radiogroup"]').getAttribute("aria-describedby"),
        ).toBe(`visibility-inert-${PLAN_ID}`);
      });

      test("a private plan carries no such note", async () => {
        const view = await openEditor();

        expect(view.maybe(`#visibility-inert-${PLAN_ID}`)).toBeNull();
        expect(
          view.find('[role="radiogroup"]').getAttribute("aria-describedby"),
        ).toBeNull();
      });

      test("going public is labelled as retiring the code, before it is used", async () => {
        api.getSharing = async () => sharing({ hasShareCode: true });
        const view = await openEditor();

        expect(view.text()).toContain(
          "Public - anyone holding the URL. Retires the share code.",
        );
      });

      test("with no code the same control makes no claim about one", async () => {
        const view = await openEditor();

        expect(view.text()).toContain("Public - anyone holding the URL");
        expect(view.text()).not.toContain("Retires the share code.");
      });

      test("the choice is named as a group rather than as loose radios", async () => {
        const view = await openEditor();

        expect(
          view.find('[role="radiogroup"]').getAttribute("aria-labelledby"),
        ).toBe(`visibility-heading-${PLAN_ID}`);
        expect(view.find(`#visibility-heading-${PLAN_ID}`).textContent).toBe(
          "Who can open it",
        );
        // Several editors can have been open in one document, so the radio group
        // name is scoped to the plan rather than shared.
        expect(radio(view, 0).name).toBe(`visibility-${PLAN_ID}`);
      });

      test("a refused change shows the panel's error line", async () => {
        api.setVisibility = async () => {
          throw new Error("not yours");
        };
        const view = await openEditor();

        await choose(radio(view, 1));

        expect(view.find(".error").textContent).toBe("not yours");
      });

      test("the radios are held while a mutation is in flight", async () => {
        const change = deferred<unknown>();
        api.setVisibility = change.answer;
        const view = await openEditor();

        const pub = radio(view, 1);
        pub.checked = true;
        pub.dispatchEvent(new Event("input", { bubbles: true }));
        await flush();

        expect(radios(view).every((node) => node.disabled)).toBe(true);
        change.release(sharing({ visibility: "public" }));
        await flush();
        expect(radios(view).some((node) => node.disabled)).toBe(false);
      });
    });

    describe("the share code", () => {
      test("with no code the control offers to create one", async () => {
        codeState(false);
        const view = await openEditor();

        expect(view.byText("button", "Create code")).not.toBeNull();
        expect(view.maybe(".sharing .btn-text-clay")).toBeNull();
      });

      test("with a code set it offers to regenerate and to remove", async () => {
        codeState(true);
        const view = await openEditor();

        expect(view.byText("button", "Regenerate")).not.toBeNull();
        expect(view.byText("button", "Remove")).not.toBeNull();
        expect(view.text()).toContain("It cannot be read back");
      });

      test("rotating reveals the plaintext exactly once, as a whole link", async () => {
        codeState(false);
        const view = await openEditor();

        await click(view.byText("button", "Create code"));

        /*
         * `/s/{id}#code=`, and both halves matter.
         *
         * A fragment is never sent to a server, so the code in a pasted link
         * reaches no access log and no proxy. And `/s/{id}` rather than the
         * plan's own URL, because `/p/{id}` answers a reader who already has
         * access with the uploaded document - untrusted HTML, which can read
         * its own `location.hash`.
         */
        expect(view.find(".snippet code").textContent).toBe(
          `${window.location.origin}/s/${PLAN_ID}#code=abcd1234efgh5678`,
        );
        expect(view.text()).toContain(
          "This is the only time the code is shown.",
        );
        // The standing note is replaced by the link, not shown beside it.
        expect(view.text()).not.toContain("It cannot be read back");
      });

      test("a copy failure does not follow the next code", async () => {
        /*
         * Regenerating swaps the code while this block stays mounted - the
         * condition rendering it never goes false - so a failure held as a
         * bare boolean would sit under a link nobody has tried to copy, and
         * tell its owner a copy they never made did not work.
         */
        clipboard({ allow: false });
        codeState(false);
        const view = await openEditor();

        await click(view.byText("button", "Create code"));
        await click(view.byText("button", "Copy"));
        expect(view.text()).toContain("Could not reach the clipboard");

        api.rotateShareCode = async () => "zyxw9876vuts5432";
        await click(view.byText("button", "Regenerate"));

        expect(view.find(".snippet code").textContent).toBe(
          `${window.location.origin}/s/${PLAN_ID}#code=zyxw9876vuts5432`,
        );
        expect(view.text()).not.toContain("Could not reach the clipboard");
      });

      test("the code is escaped into the link rather than concatenated raw", async () => {
        const state = codeState(false);
        api.rotateShareCode = async () => {
          state.hasShareCode = true;
          // Not an alphabet this app mints today; the encoding is what stops a
          // future one from silently producing broken URLs.
          return "a b&c=d";
        };
        const view = await openEditor();

        await click(view.byText("button", "Create code"));

        expect(view.find(".snippet code").textContent).toBe(
          `${window.location.origin}/s/${PLAN_ID}#code=a%20b%26c%3Dd`,
        );
      });

      test("the link copies to the clipboard", async () => {
        const written = clipboard({ allow: true });
        codeState(false);
        const view = await openEditor();
        await click(view.byText("button", "Create code"));

        await click(view.byText("button", "Copy"));

        expect(written).toEqual([
          `${window.location.origin}/s/${PLAN_ID}#code=abcd1234efgh5678`,
        ]);
        expect(view.maybe('.sharing [role="alert"]')).toBeNull();
      });

      test("a refused clipboard says so rather than losing the code silently", async () => {
        clipboard({ allow: false });
        codeState(false);
        const view = await openEditor();
        await click(view.byText("button", "Create code"));

        await click(view.byText("button", "Copy"));

        expect(view.find('.sharing [role="alert"]').textContent).toContain(
          "Could not reach the clipboard",
        );
        // The link is still on screen, which is why saying so is enough.
        expect(view.find(".snippet code").textContent).toContain(
          "code=abcd1234efgh5678",
        );
      });

      test("a later successful copy clears the warning", async () => {
        const mode = { allow: false };
        clipboard(mode);
        codeState(false);
        const view = await openEditor();
        await click(view.byText("button", "Create code"));
        await click(view.byText("button", "Copy"));
        expect(view.maybe('.sharing [role="alert"]')).not.toBeNull();

        mode.allow = true;
        await click(view.byText("button", "Copy"));

        expect(view.maybe('.sharing [role="alert"]')).toBeNull();
      });

      test("the link block is a named focus stop, because it scrolls sideways", async () => {
        codeState(false);
        const view = await openEditor();
        await click(view.byText("button", "Create code"));

        expect(view.find(".snippet").getAttribute("tabindex")).toBe("0");
        expect(view.find(".snippet").getAttribute("aria-label")).toBe(
          "Share link",
        );
      });

      test("removing the code drops the plaintext with it", async () => {
        codeState(false);
        const view = await openEditor();
        await click(view.byText("button", "Create code"));
        expect(view.maybe(".snippet")).not.toBeNull();

        await click(view.byText("button", "Remove"));

        expect(view.maybe(".snippet")).toBeNull();
        expect(view.byText("button", "Create code")).not.toBeNull();
      });

      test("regenerating replaces the shown code rather than appending one", async () => {
        const state = codeState(false);
        let minted = 0;
        api.rotateShareCode = async () => {
          state.hasShareCode = true;
          minted += 1;
          return `code-${minted}`;
        };
        const view = await openEditor();
        await click(view.byText("button", "Create code"));

        await click(view.byText("button", "Regenerate"));

        expect(view.all(".snippet").length).toBe(1);
        expect(view.find(".snippet code").textContent).toContain("code-2");
      });

      test("going public retires the code, so the link on screen goes too", async () => {
        let state = sharing({ hasShareCode: false });
        api.getSharing = async () => state;
        api.rotateShareCode = async () => {
          state = sharing({ hasShareCode: true });
          return "abcd1234";
        };
        api.setVisibility = async () => {
          // Going public retires the code server-side.
          state = sharing({ visibility: "public", hasShareCode: false });
          return state;
        };
        const view = await openEditor();
        await click(view.byText("button", "Create code"));
        expect(view.maybe(".snippet")).not.toBeNull();

        await choose(radio(view, 1));

        // Showing it would hand the owner a link that no longer opens anything.
        expect(view.maybe(".snippet")).toBeNull();
      });

      test("a refused rotation leaves no half-revealed code", async () => {
        api.getSharing = async () => sharing();
        api.rotateShareCode = async () => {
          throw new Error("not yours");
        };
        const view = await openEditor();

        await click(view.byText("button", "Create code"));

        expect(view.maybe(".snippet")).toBeNull();
        expect(view.find(".error").textContent).toBe("not yours");
      });

      test("a refused removal is reported", async () => {
        api.getSharing = async () => sharing({ hasShareCode: true });
        api.clearShareCode = async () => {
          throw new Error("no such plan");
        };
        const view = await openEditor();

        await click(view.byText("button", "Remove"));

        expect(view.find(".error").textContent).toBe("no such plan");
      });

      test("a public plan cannot mint a code", async () => {
        api.getSharing = async () => sharing({ visibility: "public" });
        const view = await openEditor();

        expect(
          view.byText<HTMLButtonElement>("button", "Create code").disabled,
        ).toBe(true);
      });
    });

    describe("grants", () => {
      beforeEach(() => {
        api.getSharing = async () => sharing();
      });

      const field = (view: Mounted) =>
        view.find<HTMLInputElement>(".sharing input[type=text]");

      /**
       * Presses Add.
       *
       * A submit button submits its form, and `hono/jsx` binds the handler to
       * the form's `submit` rather than to the button's `click` - so the event
       * a browser would raise is the one raised here.
       */
      const press = (view: Mounted): Promise<Event> =>
        submitForm(view.find(".sharing form"));

      test("an unshared plan says so", async () => {
        const view = await openEditor();

        expect(view.find(".sharing .empty").textContent).toBe(
          "No accounts yet.",
        );
      });

      test("each granted account is listed with its own named control", async () => {
        api.getSharing = async () =>
          sharing({ grants: ["brisk-heron", "swift-otter"] });
        const view = await openEditor();

        expect(view.all(".tag-list li").length).toBe(2);
        // "Remove" on every row would be a list of identical controls out of
        // context.
        expect(
          view
            .all(".tag-list button")
            .map((node) => node.getAttribute("aria-label")),
        ).toEqual(["Remove brisk-heron", "Remove swift-otter"]);
      });

      test("adding sends the field verbatim for the server to split", async () => {
        api.addGrants = async () => grantResult({ granted: ["a", "b"] });
        const view = await openEditor();

        await type(field(view), "a, b");
        await press(view);

        expect(argsOf("addGrants")).toEqual([PLAN_ID, "a, b"]);
      });

      test("the field is trimmed before it is sent", async () => {
        api.addGrants = async () => grantResult({ granted: ["a"] });
        const view = await openEditor();

        await type(field(view), "  a  ");
        await press(view);

        expect(argsOf("addGrants")[1]).toBe("a");
      });

      test("everything that landed is cleared out of the field", async () => {
        api.addGrants = async () => grantResult({ granted: ["a", "b"] });
        const view = await openEditor();

        await type(field(view), "a, b");
        await press(view);

        expect(field(view).value).toBe("");
      });

      test("a mistyped handle is named and left in the field to correct", async () => {
        api.addGrants = async () =>
          grantResult({ granted: ["good"], unknown: ["tpyo"] });
        const view = await openEditor();

        await type(field(view), "good, tpyo");
        await press(view);

        expect(view.find('.sharing [role="alert"]').textContent).toContain(
          "No account holds tpyo",
        );
        expect(field(view).value).toBe("tpyo");
      });

      test("an account that errored is reported separately and is safe to retry", async () => {
        api.addGrants = async () => grantResult({ failed: ["brisk-heron"] });
        const view = await openEditor();

        await type(field(view), "brisk-heron");
        await press(view);

        expect(view.find('.sharing [role="alert"]').textContent).toContain(
          "Could not share with brisk-heron just now",
        );
        expect(field(view).value).toBe("brisk-heron");
      });

      test("unknown and failed are two lines, because neither speaks for the other", async () => {
        api.addGrants = async () =>
          grantResult({ unknown: ["tpyo"], failed: ["brisk-heron"] });
        const view = await openEditor();

        await type(field(view), "tpyo, brisk-heron");
        await press(view);

        expect(view.all('.sharing [role="alert"]').length).toBe(2);
        expect(field(view).value).toBe("tpyo, brisk-heron");
      });

      test("the previous verdict goes before the next attempt starts", async () => {
        const second = deferred<unknown>();
        let attempt = 0;
        api.addGrants = () => {
          attempt += 1;
          return attempt === 1
            ? Promise.resolve(grantResult({ unknown: ["tpyo"] }))
            : second.answer();
        };
        const view = await openEditor();
        await type(field(view), "tpyo");
        await press(view);
        expect(view.maybe('.sharing [role="alert"]')).not.toBeNull();

        await type(field(view), "corrected");
        await press(view);

        // Otherwise the corrected handle sits under an alert naming the old typo
        // for as long as the request takes.
        expect(view.maybe('.sharing [role="alert"]')).toBeNull();
        second.release(grantResult({ granted: ["corrected"] }));
        await flush();
      });

      test("Add is dead until something is typed", async () => {
        const view = await openEditor();
        expect(view.byText<HTMLButtonElement>("button", "Add").disabled).toBe(
          true,
        );

        await type(field(view), "   ");
        expect(view.byText<HTMLButtonElement>("button", "Add").disabled).toBe(
          true,
        );

        await type(field(view), "a");
        expect(view.byText<HTMLButtonElement>("button", "Add").disabled).toBe(
          false,
        );
      });

      test("Enter on an empty field submits nothing, though the form still fires", async () => {
        const view = await openEditor();

        const event = await press(view);

        // Enter submits a form even when the button beside it is disabled, so the
        // handler has to repeat every guard the button carries.
        expect(countOf("addGrants")).toBe(0);
        expect(event.defaultPrevented).toBe(true);
      });

      test("Enter while public submits nothing either", async () => {
        api.getSharing = async () => sharing({ visibility: "public" });
        const view = await openEditor();
        // The field is disabled, so the value is planted rather than typed.
        field(view).value = "brisk-heron";
        field(view).dispatchEvent(new Event("input", { bubbles: true }));
        await flush();
        // The planted value survived the render, so what refuses below is the
        // public-visibility guard - not an empty field, which the case above
        // already covers and which would pass this without it.
        expect(field(view).value).toBe("brisk-heron");

        await press(view);

        expect(countOf("addGrants")).toBe(0);
      });

      test("revoking sends the handle and refreshes the editor", async () => {
        let grants = ["brisk-heron"];
        api.getSharing = async () => sharing({ grants });
        api.removeGrant = async () => {
          grants = [];
        };
        const view = await openEditor();

        await click(view.byText(".tag-list button", "Remove"));

        expect(argsOf("removeGrant")).toEqual([PLAN_ID, "brisk-heron"]);
        expect(view.find(".sharing .empty").textContent).toBe(
          "No accounts yet.",
        );
      });

      test("a refused revoke leaves the entry in place", async () => {
        api.getSharing = async () => sharing({ grants: ["brisk-heron"] });
        api.removeGrant = async () => {
          throw new Error("no such grant");
        };
        const view = await openEditor();

        await click(view.byText(".tag-list button", "Remove"));

        expect(view.find(".error").textContent).toBe("no such grant");
        expect(view.all(".tag-list li").length).toBe(1);
      });

      test("a refused add is reported on the panel's error line", async () => {
        api.addGrants = async () => {
          throw new Error("too many accounts");
        };
        const view = await openEditor();

        await type(field(view), "a");
        await press(view);

        expect(view.find(".error").textContent).toBe("too many accounts");
      });

      test("a public plan can neither add nor revoke, though the grants stay listed", async () => {
        api.getSharing = async () =>
          sharing({ visibility: "public", grants: ["brisk-heron"] });
        const view = await openEditor();

        // Real state that applies again the moment this goes private, so it is
        // shown rather than hidden - but nothing here acts while public.
        expect(view.find(".tag-list").textContent).toContain("brisk-heron");
        expect(
          view.byText<HTMLButtonElement>(".tag-list button", "Remove").disabled,
        ).toBe(true);
        expect(field(view).disabled).toBe(true);
      });

      test("the field is named per plan", async () => {
        const view = await openEditor();

        expect(field(view).getAttribute("aria-label")).toBe(
          `Share plan ${PLAN_ID} with accounts`,
        );
      });
    });

    test("switching rows remounts the editor, so no code survives the move", async () => {
      api.listPlans = async () => [plan({ id: "aaa" }), plan({ id: "bbb" })];
      const codeFor: Record<string, boolean> = { aaa: false, bbb: false };
      api.getSharing = async (id: string) =>
        sharing({ hasShareCode: codeFor[id] ?? false });
      api.rotateShareCode = async (id: string) => {
        codeFor[id] = true;
        return `code-for-${id}`;
      };
      const view = await mountAsync(<PlansPanel />);

      await click(shareButton(view, 0));
      await click(view.byText("button", "Create code"));
      expect(view.find(".snippet code").textContent).toContain("code-for-aaa");

      await click(shareButton(view, 1));

      // Reusing the instance would leave the previous plan's one-time plaintext
      // on screen under this plan's name.
      expect(view.maybe(".snippet")).toBeNull();
      expect(view.find("#sharing-bbb")).not.toBeNull();
    });
  });
}
