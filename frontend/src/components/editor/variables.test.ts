import {
  CompletionContext,
  completionStatus,
  currentCompletions,
  startCompletion,
} from "@codemirror/autocomplete";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { makePreviewVar } from "@/test/fixtures";
import { makeScope } from "@/lib/variables";
import {
  infoDom,
  infoText,
  setVarScope,
  showVariableInfo,
  variableCompletions,
  variableHover,
  variables,
  varScopeField,
} from "./variables";

const scope = makeScope(
  [
    makePreviewVar("host", "dev.example"),
    makePreviewVar("token", "", { secret: true, scope: "collection", scopeName: "Users API" }),
  ],
  { id: "e1", name: "Dev" },
  true,
);

let view: EditorView | null = null;
function make(doc: string, extra: Extension = [], cursor = doc.length) {
  view = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc, selection: { anchor: cursor }, extensions: [variables(scope), extra] }),
  });
  return view;
}
afterEach(() => {
  view?.destroy();
  view = null;
});

const marked = (v: EditorView) =>
  [...v.contentDOM.querySelectorAll(".var-token")].map((el) => `${el.textContent}:${el.className}`);

describe("variables extension", () => {
  it("marks resolved, unresolved and dynamic references", () => {
    const v = make("https://{{host}}/{{ missing }}/{{$guid}}/{{token}} {{");
    expect(marked(v)).toEqual([
      "{{host}}:var-token var-resolved",
      "{{ missing }}:var-token var-unresolved",
      "{{$guid}}:var-token var-dynamic",
      "{{token}}:var-token var-resolved",
    ]);
  });

  it("warns about a defined variable that uses an undefined one or loops", () => {
    const v = make("{{url}} {{a}} {{host}}");
    v.dispatch({
      effects: setVarScope.of(
        makeScope(
          [
            makePreviewVar("url", "https://{{missing}}"),
            makePreviewVar("a", "{{b}}"),
            makePreviewVar("b", "{{a}}"),
            makePreviewVar("host", "h"),
          ],
          null,
          true,
        ),
      ),
    });
    expect(marked(v)).toEqual([
      "{{url}}:var-token var-warn",
      "{{a}}:var-token var-warn",
      "{{host}}:var-token var-resolved",
    ]);
    const dom = variableHover(v, 2)!.create(v).dom;
    expect(dom.querySelector(".var-info-warn")).toHaveTextContent(
      "Uses {{missing}}, which is not defined in any active scope",
    );
    expect(variableHover(v, 10)!.create(v).dom).toHaveTextContent("Refers to itself in a loop (a -> b -> a)");
  });

  it("re-marks when the scope or the text changes, without a new editor", () => {
    const v = make("{{host}}\n{{later}}");
    v.dispatch({ effects: setVarScope.of(makeScope([makePreviewVar("later", "x")], null, true)) });
    expect(v.state.field(varScopeField).variables.has("later")).toBe(true);
    expect(marked(v)).toEqual(["{{host}}:var-token var-unresolved", "{{later}}:var-token var-resolved"]);
    v.dispatch({ changes: { from: 0, insert: "{{$timestamp}} " } });
    expect(marked(v)[0]).toBe("{{$timestamp}}:var-token var-dynamic");
  });

  it("describes a reference on hover, nothing elsewhere", () => {
    const v = make("a {{host}} b {{token}} {{nope}}");
    expect(variableHover(v, 0)).toBeNull();
    const tip = variableHover(v, 4)!;
    expect([tip.pos, tip.end]).toEqual([2, 10]);
    const dom = tip.create(v).dom;
    expect(dom).toHaveAttribute("role", "tooltip");
    expect(dom).toHaveTextContent("{{host}}dev.exampleEnvironment: Dev");
    const secret = variableHover(v, 15)!.create(v).dom;
    expect(secret).toHaveTextContent("••••••••");
    expect(secret).not.toHaveTextContent("s3cret");
    expect(variableHover(v, 26)!.create(v).dom).toHaveTextContent("Not defined in any active scope");
  });

  it("shows the same info from the keyboard (Mod+I) and closes it on Escape or a move", async () => {
    const v = make("x {{host}}", [], 5);
    expect(showVariableInfo(v)).toBe(true);
    await new Promise((r) => requestAnimationFrame(r));
    const live = document.querySelector(".cm-tooltip.var-info");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toHaveTextContent("dev.example");
    expect(v.dom.querySelector(".cm-announced")).toHaveTextContent("{{host}}. dev.example. Environment: Dev");
    v.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(document.querySelector(".cm-tooltip.var-info")).toBeNull();

    showVariableInfo(v);
    v.dispatch({ selection: { anchor: 0 } });
    expect(document.querySelector(".cm-tooltip.var-info")).toBeNull();
    // Outside a reference it does nothing, so Mod+I falls through.
    expect(showVariableInfo(v)).toBe(false);
    // Escape without a tooltip isn't handled here.
    v.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(document.querySelector(".cm-tooltip.var-info")).toBeNull();
  });

  it("binds Mod+I", () => {
    const v = make("{{host}}", [], 3);
    v.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", { key: "i", ctrlKey: true, bubbles: true, cancelable: true }),
    );
    expect(document.querySelector(".cm-tooltip.var-info")).not.toBeNull();
  });

  it("reads secrets and notes as text", () => {
    expect(
      infoText({
        kind: "unresolved",
        name: "k",
        value: null,
        note: "Not set on this machine",
        source: "Globals · secret",
        hint: "",
      }),
    ).toBe("{{k}}. Not set on this machine. Globals · secret");
  });

  it("builds tooltip DOM from text only", () => {
    const dom = infoDom({ kind: "resolved", name: "x", value: "<b>hi</b>", note: "", source: "", hint: "" });
    expect(dom.querySelector("b")).toBeNull();
    expect(dom).toHaveTextContent("<b>hi</b>");
  });
});

