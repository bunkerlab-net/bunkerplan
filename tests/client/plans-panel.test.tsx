import "./dom-env.ts";
import { beforeEach, describe, expect, test } from "bun:test";
import { useState } from "hono/jsx";
import { PlansPanel } from "../../src/client/PlansPanel.tsx";
import { MAX_PLAN_LABEL_LENGTH } from "../../src/http/plan-label.ts";
import { api, calls, countOf, plan, sharing, useApiStub } from "./api-stub.ts";
import {
  click,
  deferred,
  flush,
  htmlFile,
  keyboardClick,
  type Mounted,
  mount,
  mountAsync,
  pickFiles,
  type,
  useHarness,
} from "./harness.tsx";
import { registerSharingCases } from "./plans-panel-sharing.cases.tsx";

// Arms the module stubs for this file; unarmed, the real modules answer.
useHarness();
useApiStub();

/**
 * The dashboard's main table: listing, uploading, and the three per-row
 * actions. The sharing editor is a suite of its own.
 *
 * What is pinned here is the panel's contract as a state machine rather than
 * its markup: one busy flag and one error line for every mutation, an
 * optimistic label draft that is rolled back when the server refuses it, and
 * a file gate that keeps a directory drag or a PDF from ever reaching the
 * network.
 */

beforeEach(() => {
  api.listPlans = async () => [];
});

/** A drag or drop event carrying `files`, which happy-dom will not build. */
function fileDrag(
  kind: "dragover" | "dragleave" | "drop",
  files: File[] = [],
  relatedTarget: EventTarget | null = null,
): Event {
  const event = new Event(kind, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: {
      types: files.length > 0 ? ["Files"] : [],
      files: Object.assign([...files], {
        item: (i: number) => files[i] ?? null,
      }),
      dropEffect: "none",
    },
  });
  if (relatedTarget !== null) {
    Object.defineProperty(event, "relatedTarget", { value: relatedTarget });
  }
  return event;
}

/**
 * Every `value` a handler assigns to `node`.
 *
 * happy-dom refuses a non-empty write to a file input, the way the platform
 * does, so the reset the panel performs cannot be observed by seeding a value
 * and watching it disappear. Recording the write is what makes it visible.
 */
function recordValueWrites(node: HTMLInputElement): string[] {
  const written: string[] = [];
  Object.defineProperty(node, "value", {
    configurable: true,
    get: () => "",
    set: (next: string) => {
      written.push(next);
    },
  });
  return written;
}

/** Drops the panel out of the tree, which is how effect teardown is driven. */
function Toggle() {
  const [shown, setShown] = useState(true);
  return (
    <div>
      {shown ? <PlansPanel /> : null}
      <button type="button" id="hide" onClick={() => setShown(false)}>
        hide
      </button>
    </div>
  );
}

