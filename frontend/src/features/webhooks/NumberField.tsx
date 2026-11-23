import { useState } from "react";
import { Input } from "@/components/ui/input";

/**
 * A whole-number field that edits like text: select all and type over it,
 * or clear it and type a new value. Only digits are accepted. The number is
 * passed on as you type; leaving the field empty puts the last value back.
 * (A type="number" input snaps an empty field to 0 and can't be
 * select-all-and-replaced reliably in WebKitGTK.)
 */
export function NumberField({
  id,
  value,
  onChange,
  invalid,
  hint,
}: {
  id: string;
  value: number;
  onChange: (value: number) => void;
  invalid?: boolean;
  /** Shown as the placeholder and the accessible description, e.g. "100–599". */
  hint?: string;
}) {
  // The text being typed; null while not editing, so outside changes show.
  const [text, setText] = useState<string | null>(null);
  return (
    <Input
      id={id}
      inputMode="numeric"
      autoComplete="off"
      spellCheck={false}
      placeholder={hint}
      title={hint}
      aria-invalid={invalid || undefined}
      value={text ?? String(value)}
      onFocus={(e) => {
        setText(String(value));
        e.currentTarget.select();
      }}
      onChange={(e) => {
        const digits = e.target.value.replace(/\D/g, "").slice(0, 9);
        setText(digits);
        if (digits !== "") onChange(Number(digits));
      }}
      onBlur={() => setText(null)}
      className="w-28 font-mono"
    />
  );
}
