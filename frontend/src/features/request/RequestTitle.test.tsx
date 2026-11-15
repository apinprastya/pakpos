import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { emptyRequest } from "@/lib/model";
import { col, folder, req } from "@/test/fixtures";
import { activeTab, resetTabs } from "@/test/store";
import { useTabsStore } from "@/stores/tabs";
import { useWorkspaceStore } from "@/stores/workspace";
import { RequestTitle } from "./RequestTitle";

const ws = { id: "w1", name: "Shop API", path: "/work/shop" };

function renderTitle() {
  return render(<RequestTitle tab={activeTab()} />);
}

function openSaved(id: string, name: string, parentId: string) {
  useTabsStore.getState().openSaved({ ...emptyRequest(), id, name }, parentId, ws.id);
}

describe("RequestTitle", () => {
  beforeEach(() => resetTabs());

  it("renames an unsaved request's draft name", async () => {
    const user = userEvent.setup();
    const rename = vi.spyOn(useWorkspaceStore.getState(), "renameRequest");
    const { rerender } = renderTitle();
    await user.click(screen.getByRole("button", { name: /^Rename request/ }));
    const input = await screen.findByRole("textbox", { name: "Request name" });
    await user.clear(input);
    await user.type(input, "Ping{Enter}");
    expect(activeTab().request.name).toBe("Ping");
    expect(rename).not.toHaveBeenCalled();
    rerender(<RequestTitle tab={activeTab()} />);
    expect(screen.getByRole("button", { name: "Rename request Ping" })).toBeInTheDocument();
  });

  it("renames a saved request on disk and shows where it lives", async () => {
    const user = userEvent.setup();
    useWorkspaceStore.setState({
      status: "ready",
      workspace: ws,
      collections: [col("c1", "Users", [folder("f1", "Admin", [req("r1", "List users", "GET", "")])])],
    });
    const rename = vi.spyOn(useWorkspaceStore.getState(), "renameRequest").mockResolvedValue();
    openSaved("r1", "List users", "f1");
    renderTitle();
    expect(screen.getByText("Users / Admin /")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Rename request List users" }));
    const input = await screen.findByRole("textbox", { name: "Request name" });
    expect(input).toHaveValue("List users");
    await user.clear(input);
    await user.type(input, "All users{Enter}");
    expect(rename).toHaveBeenCalledWith("r1", "All users");
  });

  it("cancels with Escape", async () => {
    const user = userEvent.setup();
    renderTitle();
    await user.click(screen.getByRole("button", { name: /^Rename request/ }));
    await user.type(await screen.findByRole("textbox", { name: "Request name" }), "x{Escape}");
    expect(screen.queryByRole("textbox", { name: "Request name" })).not.toBeInTheDocument();
    expect(activeTab().request.name).toBe("");
  });

  it("can't rename a saved request that isn't in the open workspace", () => {
    openSaved("gone", "Old request", "c9");
    renderTitle();
    expect(screen.getByText("Old request")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Rename request/ })).not.toBeInTheDocument();
  });
});