describe("PlansPanel listing", () => {
  test("claims nothing while the first list is in flight", async () => {
    const list = deferred<unknown[]>();
    api.listPlans = list.answer;

    const view = mount(<PlansPanel />);
    await flush();
    expect(view.find(".empty").textContent).toBe("Loading…");

    list.release([plan({ id: "abc" })]);
    await flush();
    expect(view.maybe(".empty")).toBeNull();
    expect(view.all("tbody tr").length).toBe(1);
  });

  test("an account with no plans is told so once the list has answered", async () => {
    const view = await mountAsync(<PlansPanel />);

    expect(view.find(".empty").textContent).toBe("No plans yet.");
    expect(view.maybe("table")).toBeNull();
  });

  test("a failed list shows the reason and makes no second claim", async () => {
    api.listPlans = async () => {
      throw new Error("authentication required");
    };
    const view = await mountAsync(<PlansPanel />);

    expect(view.find(".error").textContent).toBe("authentication required");
    expect(view.maybe(".empty")).toBeNull();
  });

  test("a non-Error rejection is still rendered as something readable", async () => {
    api.listPlans = async () => {
      throw "the fetch was aborted";
    };
    const view = await mountAsync(<PlansPanel />);

    expect(view.find(".error").textContent).toBe("the fetch was aborted");
  });

  test("a row shows the id, the size, the date, and the sharing state", async () => {
    const createdAt = "2026-02-03T04:05:06.000Z";
    api.listPlans = async () => [
      plan({ id: "abc123", label: "Q3", size: 4096, createdAt }),
    ];
    const view = await mountAsync(<PlansPanel />);

    const cells = view.all("tbody td");
    expect(view.find<HTMLInputElement>(".label-input").value).toBe("Q3");
    expect(cells[1]?.textContent).toBe("abc123");
    expect(cells[2]?.textContent).toBe("4.0 KiB");
    expect(cells[3]?.textContent).toBe(new Date(createdAt).toLocaleString());
    expect(cells[4]?.textContent).toBe("Private");
    expect(view.find<HTMLAnchorElement>("tbody a").href).toContain("/p/abc123");
  });

  test.each([
    [0, "0 B"],
    [1023, "1023 B"],
    [1024, "1.0 KiB"],
    [1536, "1.5 KiB"],
    [1024 * 1024 - 1, "1024.0 KiB"],
    [1024 * 1024, "1.00 MiB"],
    [2 * 1024 * 1024 + 512 * 1024, "2.50 MiB"],
  ])("a %i byte plan reads as %s", async (size, rendered) => {
    api.listPlans = async () => [plan({ size })];
    const view = await mountAsync(<PlansPanel />);

    expect(view.all("tbody td")[2]?.textContent).toBe(rendered);
  });

  test.each([
    [{ visibility: "public" as const, hasShareCode: false }, "Public"],
    [{ visibility: "public" as const, hasShareCode: true }, "Public"],
    [{ visibility: "private" as const, hasShareCode: true }, "Private + code"],
    [{ visibility: "private" as const, hasShareCode: false }, "Private"],
  ])("%o reads as %s", async (state, rendered) => {
    api.listPlans = async () => [plan(state)];
    const view = await mountAsync(<PlansPanel />);

    expect(view.all("tbody td")[4]?.textContent).toBe(rendered);
  });
});

describe("PlansPanel uploading", () => {
  test("a picked file is uploaded private and the list refreshed", async () => {
    api.uploadPlan = async () => plan({ id: "new" });
    const view = await mountAsync(<PlansPanel />);

    await pickFiles(view.find<HTMLInputElement>("#plan-file"), [htmlFile()]);

    expect(calls.map((call) => call.method)).toEqual([
      "listPlans",
      "uploadPlan",
      "listPlans",
    ]);
    // Never `code`: the dashboard mints a code from the row's Share editor, so
    // there is exactly one place a plaintext code is ever shown.
    expect(calls[1]?.args[1]).toBe("private");
  });

  test("the picker is cleared, so the same file can be picked twice", async () => {
    api.uploadPlan = async () => plan();
    const view = await mountAsync(<PlansPanel />);
    const input = view.find<HTMLInputElement>("#plan-file");
    const written = recordValueWrites(input);

    await pickFiles(input, [htmlFile()]);

    // Without the reset, re-picking the same file fires no second change
    // event and the upload silently does not happen.
    expect(written).toEqual([""]);
  });

  test("a cancelled picker uploads nothing", async () => {
    const view = await mountAsync(<PlansPanel />);

    await pickFiles(view.find<HTMLInputElement>("#plan-file"), []);

    expect(countOf("uploadPlan")).toBe(0);
    expect(view.maybe(".error")).toBeNull();
  });

  test("more than one file is refused before anything is sent", async () => {
    const view = await mountAsync(<PlansPanel />);

    await pickFiles(view.find<HTMLInputElement>("#plan-file"), [
      htmlFile("a.html"),
      htmlFile("b.html"),
    ]);

    expect(view.find(".error").textContent).toBe("Upload one file at a time.");
    expect(countOf("uploadPlan")).toBe(0);
  });

  test("a non-HTML file is refused by name", async () => {
    const view = await mountAsync(<PlansPanel />);

    await pickFiles(view.find<HTMLInputElement>("#plan-file"), [
      new File(["%PDF"], "report.pdf", { type: "application/pdf" }),
    ]);

    expect(view.find(".error").textContent).toBe(
      "report.pdf is not an HTML document.",
    );
    expect(countOf("uploadPlan")).toBe(0);
  });

  test("a file manager drag with no type is accepted on its extension", async () => {
    api.uploadPlan = async () => plan();
    const view = await mountAsync(<PlansPanel />);

    await pickFiles(view.find<HTMLInputElement>("#plan-file"), [
      new File(["<p>x</p>"], "plan.HTM", { type: "" }),
    ]);

    expect(countOf("uploadPlan")).toBe(1);
  });

  test("a rejected document reports the validator's own reasons", async () => {
    api.uploadPlan = async () => {
      throw new Error("external stylesheet\nremote script");
    };
    const view = await mountAsync(<PlansPanel />);

    await pickFiles(view.find<HTMLInputElement>("#plan-file"), [htmlFile()]);

    expect(view.find(".error").textContent).toBe(
      "external stylesheet\nremote script",
    );
  });

  test("the picker is held while an upload is in flight", async () => {
    const upload = deferred<unknown>();
    api.uploadPlan = upload.answer;
    const view = await mountAsync(<PlansPanel />);
    const input = view.find<HTMLInputElement>("#plan-file");

    await pickFiles(input, [htmlFile()]);
    expect(view.find<HTMLInputElement>("#plan-file").disabled).toBe(true);

    upload.release(plan());
    await flush();
    expect(view.find<HTMLInputElement>("#plan-file").disabled).toBe(false);
  });
});

