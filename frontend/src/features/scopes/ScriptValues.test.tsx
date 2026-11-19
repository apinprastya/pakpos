import { useEffect, useState } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { ScopeRef, Variable } from "@/lib/model";
import { useEnvironmentsStore } from "@/stores/environments";
import { useSecretsStore } from "@/stores/secrets";
import { useWorkspaceStore } from "@/stores/workspace";
import { makeOverlayValue, makeVar } from "@/test/fixtures";
import { applyPersisted } from "./scriptValueActions";
import { VariablesTable } from "./VariablesTable";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

const scope: ScopeRef = { kind: "environment", id: "e1" };
const current: { rows: Variable[]; saved: Variable[] } = { rows: [], saved: [] };

function Harness({ rows, saved }: { rows: Variable[]; saved: Variable[] }) {
  const [state, setState] = useState({ rows, saved });
  useEffect(() => {
    current.rows = state.rows;
    current.saved = state.saved;
  }, [state]);
  return (
    <VariablesTable
      label="Dev variables"
      scope={scope}
      rows={state.rows}
      savedRows={state.saved}
      onChange={(update) => setState((s) => ({ ...s, rows: update(s.rows) }))}
      onSavedOnDisk={(saved, update) => setState((s) => ({ saved, rows: update(s.rows) }))}
    />
  );
}

function setup(rows: Variable[]) {
  const user = userEvent.setup();
  render(<Harness rows={rows} saved={rows} />);
  return user;
}

beforeEach(() => {
  useWorkspaceStore.setState({ workspace: { id: "w1", name: "W", path: "/w" } });
  vi.mocked(api.overlayValues).mockResolvedValue([
    makeOverlayValue("token", "from-script"),
    makeOverlayValue("userId", "42", { state: "new" }),
    makeOverlayValue("gone", "", { state: "unset" }),
  ]);
});

describe("script values in the variables table", () => {
  it("badges rows set by scripts, adds rows only scripts define, and resets", async () => {
    const user = setup([makeVar("token", "file"), makeVar("gone", "x"), makeVar("other", "1")]);
    expect(await screen.findByText("Set by script")).toBeInTheDocument();
    expect(api.overlayValues).toHaveBeenCalledWith(scope);
    expect(screen.getByText("from-script")).toBeInTheDocument();
    expect(screen.getByText("Unset by script")).toBeInTheDocument();
    const virtual = screen.getByRole("row", { name: "userId, set by script" });
    expect(within(virtual).getByText("New, set by script")).toBeInTheDocument();
    expect(within(virtual).getByText("42")).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent("Scripts set 3 values here this session.");

    const version = useEnvironmentsStore.getState().version;
    vi.mocked(api.overlayValues).mockResolvedValue([makeOverlayValue("userId", "42", { state: "new" })]);
    await user.click(screen.getByRole("button", { name: "Reset the script value of token" }));
    expect(api.resetOverlay).toHaveBeenCalledWith(scope, "token");
    await waitFor(() => expect(screen.queryByText("Set by script")).not.toBeInTheDocument());
    expect(useEnvironmentsStore.getState().version).toBeGreaterThan(version);
    expect(screen.getByRole("note")).toHaveTextContent("Scripts set 1 value here");

    vi.mocked(api.overlayValues).mockResolvedValue([]);
    await user.click(screen.getByRole("button", { name: "Reset all script values" }));
    expect(api.resetOverlay).toHaveBeenLastCalledWith(scope, "");
    await waitFor(() => expect(screen.queryByRole("note")).not.toBeInTheDocument());
  });

  it("persists a script value to the file and updates the edited rows", async () => {
    const user = setup([makeVar("token", "file"), makeVar("gone", "x")]);
    vi.mocked(api.persistOverlay).mockResolvedValue([makeVar("token", "from-script"), makeVar("gone", "x")]);
    await user.click(
      await screen.findByRole("button", { name: "Persist the script value of token to the file" }),
    );
    expect(api.persistOverlay).toHaveBeenCalledWith(scope, "token");
    expect(current.rows.map((r) => [r.key, r.value])).toEqual([
      ["token", "from-script"],
      ["gone", "x"],
    ]);
    expect(toast.success).toHaveBeenCalledWith("Saved {{token}} to the file");

    // A new value is added; an unset one is removed.
    vi.mocked(api.persistOverlay).mockResolvedValue([
      makeVar("token", "from-script"),
      makeVar("userId", "42"),
    ]);
    await user.click(screen.getByRole("button", { name: "Persist the script value of gone to the file" }));
    expect(current.rows.map((r) => r.key)).toEqual(["token"]);
    expect(toast.success).toHaveBeenCalledWith("Removed {{gone}} from the file");
  });

  it("unlocks before persisting a secret, and reports failures", async () => {
    vi.mocked(api.overlayValues).mockResolvedValue([makeOverlayValue("pw", "", { secret: true })]);
    const ensureReady = vi.spyOn(useSecretsStore.getState(), "ensureReady").mockResolvedValue(false);
    const user = setup([makeVar("pw", "", { secret: true })]);
    expect(await screen.findByText("••••••••")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Persist the script value of pw to the file" }));
    expect(ensureReady).toHaveBeenCalled();
    expect(api.persistOverlay).not.toHaveBeenCalled();

    ensureReady.mockResolvedValue(true);
    vi.mocked(api.persistOverlay).mockResolvedValue([makeVar("pw", "", { secret: true })]);
    await user.click(screen.getByRole("button", { name: "Persist the script value of pw to the file" }));
    expect(toast.success).toHaveBeenCalledWith("Stored {{pw}} on this machine");

    vi.mocked(api.persistOverlay).mockRejectedValue(new Error("disk full"));
    await user.click(screen.getByRole("button", { name: "Persist the script value of pw to the file" }));
    expect(toast.error).toHaveBeenCalledWith("Couldn't persist the script value", {
      description: "disk full",
    });
    vi.mocked(api.resetOverlay).mockRejectedValue(new Error("nope"));
    await user.click(screen.getByRole("button", { name: "Reset the script value of pw" }));
    expect(toast.error).toHaveBeenCalledWith("Couldn't reset the script value", { description: "nope" });
  });

  it("shows nothing when the overlay can't be read or there's no workspace", async () => {
    vi.mocked(api.overlayValues).mockRejectedValue(new Error("x"));
    setup([makeVar("token", "file")]);
    await waitFor(() => expect(api.overlayValues).toHaveBeenCalled());
    expect(screen.queryByText("Set by script")).not.toBeInTheDocument();
  });

  it("applyPersisted keeps the row's place", () => {
    const rows = [makeVar("a", "1"), makeVar("t", "old"), makeVar("b", "2")];
    expect(applyPersisted(rows, [makeVar("t", "new")], "t").map((r) => r.key + r.value)).toEqual([
      "a1",
      "tnew",
      "b2",
    ]);
    expect(applyPersisted(rows, [], "t").map((r) => r.key)).toEqual(["a", "b"]);
    expect(applyPersisted(rows, [makeVar("n", "1")], "n").map((r) => r.key)).toEqual(["a", "t", "b", "n"]);
  });
});
