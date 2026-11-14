import { renderHook } from "@testing-library/react";
import { toast } from "sonner";
import { dismissOnDialog, useDismissToastsOnDialog } from "./dialogToasts";

const flush = () => new Promise((r) => setTimeout(r, 0));

function add(html: string) {
  const el = document.createElement("div");
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

describe("dismissing toasts when a dialog opens", () => {
  it("dismisses marked toasts once, only for dialogs", async () => {
    const dismiss = vi.spyOn(toast, "dismiss");
    const { unmount } = renderHook(() => useDismissToastsOnDialog());

    // Nothing marked: a dialog changes nothing.
    add('<div role="dialog"></div>').remove();
    await flush();
    expect(dismiss).not.toHaveBeenCalled();

    dismissOnDialog("paste");
    add('<div role="menu"></div>').remove();
    document.body.appendChild(document.createTextNode("text"));
    await flush();
    expect(dismiss).not.toHaveBeenCalled();

    const portal = add('<div><div role="alertdialog"></div></div>');
    await flush();
    expect(dismiss).toHaveBeenCalledWith("paste");
    portal.remove();

    dismiss.mockClear();
    add('<div role="dialog"></div>');
    await flush();
    expect(dismiss).not.toHaveBeenCalled();
    unmount();
    dismiss.mockRestore();
  });
});
