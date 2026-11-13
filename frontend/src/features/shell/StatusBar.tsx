import { Columns2, Rows2 } from "lucide-react";
import { useLayoutStore } from "@/stores/layout";

export function StatusBar() {
  const orientation = useLayoutStore((s) => s.splitOrientation);
  const toggle = useLayoutStore((s) => s.toggleSplitOrientation);
  const nextLabel =
    orientation === "vertical" ? "Show response beside request" : "Show response below request";

  return (
    <footer className="flex h-6 shrink-0 items-center justify-between border-t bg-sidebar px-3 text-[11px] text-muted-foreground">
      <span>No workspace</span>
      <button
        type="button"
        onClick={toggle}
        aria-label={nextLabel}
        title={nextLabel}
        className="flex items-center gap-1 rounded px-1 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {orientation === "vertical" ? <Rows2 className="size-3.5" /> : <Columns2 className="size-3.5" />}
      </button>
    </footer>
  );
}
