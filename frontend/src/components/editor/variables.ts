import {
  autocompletion,
  pickedCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { Prec, RangeSetBuilder, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  hoverTooltip,
  keymap,
  showTooltip,
  type DecorationSet,
  type Tooltip,
  type ViewUpdate,
} from "@codemirror/view";
import { tokenAt, varTokens, type VarToken } from "@/lib/varTokens";
import {
  DYNAMIC_VARIABLES,
  EMPTY_SCOPE,
  describeVar,
  scopeLabel,
  varKind,
  type VarInfo,
  type VarScope,
} from "@/lib/variables";

/** Replaces the variables an editor knows about (no editor rebuild). */
export const setVarScope = StateEffect.define<VarScope>();

export const varScopeField = StateField.define<VarScope>({
  create: () => EMPTY_SCOPE,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setVarScope)) return e.value;
    return value;
  },
});

/** The CSS classes of a reference (shared with the static renderer, see index.css). */
export function varClass(name: string, scope: VarScope): string {
  return `var-token var-${varKind(name, scope)}`;
}

const markCache = new Map<string, Decoration>();
function mark(cls: string): Decoration {
  let m = markCache.get(cls);
  if (!m) {
    m = Decoration.mark({ class: cls });
    markCache.set(cls, m);
  }
  return m;
}

/** References are found line by line: a name can't span lines, so this matches Go. */
function decorate(view: EditorView): DecorationSet {
  const scope = view.state.field(varScopeField);
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      for (const t of varTokens(line.text, line.from))
        builder.add(t.from, t.to, mark(varClass(t.name, scope)));
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

const highlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = decorate(view);
    }
    update(u: ViewUpdate) {
      if (
        u.docChanged ||
        u.viewportChanged ||
        u.startState.field(varScopeField) !== u.state.field(varScopeField)
      ) {
        this.decorations = decorate(u.view);
      }
    }
  },
  {
    // Outer decorations wrap every other mark (syntax, bracket matching), so a
    // reference stays one span instead of being split around them.
    provide: (plugin) =>
      EditorView.outerDecorations.of((view) => view.plugin(plugin)?.decorations ?? Decoration.none),
  },
);

/** The reference at pos, from its line. */
function tokenAtPos(view: EditorView, pos: number): VarToken | null {
  const line = view.state.doc.lineAt(pos);
  return tokenAt(line.text, pos, line.from);
}

/** Tooltip content for a reference. Text only (no innerHTML): values are user data. */
export function infoDom(info: VarInfo, live = false): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "var-info";
  dom.setAttribute("role", live ? "status" : "tooltip");
  if (live) dom.setAttribute("aria-live", "polite");
  const add = (cls: string, text: string, tag = "div") => {
    const el = document.createElement(tag);
    el.className = cls;
    el.textContent = text;
    dom.appendChild(el);
    return el;
  };
  add(`var-info-name var-${info.kind}`, `{{${info.name}}}`);
  if (info.value !== null) add("var-info-value", info.value);
  if (info.note) add(info.kind === "warn" ? "var-info-note var-info-warn" : "var-info-note", info.note);
  if (info.source) add("var-info-source", info.source);
  if (info.hint) add("var-info-hint", info.hint);
  return dom;
}

/** The info as one sentence-ish line, for screen readers. */
export function infoText(info: VarInfo): string {
  return [`{{${info.name}}}`, info.value ?? info.note, info.source, info.hint].filter(Boolean).join(". ");
}

function tooltipFor(view: EditorView, t: VarToken, live: boolean): Tooltip {
  return {
    pos: t.from,
    end: t.to,
    above: true,
    create: () => ({ dom: infoDom(describeVar(t.name, view.state.field(varScopeField)), live) }),
  };
}

/** The hover tooltip for the reference at pos, if any. */
export function variableHover(view: EditorView, pos: number): Tooltip | null {
  const t = tokenAtPos(view, pos);
  return t ? tooltipFor(view, t, false) : null;
}

const varHover = hoverTooltip(variableHover, { hoverTime: 300, hideOnChange: true });

