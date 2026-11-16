import { cn } from "@/lib/utils";

/**
 * Empty header space for the macOS window buttons (close, minimise, zoom),
 * which sit over the top-left corner because the window has no title bar.
 * Together the rail's cell and the sidebar's cell reserve 80px of the 40px
 * header row; dragging them moves the window. Not rendered elsewhere.
 */
export function TitleBarSpace({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn("window-drag hidden h-10 shrink-0 border-b bg-sidebar mac:block", className)}
    />
  );
}
