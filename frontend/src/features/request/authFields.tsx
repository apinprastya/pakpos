import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { VarInput } from "@/components/editor/VarInput";
import { isReferenceOnly } from "./auth";

/** Plain auth fields look like inputs, with {{variable}} support. */
export const fieldClass =
  "h-8 w-full min-w-0 rounded-lg border border-input px-2.5 text-[12.5px] hover:bg-transparent focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30";

export function LiteralHint({ onMove }: { onMove: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <span>This value is saved in the file as plain text.</span>
      <Button type="button" variant="link" size="xs" className="h-auto p-0 text-xs" onClick={onMove}>
        <KeyRound /> Move to secret variable
      </Button>
    </div>
  );
}

export function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[96px_minmax(0,1fr)] items-center gap-x-3 gap-y-1">
      <Label
        htmlFor={id}
        className="text-xs text-muted-foreground"
        // A variable field isn't a labelable element, so focus it by hand.
        onClick={() => {
          const el = document.getElementById(id);
          if (el?.dataset.slot === "var-input") el.focus();
        }}
      >
        {label}
      </Label>
      {children}
      {hint && <div className="col-start-2">{hint}</div>}
    </div>
  );
}

/**
 * A field that usually holds a secret. A literal is masked (with show/hide);
 * a value that is only `{{references}}` (or is being typed as one) is a
 * variable field with highlighting, hover and autocomplete. When typing
 * switches between the two, focus moves to the new field, caret at the end.
 */
export function SecretInput({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const reference = isReferenceOnly(value);
  // Set when the user's own typing switches the mode, so focus follows.
  const refocus = useRef(false);
  const change = (next: string) => {
    if (isReferenceOnly(next) !== reference) refocus.current = true;
    onChange(next);
  };
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    const el = document.getElementById(id);
    el?.focus();
    if (el instanceof HTMLInputElement) el.setSelectionRange(el.value.length, el.value.length);
  }, [reference, id]);

  return reference ? (
    <VarInput id={id} ariaLabel={label} className={fieldClass} value={value} onChange={change} />
  ) : (
    <MaskedInput id={id} value={value} onChange={change} />
  );
}

function MaskedInput({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <Input
        id={id}
        type={shown ? "text" : "password"}
        className="pr-9 font-mono"
        value={value}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        aria-label={shown ? "Hide value" : "Show value"}
        aria-pressed={shown}
        title={shown ? "Hide value" : "Show value"}
        onClick={() => setShown(!shown)}
        className="absolute top-1/2 right-1 flex size-7 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {shown ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
}