/** The tooltip opened from the keyboard (Mod+I); closes on any edit, move or Escape. */
const showInfo = StateEffect.define<Tooltip | null>();
const keyboardInfo = StateField.define<Tooltip | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(showInfo)) return e.value;
    return tr.docChanged || tr.selection ? null : value;
  },
  provide: (f) => showTooltip.from(f),
});

/** Shows the info of the reference at the cursor. False (so Mod+I falls through) when there's none. */
export function showVariableInfo(view: EditorView): boolean {
  const t = tokenAtPos(view, view.state.selection.main.head);
  if (!t) return false;
  const info = describeVar(t.name, view.state.field(varScopeField));
  // Also announced through CodeMirror's live region, for screen readers.
  view.dispatch({
    effects: [showInfo.of(tooltipFor(view, t, true)), EditorView.announce.of(infoText(info))],
  });
  return true;
}

function closeVariableInfo(view: EditorView): boolean {
  if (!view.state.field(keyboardInfo)) return false;
  view.dispatch({ effects: showInfo.of(null) });
  return true;
}

/** Inserts `name}}`, reusing closing braces that are already there. */
function applyName(view: EditorView, completion: Completion, from: number, to: number) {
  const name = completion.label;
  const after = view.state.doc.sliceString(to, Math.min(view.state.doc.length, to + 64));
  const close = /^[ \t]*\}\}/.exec(after);
  const insert = close ? name : `${name}}}`;
  const end = from + name.length + (close ? close[0].length : 2);
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: end },
    annotations: pickedCompletion.of(completion),
    userEvent: "input.complete",
    scrollIntoView: true,
  });
}

const NAME_CHARS = /^[^{}\s]*/;

/** Offers the visible and dynamic variables after `{{`. */
export function variableCompletions(ctx: CompletionContext): CompletionResult | null {
  const before = ctx.matchBefore(/\{\{[ \t]*[^{}\s]*/);
  if (!before) return null;
  const from = before.from + /^\{\{[ \t]*/.exec(before.text)![0].length;
  const line = ctx.state.doc.lineAt(ctx.pos);
  const rest = NAME_CHARS.exec(line.text.slice(ctx.pos - line.from))![0];
  const scope = ctx.state.field(varScopeField);
  const options: Completion[] = [];
  for (const v of scope.variables.values()) {
    options.push({
      label: v.key,
      detail: scopeLabel(v.scope, v.scopeName) + (v.secret ? " · secret" : ""),
      type: "variable",
      apply: applyName,
    });
  }
  for (const d of DYNAMIC_VARIABLES) {
    options.push({
      label: d.name,
      detail: "Dynamic",
      info: d.description,
      type: "constant",
      apply: applyName,
      boost: -1,
    });
  }
  return { from, to: ctx.pos + rest.length, options, validFor: /^[^{}\s]*$/ };
}

const varTheme = EditorView.baseTheme({
  ".cm-tooltip.cm-tooltip-autocomplete > ul": { fontFamily: "var(--font-mono)", fontSize: "12px" },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": { padding: "2px 8px" },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "var(--accent)",
    color: "var(--accent-foreground)",
  },
  ".cm-completionDetail": {
    fontFamily: "var(--font-sans)",
    fontStyle: "normal",
    color: "var(--muted-foreground)",
    marginLeft: "1em",
  },
  ".cm-completionInfo": { fontFamily: "var(--font-sans)", fontSize: "12px", padding: "4px 8px" },
  ".cm-completionIcon": { display: "none" },
});

/**
 * `{{variable}}` support for an editor: highlighting (resolved, unresolved,
 * dynamic), a hover tooltip, Mod+I to show the same info from the keyboard,
 * and autocomplete after `{{`. Feed it data with `setVarScope`.
 */
export function variables(initial: VarScope = EMPTY_SCOPE): Extension {
  return [
    varScopeField.init(() => initial),
    highlighter,
    varHover,
    keyboardInfo,
    varTheme,
    autocompletion({ override: [variableCompletions], icons: false }),
    Prec.high(
      keymap.of([
        { key: "Mod-i", run: showVariableInfo },
        { key: "Escape", run: closeVariableInfo },
      ]),
    ),
  ];
}
