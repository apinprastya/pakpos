import { memo, useRef, useState } from "react";
import { caretFromPoint } from "@/lib/caret";
import { cn } from "@/lib/utils";
import { EMPTY_SCOPE } from "@/lib/variables";
import { CodeEditor } from "./CodeEditor";
import { useVarScope } from "./varScopeContext";
import { VarText } from "./VarText";

export interface VarInputProps {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  placeholder?: string;
  /** Enter (when no completion is open). */
  onEnter?: () => void;
  id?: string;
  /** For table keyboard navigation (`[data-row][data-col]`). */
  dataRow?: number;
  dataCol?: string;
  /** Classes for both states, e.g. the size and border of the field. */
  className?: string;
}

/**
 * A one-line field with `{{variable}}` support that stays cheap in big
 * tables: it shows static highlighted text and becomes a single-line
 * CodeMirror editor only while focused (click or Tab), with the caret where
 * it was clicked. On blur it goes back to text, so a table has at most one
 * editor at a time. Variables come from the tab's `VarScopeContext`.
 */
export const VarInput = memo(function VarInput({
  value,
  onChange,
  ariaLabel,
  placeholder,
  onEnter,
  id,
  dataRow,
  dataCol,
  className,
}: VarInputProps) {
  const scope = useVarScope() ?? EMPTY_SCOPE;
  const [editing, setEditing] = useState(false);
  const caret = useRef<number | null>(null);

  if (editing) {
    return (
      <CodeEditor
        singleLine
        autoFocus
        initialCursor={caret.current ?? value.length}
        ariaLabel={ariaLabel}
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        onSubmit={onEnter}
        onBlur={() => {
          caret.current = null;
          setEditing(false);
        }}
        variables={scope}
        className={cn(
          // No line padding, so the text doesn't shift when the static text turns into an editor.
          "flex items-center bg-card ring-1 ring-ring [&_.cm-editor]:w-full [&_.cm-line]:px-0! [&_.cm-scroller]:[scrollbar-width:none]",
          className,
        )}
      />
    );
  }
  return (
    <div
      role="textbox"
      tabIndex={0}
      id={id}
      aria-label={ariaLabel}
      data-row={dataRow}
      data-col={dataCol}
      data-slot="var-input"
      className={cn(
        "flex cursor-text items-center overflow-hidden font-mono whitespace-pre outline-none hover:bg-muted/60",
        className,
      )}
      onMouseDown={(e) => {
        caret.current = caretFromPoint(e.currentTarget, e.clientX, e.clientY);
      }}
      onFocus={() => setEditing(true)}
    >
      {value ? (
        <span className="overflow-hidden text-ellipsis whitespace-pre">
          <VarText text={value} scope={scope} />
        </span>
      ) : (
        placeholder && (
          <span
            data-placeholder=""
            className="overflow-hidden text-ellipsis whitespace-pre text-muted-foreground/60"
          >
            {placeholder}
          </span>
        )
      )}
    </div>
  );
});