describe("PlansPanel drop zone", () => {
  test("a dragged file marks the zone and asks for a copy cursor", async () => {
    const view = await mountAsync(<PlansPanel />);
    const zone = view.find(".dropzone");

    const event = fileDrag("dragover", [htmlFile()]);
    zone.dispatchEvent(event);
    await flush();

    expect(view.find(".dropzone").className).toContain("is-dragging");
    expect(event.defaultPrevented).toBe(true);
    // The half the name promises: without this the cursor shows a move, which
    // says the dashboard is about to take the file out of its folder.
    expect((event as DragEvent).dataTransfer?.dropEffect).toBe("copy");
  });

  test("leaving the zone clears the mark", async () => {
    const view = await mountAsync(<PlansPanel />);
    view.find(".dropzone").dispatchEvent(fileDrag("dragover", [htmlFile()]));
    await flush();

    view.find(".dropzone").dispatchEvent(fileDrag("dragleave"));
    await flush();

    expect(view.find(".dropzone").className).not.toContain("is-dragging");
  });

  test("crossing a child does not count as leaving", async () => {
    const view = await mountAsync(<PlansPanel />);
    const zone = view.find(".dropzone");
    zone.dispatchEvent(fileDrag("dragover", [htmlFile()]));
    await flush();

    const child = view.find(".dropzone span");
    view.find(".dropzone").dispatchEvent(fileDrag("dragleave", [], child));
    await flush();

    expect(view.find(".dropzone").className).toContain("is-dragging");
  });

  test("a dropped file is uploaded", async () => {
    api.uploadPlan = async () => plan();
    const view = await mountAsync(<PlansPanel />);

    const event = fileDrag("drop", [htmlFile()]);
    view.find(".dropzone").dispatchEvent(event);
    await flush();

    expect(countOf("uploadPlan")).toBe(1);
    expect(event.defaultPrevented).toBe(true);
    expect(view.find(".dropzone").className).not.toContain("is-dragging");
  });

  test("a drop carrying nothing is ignored", async () => {
    const view = await mountAsync(<PlansPanel />);

    view.find(".dropzone").dispatchEvent(fileDrag("drop"));
    await flush();

    expect(countOf("uploadPlan")).toBe(0);
  });

  test("a drop while busy is ignored rather than queued", async () => {
    const upload = deferred<unknown>();
    api.uploadPlan = upload.answer;
    const view = await mountAsync(<PlansPanel />);
    await pickFiles(view.find<HTMLInputElement>("#plan-file"), [htmlFile()]);
    expect(countOf("uploadPlan")).toBe(1);

    view.find(".dropzone").dispatchEvent(fileDrag("drop", [htmlFile()]));
    await flush();

    expect(countOf("uploadPlan")).toBe(1);
    upload.release(plan());
    await flush();
  });

  test("a drag while busy does not mark the zone", async () => {
    const upload = deferred<unknown>();
    api.uploadPlan = upload.answer;
    const view = await mountAsync(<PlansPanel />);
    await pickFiles(view.find<HTMLInputElement>("#plan-file"), [htmlFile()]);

    view.find(".dropzone").dispatchEvent(fileDrag("dragover", [htmlFile()]));
    await flush();

    expect(view.find(".dropzone").className).not.toContain("is-dragging");
    upload.release(plan());
    await flush();
  });

  test("a file dropped anywhere else is swallowed, not navigated to", async () => {
    await mountAsync(<PlansPanel />);
    const elsewhere = document.createElement("div");
    document.body.appendChild(elsewhere);

    const event = fileDrag("drop", [htmlFile()]);
    elsewhere.dispatchEvent(event);

    // Without this the browser leaves the dashboard to render the file.
    expect(event.defaultPrevented).toBe(true);
    elsewhere.remove();
  });

  test("dragging text elsewhere is left alone, so other inputs still take it", async () => {
    await mountAsync(<PlansPanel />);
    const elsewhere = document.createElement("div");
    document.body.appendChild(elsewhere);

    const event = fileDrag("dragover");
    elsewhere.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    elsewhere.remove();
  });
});

