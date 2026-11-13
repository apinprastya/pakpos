import { useEffect, useLayoutEffect, useRef } from "react";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
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
import { External, singleLineFilter } from "./extensions";
import { languageExtension, type EditorLanguage } from "./languages";
import { pakposHighlight, pakposTheme } from "./theme";

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
}: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const langComp = useRef(new Compartment());
  const roComp = useRef(new Compartment());
  // Latest callbacks without recreating the editor.
  const cb = useRef({ onChange, onSubmit });
  useLayoutEffect(() => {
    cb.current = { onChange, onSubmit };
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
      }),
    ];
    if (placeholder) exts.push(placeholderExt(placeholder));
    if (singleLine) {
      exts.push(
        singleLineFilter,
        Prec.highest(
          keymap.of([
            {
              key: "Enter",
              run: () => {
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
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({ doc: value, extensions: exts }),
    });
    view.current = v;
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
