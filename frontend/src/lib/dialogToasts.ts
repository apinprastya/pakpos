import { useEffect } from "react";
import { toast } from "sonner";

/** Toasts to close as soon as a dialog opens (they'd sit over its buttons). */
const pending = new Set<string | number>();

/** Marks a toast to be dismissed when any dialog opens. */
export function dismissOnDialog(id: string | number): void {
  pending.add(id);
}

const DIALOG = '[role="dialog"], [role="alertdialog"]';

function opensDialog(node: Node): boolean {
  return node instanceof Element && (node.matches(DIALOG) || node.querySelector(DIALOG) !== null);
}

/**
 * Watches the document for dialogs (Radix portals them into <body>) and
 * dismisses the marked toasts when one opens. Mounted once, in AppShell.
 */
export function useDismissToastsOnDialog(): void {
  useEffect(() => {
    const observer = new MutationObserver((records) => {
      if (pending.size === 0) return;
      if (!records.some((r) => Array.from(r.addedNodes).some(opensDialog))) return;
      for (const id of pending) toast.dismiss(id);
      pending.clear();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
}