describe("PlansPanel labels", () => {
  test("a changed label is committed on blur", async () => {
    api.listPlans = async () => [plan({ id: "abc", label: null })];
    api.relabelPlan = async () => undefined;
    const view = await mountAsync(<PlansPanel />);
    const input = view.find<HTMLInputElement>(".label-input");

    await type(input, "Q3 roadmap");
    input.dispatchEvent(new Event("blur", { bubbles: true }));
    await flush();

    expect(calls.filter((c) => c.method === "relabelPlan")[0]?.args).toEqual([
      "abc",
      "Q3 roadmap",
    ]);
  });

  test("an unchanged label sends nothing", async () => {
    api.listPlans = async () => [plan({ label: "Q3" })];
    const view = await mountAsync(<PlansPanel />);
    const input = view.find<HTMLInputElement>(".label-input");

    input.dispatchEvent(new Event("blur", { bubbles: true }));
    await flush();

    expect(countOf("relabelPlan")).toBe(0);
  });

  test("surrounding whitespace is not a change", async () => {
    api.listPlans = async () => [plan({ label: "Q3" })];
    const view = await mountAsync(<PlansPanel />);
    const input = view.find<HTMLInputElement>(".label-input");

    await type(input, "  Q3  ");
    input.dispatchEvent(new Event("blur", { bubbles: true }));
    await flush();

    expect(countOf("relabelPlan")).toBe(0);
    expect(view.find<HTMLInputElement>(".label-input").value).toBe("Q3");
  });

  test("clearing a label sends null rather than an empty string", async () => {
    api.listPlans = async () => [plan({ id: "abc", label: "Q3" })];
    api.relabelPlan = async () => undefined;
    const view = await mountAsync(<PlansPanel />);

    await type(view.find<HTMLInputElement>(".label-input"), "");
    view
      .find(".label-input")
      .dispatchEvent(new Event("blur", { bubbles: true }));
    await flush();

    expect(calls.filter((c) => c.method === "relabelPlan")[0]?.args).toEqual([
      "abc",
      null,
    ]);
  });

  test("Enter commits by blurring, which is what the field is bound to", async () => {
    api.listPlans = async () => [plan({ id: "abc" })];
    api.relabelPlan = async () => undefined;
    const view = await mountAsync(<PlansPanel />);
    const input = view.find<HTMLInputElement>(".label-input");
    input.focus();

    await type(input, "Q3");
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await flush();

    expect(countOf("relabelPlan")).toBe(1);
  });

  test("Escape restores the stored label and commits nothing", async () => {
    api.listPlans = async () => [plan({ label: "Q3" })];
    const view = await mountAsync(<PlansPanel />);
    const input = view.find<HTMLInputElement>(".label-input");

    await type(input, "typo");
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await flush();

    expect(view.find<HTMLInputElement>(".label-input").value).toBe("Q3");
    input.dispatchEvent(new Event("blur", { bubbles: true }));
    await flush();
    expect(countOf("relabelPlan")).toBe(0);
  });

  test("any other key is left to the field", async () => {
    api.listPlans = async () => [plan({ label: "Q3" })];
    const view = await mountAsync(<PlansPanel />);
    const input = view.find<HTMLInputElement>(".label-input");

    await type(input, "Q4");
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", bubbles: true }),
    );
    await flush();

    expect(view.find<HTMLInputElement>(".label-input").value).toBe("Q4");
  });

  test("a refused relabel rolls the draft back to what the server holds", async () => {
    api.listPlans = async () => [plan({ label: "Q3" })];
    api.relabelPlan = async () => {
      throw new Error("label too long");
    };
    const view = await mountAsync(<PlansPanel />);
    const input = view.find<HTMLInputElement>(".label-input");

    await type(input, "something the server refuses");
    input.dispatchEvent(new Event("blur", { bubbles: true }));
    await flush();

    // Without the rollback the field keeps showing text the server never
    // accepted, beside an error line saying it did not.
    expect(view.find<HTMLInputElement>(".label-input").value).toBe("Q3");
    expect(view.find(".error").textContent).toBe("label too long");
  });

  test("a refresh bringing a different label re-seeds the draft", async () => {
    let label = "Q3";
    api.listPlans = async () => [plan({ id: "abc", label })];
    api.deletePlan = async () => {
      label = "renamed elsewhere";
    };
    const view = await mountAsync(<PlansPanel />);
    expect(view.find<HTMLInputElement>(".label-input").value).toBe("Q3");

    // Any mutation refreshes; delete is simply the shortest way to force one.
    await click(view.byText("button", "Delete"));

    expect(view.find<HTMLInputElement>(".label-input").value).toBe(
      "renamed elsewhere",
    );
  });

  test("the field is capped at the length the server enforces", async () => {
    api.listPlans = async () => [plan()];
    const view = await mountAsync(<PlansPanel />);

    expect(view.find(".label-input").getAttribute("maxlength")).toBe(
      String(MAX_PLAN_LABEL_LENGTH),
    );
  });

  test("the field is named per plan, so a list of them is not identical", async () => {
    api.listPlans = async () => [plan({ id: "abc" })];
    const view = await mountAsync(<PlansPanel />);

    expect(view.find(".label-input").getAttribute("aria-label")).toBe(
      "Label for plan abc",
    );
  });
});

