import { useRef } from "react";
import { clampSplit, MAX_SPLIT, MIN_SPLIT, type ColumnSplit } from "@/hooks/useColumnSplit";
import { cn } from "@/lib/utils";

interface Props {
  /** Name of the column on the resizer's left, e.g. "Key". */
  column: string;
  split: ColumnSplit;
  className?: string;
}

/**
 * The drag handle on the right edge of a table's first flexible header cell
 * (put it inside that cell, which must be `relative`). Dragging moves width
 * between the cells marked SPLIT_A and SPLIT_B in the same row. Arrow keys
 * step it (Shift for bigger steps), Home/End go to the limits, and a double
 * click resets it.
 */
export function ColumnResizer({ column, split, className }: Props) {
  const drag = useRef<{ x: number; a: number; total: number } | null>(null);
  const { ratio, setRatio, reset } = split;

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const row = e.currentTarget.closest('[role="row"]');
    const a = row?.querySelector('[data-split="a"]')?.getBoundingClientRect().width ?? 0;
    const b = row?.querySelector('[data-split="b"]')?.getBoundingClientRect().width ?? 0;
    if (a + b <= 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, a, total: a + b };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    setRatio((d.a + e.clientX - d.x) / d.total);
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    const next =
      e.key === "ArrowLeft"
        ? ratio - step
        : e.key === "ArrowRight"
          ? ratio + step
          : e.key === "Home"
            ? MIN_SPLIT
            : e.key === "End"
              ? MAX_SPLIT
              : null;
    if (next === null) return;
    e.preventDefault();
    setRatio(clampSplit(next));
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${column} column`}
      aria-valuemin={Math.round(MIN_SPLIT * 100)}
      aria-valuemax={Math.round(MAX_SPLIT * 100)}
      aria-valuenow={Math.round(ratio * 100)}
      title="Drag to resize, double-click to reset"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      onDoubleClick={reset}
      className={cn(
        "absolute top-0 -right-1 z-10 h-full w-2 cursor-col-resize touch-none outline-none",
        "after:absolute after:inset-y-0.5 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-border after:opacity-0 after:transition-opacity",
        "hover:after:opacity-100 focus-visible:after:w-0.5 focus-visible:after:bg-ring focus-visible:after:opacity-100",
        className,
      )}
    />
  );
}