describe("variable completions", () => {
  function complete(doc: string, pos = doc.length, explicit = false) {
    const state = EditorState.create({ doc, extensions: [variables(scope)] });
    return variableCompletions(new CompletionContext(state, pos, explicit));
  }

  it("offers visible and dynamic variables after {{", () => {
    expect(complete("plain")).toBeNull();
    expect(complete("{")).toBeNull();
    const r = complete("x {{")!;
    expect(r.from).toBe(4);
    const labels = r.options.map((o) => o.label);
    expect(labels).toEqual([
      "host",
      "token",
      "$guid",
      "$randomUUID",
      "$timestamp",
      "$isoTimestamp",
      "$randomInt",
    ]);
    expect(r.options[0].detail).toBe("Environment: Dev");
    expect(r.options[1].detail).toBe("Collection: Users API · secret");
    expect(r.options[2]).toMatchObject({ detail: "Dynamic", info: "A random UUID v4, new for each use." });
  });

  it("starts after spaces and covers the rest of a name being edited", () => {
    expect(complete("{{ ho")!.from).toBe(3);
    const r = complete("{{hoXst}}", 4)!;
    expect([r.from, r.to]).toEqual([2, 7]);
    expect(r.validFor).toBeInstanceOf(RegExp);
  });

  async function accept(doc: string, cursor = doc.length) {
    const v = make(doc, [], cursor);
    startCompletion(v);
    await vi.waitFor(() => expect(currentCompletions(v.state).length).toBeGreaterThan(0));
    expect(completionStatus(v.state)).toBe("active");
    // Completions ignore Enter for a moment after opening (interactionDelay).
    await new Promise((r) => setTimeout(r, 100));
    v.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    return v;
  }

  it("inserts name}} when nothing closes the reference", async () => {
    const v = await accept("{{ho");
    expect(v.state.doc.toString()).toBe("{{host}}");
    expect(v.state.selection.main.head).toBe(8);
  });

  it("reuses closing braces that are already there", async () => {
    const v = await accept("{{h }}/x", 3);
    expect(v.state.doc.toString()).toBe("{{host }}/x");
    expect(v.state.selection.main.head).toBe(9);
  });
});