describe("PlansPanel row actions", () => {
  test("Replace opens the hidden picker rather than being one", async () => {
    api.listPlans = async () => [plan()];
    const view = await mountAsync(<PlansPanel />);
    const hidden = view.find<HTMLInputElement>("td .file-input");
    let opened = 0;
    hidden.click = () => {
      opened += 1;
    };

    await click(view.byText("button", "Replace"));

    expect(opened).toBe(1);
    // It carries the picker only; the button above it is the real control.
    expect(hidden.getAttribute("tabindex")).toBe("-1");
    expect(hidden.getAttribute("aria-hidden")).toBe("true");
  });

  test("replacing sends the new file against the same id", async () => {
    api.listPlans = async () => [plan({ id: "abc" })];
    api.replacePlan = async () => undefined;
    const view = await mountAsync(<PlansPanel />);

    await pickFiles(view.find<HTMLInputElement>("td .file-input"), [
      htmlFile("v2.html"),
    ]);

    const [call] = calls.filter((c) => c.method === "replacePlan");
    if (call === undefined) throw new Error("replacePlan was not called");
    expect(call.args[0]).toBe("abc");
    expect((call.args[1] as File).name).toBe("v2.html");
  });

  test("a replacement that is not HTML is refused before anything is sent", async () => {
    api.listPlans = async () => [plan()];
    const view = await mountAsync(<PlansPanel />);

    await pickFiles(view.find<HTMLInputElement>("td .file-input"), [
      new File(["x"], "notes.txt", { type: "text/plain" }),
    ]);

    expect(view.find(".error").textContent).toBe(
      "notes.txt is not an HTML document.",
    );
    expect(countOf("replacePlan")).toBe(0);
  });

  test("the row picker is cleared so the same file can be re-picked", async () => {
    api.listPlans = async () => [plan()];
    api.replacePlan = async () => undefined;
    const view = await mountAsync(<PlansPanel />);
    const input = view.find<HTMLInputElement>("td .file-input");
    const written = recordValueWrites(input);

    await pickFiles(input, [htmlFile("v2.html")]);

    expect(written).toEqual([""]);
  });

  test("deleting removes the row", async () => {
    let rows = [plan({ id: "abc" })];
    api.listPlans = async () => rows;
    api.deletePlan = async () => {
      rows = [];
    };
    const view = await mountAsync(<PlansPanel />);

    await click(view.byText("button", "Delete"));

    expect(view.find(".empty").textContent).toBe("No plans yet.");
  });

  test("a refused delete leaves the row and shows the reason", async () => {
    api.listPlans = async () => [plan()];
    api.deletePlan = async () => {
      throw new Error("no such plan");
    };
    const view = await mountAsync(<PlansPanel />);

    await click(view.byText("button", "Delete"));

    expect(view.find(".error").textContent).toBe("no such plan");
    expect(view.all("tbody tr").length).toBe(1);
  });

  test("one busy flag holds every row control at once", async () => {
    const removal = deferred<void>();
    api.listPlans = async () => [plan(), plan()];
    api.deletePlan = removal.answer;
    const view = await mountAsync(<PlansPanel />);

    view
      .byText("button", "Delete")
      .dispatchEvent(new Event("click", { bubbles: true }));
    await flush();

    expect(
      view.all<HTMLButtonElement>("tbody button").every((b) => b.disabled),
    ).toBe(true);
    expect(
      view.all<HTMLInputElement>(".label-input").every((i) => i.disabled),
    ).toBe(true);

    removal.release();
    await flush();
    expect(
      view.all<HTMLButtonElement>("tbody button").some((b) => b.disabled),
    ).toBe(false);
  });

  test("a successful mutation clears the previous error", async () => {
    api.listPlans = async () => [plan()];
    api.deletePlan = async () => {
      throw new Error("try again");
    };
    const view = await mountAsync(<PlansPanel />);
    await click(view.byText("button", "Delete"));
    expect(view.maybe(".error")).not.toBeNull();

    api.deletePlan = async () => undefined;
    await click(view.byText("button", "Delete"));

    expect(view.maybe(".error")).toBeNull();
  });

  test("the scrolling table is reachable by keyboard", async () => {
    api.listPlans = async () => [plan()];
    const view = await mountAsync(<PlansPanel />);
    const region = view.find(".table-scroll");

    expect(region.getAttribute("tabindex")).toBe("0");
    expect(region.getAttribute("aria-label")).toBe("Plans");
  });
});

