import { useEffect, useLayoutEffect, useRef } from "react";
import { closeBrackets, closeBracketsKeymap, completionStatus } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, Prec, type Extension } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder as placeholderExt,
} from "@codemirror/view";
import { cn } from "@/lib/utils";
import type { VarScope } from "@/lib/variables";
import { External, singleLineFilter } from "./extensions";
import { languageExtension, type EditorLanguage } from "./languages";
import { pakposHighlight, pakposTheme } from "./theme";
import { setVarScope, variables as variablesExt } from "./variables";

export interface CodeEditorProps {
  value: string;
  onChange?: (value: string) => void;
  language?: EditorLanguage;
  readOnly?: boolean;
  /** One line only: newlines are stripped, Enter calls onSubmit. */
  singleLine?: boolean;
  onSubmit?: () => void;
  placeholder?: string;
  ariaLabel: string;
  className?: string;
  /** Line numbers and folding (multi-line editors only). */
  gutters?: boolean;
  /** Receives the view, e.g. to open the search panel. */
  onView?: (view: EditorView | null) => void;
  /**
   * `{{variable}}` highlighting, hover and autocomplete with these variables.
   * Decided at mount: leave it undefined for editors that never show them;
   * later changes update the data without rebuilding the editor.
   */
  variables?: VarScope;
  /** Focus the editor when it mounts, with the cursor at `initialCursor` (default: the end). */
  autoFocus?: boolean;
  initialCursor?: number;
  /** Called when the editor loses focus to something else in the window. */
  onBlur?: () => void;
}

export function CodeEditor({
  value,
  onChange,
  language = "text",
  readOnly = false,
  singleLine = false,
  onSubmit,
  placeholder,
  ariaLabel,
  className,
  gutters = !singleLine,
  onView,
  variables,
  autoFocus = false,
  initialCursor,
  onBlur,
}: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const langComp = useRef(new Compartment());
  const roComp = useRef(new Compartment());
  // Latest callbacks without recreating the editor.
  const cb = useRef({ onChange, onSubmit, onBlur });
  useLayoutEffect(() => {
    cb.current = { onChange, onSubmit, onBlur };
  });

  useEffect(() => {
    const exts: Extension[] = [
      pakposTheme,
      pakposHighlight,
      history(),
      drawSelection(),
      search({ top: true }),
      highlightSelectionMatches(),
      langComp.current.of(languageExtension(language)),
      roComp.current.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
      EditorView.contentAttributes.of({ "aria-label": ariaLabel, spellcheck: "false" }),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && !u.transactions.some((tr) => tr.annotation(External))) {
          cb.current.onChange?.(u.state.doc.toString());
        }
        // A blur because the window lost focus isn't leaving the editor: focus comes back here.
        if (u.focusChanged && !u.view.hasFocus && document.hasFocus()) cb.current.onBlur?.();
      }),
    ];
    if (placeholder) exts.push(placeholderExt(placeholder));
    if (variables) exts.push(variablesExt(variables));
    if (singleLine) {
      exts.push(
        singleLineFilter,
        Prec.highest(
          keymap.of([
            {
              key: "Enter",
              run: (v) => {
                // Enter picks an open completion instead.
                if (completionStatus(v.state) === "active") return false;
                cb.current.onSubmit?.();
                return true;
              },
            },
          ]),
        ),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
      );
    } else {
      exts.push(
        EditorView.lineWrapping,
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        highlightActiveLine(),
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          ...foldKeymap,
          indentWithTab,
        ]),
      );
      if (gutters) exts.push(lineNumbers(), highlightActiveLineGutter(), foldGutter());
    }
    const placeCursor = autoFocus || initialCursor !== undefined;
    const cursor = Math.min(Math.max(initialCursor ?? value.length, 0), value.length);
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: exts,
        selection: placeCursor ? { anchor: cursor } : undefined,
      }),
    });
    view.current = v;
    if (autoFocus) v.focus();
    onView?.(v);
    return () => {
      onView?.(null);
      v.destroy();
      view.current = null;
    };
    // The editor is created once; later prop changes go through compartments below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    view.current?.dispatch({ effects: langComp.current.reconfigure(languageExtension(language)) });
  }, [language]);

  useEffect(() => {
    view.current?.dispatch({
      effects: roComp.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  }, [readOnly]);

  useEffect(() => {
    if (variables) view.current?.dispatch({ effects: setVarScope.of(variables) });
  }, [variables]);

  // External value changes (e.g. URL rewritten from the params table).
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) {
      v.dispatch({
        changes: { from: 0, to: v.state.doc.length, insert: value },
        annotations: [External.of(true)],
      });
    }
  }, [value]);

  return (
    <div
      ref={host}
      data-slot="code-editor"
      className={cn("min-h-0 min-w-0 [&_.cm-editor]:h-full", singleLine && "[&_.cm-content]:py-0", className)}
    />
  );
}
