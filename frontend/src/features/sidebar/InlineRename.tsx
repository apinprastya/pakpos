import { useEffect, useRef, useState } from "react";

/** Text field that replaces a tree item's name while renaming. Enter or blur saves, Escape cancels. */
export function InlineRename({
  initial,
  label,
  onCommit,
  onCancel,
}: {
  initial: string;
  label: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  // Enter/Escape unmount the field, which also fires blur: finish only once.
  const done = useRef(false);
  const input = useRef<HTMLInputElement>(null);

  // Rename is often started from a menu, which holds focus until it closes: focus on the next tick.
  useEffect(() => {
    const timer = setTimeout(() => {
      input.current?.focus();
      input.current?.select();
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit && value.trim() && value.trim() !== initial) onCommit(value.trim());
    else onCancel();
  };
  return (
    <input
      ref={input}
      aria-label={label}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
        if (e.key === "Escape") finish(false);
      }}
      onBlur={() => finish(true)}
      className="h-6 min-w-0 flex-1 rounded-sm border border-ring bg-background px-1.5 text-[13px] outline-none"
    />
  );
}