/**
 * Opening the editor moves focus into it and closing has to put it back:
 * closing moves focus nowhere on its own, which drops a keyboard user at the
 * top of the document. Three landing places, because each one can be gone by
 * the time it is needed.
 */
describe("PlansPanel sharing expansion", () => {
  beforeEach(() => {
    api.getSharing = async () => sharing();
  });

  test("Share opens the editor below the table and names what it controls", async () => {
    api.listPlans = async () => [plan({ id: "abc", label: "Q3" })];
    const view = await mountAsync(<PlansPanel />);
    const share = view.byText("button", "Share");
    expect(share.getAttribute("aria-expanded")).toBe("false");
    expect(share.getAttribute("aria-controls")).toBe("sharing-abc");

    await click(share);

    expect(view.find("#sharing-abc")).not.toBeNull();
    expect(view.byText("button", "Share").getAttribute("aria-expanded")).toBe(
      "true",
    );
    // Named, because it sits below the table rather than under its own row.
    expect(view.find("#sharing-abc").getAttribute("aria-label")).toBe(
      "Sharing for Q3",
    );
  });

  test("an unlabelled plan falls back to its id in the editor's name", async () => {
    api.listPlans = async () => [plan({ id: "abc", label: null })];
    const view = await mountAsync(<PlansPanel />);

    await click(view.byText("button", "Share"));

    expect(view.find("#sharing-abc").getAttribute("aria-label")).toBe(
      "Sharing for abc",
    );
    expect(view.find("#sharing-abc h3").textContent).toContain("abc");
  });

  test("opening moves focus into the editor", async () => {
    api.listPlans = async () => [plan({ id: "abc" })];
    const view = await mountAsync(<PlansPanel />);

    await keyboardClick(view.byText("button", "Share"));

    expect(document.activeElement).toBe(view.find("#sharing-abc"));
  });

  test("pressing Share again closes it and hands focus back to the button", async () => {
    api.listPlans = async () => [plan({ id: "abc" })];
    const view = await mountAsync(<PlansPanel />);

    await keyboardClick(view.byText("button", "Share"));
    await keyboardClick(view.byText("button", "Share"));

    expect(view.maybe("#sharing-abc")).toBeNull();
    expect(document.activeElement).toBe(view.byText("button", "Share"));
  });

  /**
   * The Share control on a given row, failing at the lookup rather than
   * handing back an `undefined` for a caller to cast away.
   *
   * Re-queried per call on purpose: opening one editor re-renders the table,
   * so a handle taken before the first click can be stale by the second.
   */
  const shareButton = (view: Mounted, index: number): Element => {
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

  test("only one editor is open at a time", async () => {
    api.listPlans = async () => [plan({ id: "aaa" }), plan({ id: "bbb" })];
    const view = await mountAsync(<PlansPanel />);

    await click(shareButton(view, 0));
    expect(view.maybe("#sharing-aaa")).not.toBeNull();

    await click(shareButton(view, 1));
    expect(view.maybe("#sharing-aaa")).toBeNull();
    expect(view.maybe("#sharing-bbb")).not.toBeNull();
  });

  test("deleting the open row closes the editor and lands focus on the table", async () => {
    let rows = [plan({ id: "abc" }), plan({ id: "other" })];
    api.listPlans = async () => rows;
    api.deletePlan = async () => {
      rows = rows.filter((row) => row.id !== "abc");
    };
    const view = await mountAsync(<PlansPanel />);
    await keyboardClick(view.byText("button", "Share"));

    // By its label, like the test below, rather than by a styling class: the
    // first row's is the first match, and `byText` throws if it is not there
    // instead of casting an `undefined` into a click.
    await keyboardClick(view.byText("button", "Delete"));
    // Closing is three rounds deep - the refresh drops the row, that clears
    // the selection, and only then does focus move.
    await flush();

    expect(view.maybe("#sharing-abc")).toBeNull();
    // The button that opened the editor went with its row, so the scrolling
    // table is the nearest thing still on the page.
    expect(document.activeElement).toBe(view.find(".table-scroll"));
  });

  test("deleting the last plan lands focus on the panel heading", async () => {
    let rows = [plan({ id: "abc" })];
    api.listPlans = async () => rows;
    api.deletePlan = async () => {
      rows = [];
    };
    const view = await mountAsync(<PlansPanel />);
    await keyboardClick(view.byText("button", "Share"));

    await keyboardClick(view.byText("button", "Delete"));
    await flush();

    // The table went too, so the heading is the only thing left to land on.
    expect(document.activeElement).toBe(view.find(".card-title"));
    expect(view.find(".card-title").getAttribute("tabindex")).toBe("-1");
  });

  test("the editor follows the list, not the click that opened it", async () => {
    let rows = [plan({ id: "abc", label: "first" })];
    api.listPlans = async () => rows;
    api.relabelPlan = async () => {
      rows = [plan({ id: "abc", label: "renamed" })];
    };
    const view = await mountAsync(<PlansPanel />);
    await click(view.byText("button", "Share"));

    const input = view.find<HTMLInputElement>(".label-input");
    await type(input, "renamed");
    input.dispatchEvent(new Event("blur", { bubbles: true }));
    await flush();

    expect(view.find("#sharing-abc").getAttribute("aria-label")).toBe(
      "Sharing for renamed",
    );
  });

  test("the drag swallower is removed when the panel leaves the page", async () => {
    const view = await mountAsync(<Toggle />);
    await click(view.find("#hide"));

    const elsewhere = document.createElement("div");
    document.body.appendChild(elsewhere);
    const event = fileDrag("drop", [htmlFile()]);
    elsewhere.dispatchEvent(event);

    // Still listening after unmount would keep swallowing drops for a panel
    // that is no longer on the page.
    expect(event.defaultPrevented).toBe(false);
    elsewhere.remove();
  });
});

registerSharingCases();
