import { useEffect, useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { ScopeRef, Variable } from "@/lib/model";
import { makeVar } from "@/test/fixtures";
import { useSecretsStore } from "@/stores/secrets";
import { VariablesTable } from "./VariablesTable";
import { typeInField } from "@/test/editor";

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

function setup(rows: Variable[], saved: Variable[] = rows) {
  const user = userEvent.setup();
  render(<Harness rows={rows} saved={saved} />);
  return user;
}

const table = () => screen.getByRole("table", { name: "Dev variables" });
const btn = (name: string | RegExp) => within(table()).getByRole("button", { name });

beforeEach(() => {
  vi.mocked(toast.error).mockClear();
  vi.mocked(api.secretStatus).mockResolvedValue({ set: ["token"], locked: false });
});

describe("VariablesTable: plain rows", () => {
  it("edits, adds, toggles, deletes and pastes rows", async () => {
    const user = setup([makeVar("a", "1")]);
    typeInField("Value 1", "0");
    expect(current.rows[0].value).toBe("10");
    await user.type(screen.getByLabelText("Variable 2"), "b");
    expect(current.rows).toHaveLength(2);
    expect(current.rows[1]).toEqual(makeVar("b", ""));
    await user.click(screen.getByRole("checkbox", { name: "Enable variable 1" }));
    expect(current.rows[0].enabled).toBe(false);
    await user.click(btn("Delete variable 1"));
    expect(current.rows.map((r) => r.key)).toEqual(["b"]);

    // Enter moves along: key → value → next key.
    await user.click(screen.getByLabelText("Variable 1"));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByLabelText("Value 1")).toHaveFocus());
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByLabelText("Variable 2")).toHaveFocus());

    fireEvent.paste(screen.getByLabelText("Variable 2"), {
      clipboardData: { getData: () => "x: 1\ny: 2" },
    });
    expect(current.rows.map((r) => [r.key, r.value, r.secret])).toEqual([
      ["b", "", false],
      ["x", "1", false],
      ["y", "2", false],
    ]);
    fireEvent.paste(screen.getByLabelText("Variable 1"), { clipboardData: { getData: () => "plain" } });
    expect(current.rows).toHaveLength(3);
  });

  it("moves a value into the secret store when made secret", async () => {
    const user = setup([makeVar("token", "abc"), makeVar("", "orphan"), makeVar("empty", "")]);
    await user.click(btn("Make variable 1 secret"));
    await waitFor(() => expect(api.setSecret).toHaveBeenCalledWith(scope, "token", "abc"));
    expect(current.rows[0]).toEqual(makeVar("token", "", { secret: true }));
    expect(btn("Make variable 1 plain")).toHaveAttribute("aria-pressed", "true");

    await user.click(btn("Make variable 2 secret"));
    expect(toast.error).toHaveBeenCalledWith("Name the variable before making it secret");
    expect(current.rows[1].secret).toBe(false);

    await user.click(btn("Make variable 3 secret"));
    expect(api.setSecret).toHaveBeenCalledTimes(1);
    expect(current.rows[2].secret).toBe(true);
  });

  it("keeps the row plain when the store refuses or the user cancels unlocking", async () => {
    const user = setup([makeVar("token", "abc")]);
    vi.mocked(api.setSecret).mockRejectedValueOnce(new Error("The secret store is locked."));
    await user.click(btn("Make variable 1 secret"));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't store the secret value", {
        description: "The secret store is locked.",
      }),
    );
    expect(current.rows[0].secret).toBe(false);

    vi.mocked(api.secretsStatus).mockResolvedValue({ backend: "file", hasPassword: true, locked: true });
    await user.click(btn("Make variable 1 secret"));
    await waitFor(() => expect(useSecretsStore.getState().dialog).toBe("unlock"));
    act(() => useSecretsStore.getState().closeDialog(false));
    await waitFor(() => expect(current.rows[0].secret).toBe(false));
  });
});

describe("VariablesTable: secret rows", () => {
  const saved = [makeVar("token", "", { secret: true }), makeVar("apiKey", "", { secret: true })];

  it("masks set values and says when a value is missing", async () => {
    setup(saved);
    expect(await within(table()).findByLabelText("Value hidden")).toBeInTheDocument();
    expect(within(table()).getByText("Not set on this machine")).toBeInTheDocument();
    expect(api.secretStatus).toHaveBeenCalledWith(scope);
    expect(within(table()).queryByRole("button", { name: "Show value of apiKey" })).not.toBeInTheDocument();
  });

  it("reveals a value on click and hides it again", async () => {
    vi.mocked(api.revealSecret).mockResolvedValue("s3cret");
    const user = setup(saved);
    await user.click(await within(table()).findByRole("button", { name: "Show value of token" }));
    expect(api.revealSecret).toHaveBeenCalledWith(scope, "token");
    expect(await within(table()).findByText("s3cret")).toBeInTheDocument();
    await user.click(btn("Hide value of token"));
    expect(within(table()).queryByText("s3cret")).not.toBeInTheDocument();

    vi.mocked(api.revealSecret).mockRejectedValueOnce(new Error("No value is stored"));
    await user.click(btn("Show value of token"));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't show the value of token", {
        description: "No value is stored",
      }),
    );
  });

  it("drops a revealed value when the key changes", async () => {
    vi.mocked(api.revealSecret).mockResolvedValue("s3cret");
    const user = setup(saved);
    await user.click(await within(table()).findByRole("button", { name: "Show value of token" }));
    await within(table()).findByText("s3cret");
    await user.type(screen.getByLabelText("Variable 1"), "2");
    expect(within(table()).queryByText("s3cret")).not.toBeInTheDocument();
  });

  it("sets a value with Enter, cancels with Escape, and clears", async () => {
    const user = setup(saved);
    await user.click(await within(table()).findByRole("button", { name: "Set value of apiKey" }));
    const input = screen.getByLabelText("New value for apiKey");
    expect(input).toHaveAttribute("type", "password");
    await user.type(input, "k3y{Enter}");
    await waitFor(() => expect(api.setSecret).toHaveBeenCalledWith(scope, "apiKey", "k3y"));
    expect(current.rows).toEqual(saved); // the value never enters the rows

    await user.click(btn("Change value of token"));
    await user.type(screen.getByLabelText("New value for token"), "zzz{Escape}");
    expect(api.setSecret).toHaveBeenCalledTimes(1);

    await user.click(btn("Clear value of token"));
    await waitFor(() => expect(api.clearSecret).toHaveBeenCalledWith(scope, "token"));
  });

  it("commits on blur and reports store errors", async () => {
    const user = setup(saved);
    vi.mocked(api.setSecret).mockRejectedValueOnce(new Error("locked"));
    await user.click(await within(table()).findByRole("button", { name: "Set value of apiKey" }));
    await user.type(screen.getByLabelText("New value for apiKey"), "x");
    await user.click(document.body);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't store the value of apiKey", {
        description: "locked",
      }),
    );
    vi.mocked(api.clearSecret).mockRejectedValueOnce(new Error("nope"));
    await user.click(btn("Clear value of token"));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't clear the value of token", { description: "nope" }),
    );
  });

  it("remembers a secret row's saved key when it's renamed, for the save", async () => {
    const user = setup([...saved, makeVar("plain", "1")]);
    await user.type(screen.getByLabelText("Variable 1"), "2");
    await user.clear(screen.getByLabelText("Variable 1"));
    await user.type(screen.getByLabelText("Variable 1"), "apiToken");
    await user.type(screen.getByLabelText("Variable 3"), "X");
    await waitFor(() =>
      expect(current.rows[0]).toEqual({ ...makeVar("apiToken", "", { secret: true }), origin: "token" }),
    );
    expect(current.rows[2]).toEqual(makeVar("plainX", "1")); // plain rows need no origin
  });

  it("asks for a name before setting a value", async () => {
    const user = setup([makeVar("", "", { secret: true })], []);
    await user.click(btn("Set value of variable 1"));
    expect(toast.error).toHaveBeenCalledWith("Name the variable before setting its value");
  });

  it("offers to unlock when the store is locked", async () => {
    vi.mocked(api.secretStatus).mockResolvedValue({ set: [], locked: true });
    const user = setup(saved);
    const unlock = await within(table()).findAllByRole("button", { name: "Locked. Unlock to use it" });
    await user.click(unlock[0]);
    expect(useSecretsStore.getState().dialog).toBe("unlock");
  });

  it("shows status errors", async () => {
    vi.mocked(api.secretStatus).mockRejectedValue(new Error("keychain broke"));
    setup(saved);
    expect(await screen.findByRole("alert")).toHaveTextContent("keychain broke");
  });

  it("makes a saved secret plain in Go after confirming", async () => {
    vi.mocked(api.makeVariablePlain).mockResolvedValue([makeVar("token", "s3cret"), saved[1]]);
    const user = setup(saved);
    await user.click(btn("Make variable 1 plain"));
    const dialog = await screen.findByRole("alertdialog", { name: "Store {{token}} in plain text?" });
    expect(dialog).toHaveTextContent(/written to the workspace file now/);
    await user.click(within(dialog).getByRole("button", { name: "Keep it secret" }));
    expect(api.makeVariablePlain).not.toHaveBeenCalled();

    await user.click(btn("Make variable 1 plain"));
    await user.click(await screen.findByRole("button", { name: "Store in plain text" }));
    await waitFor(() => expect(api.makeVariablePlain).toHaveBeenCalledWith(scope, "token"));
    expect(current.rows[0]).toEqual(makeVar("token", "s3cret"));
    expect(current.saved[0]).toEqual(makeVar("token", "s3cret"));

    vi.mocked(api.makeVariablePlain).mockRejectedValueOnce(new Error("locked"));
    await user.click(btn("Make variable 2 plain"));
    await user.click(await screen.findByRole("button", { name: "Store in plain text" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't make the variable plain", { description: "locked" }),
    );
  });

  it("unlocks before making a secret plain when the file store is locked", async () => {
    useSecretsStore.setState({ status: { backend: "file", hasPassword: true, locked: true } });
    vi.mocked(api.secretsStatus).mockResolvedValue({ backend: "file", hasPassword: true, locked: true });
    const user = setup(saved);
    await user.click(btn("Make variable 1 plain"));
    await user.click(await screen.findByRole("button", { name: "Store in plain text" }));
    await waitFor(() => expect(useSecretsStore.getState().dialog).toBe("unlock"));
    act(() => useSecretsStore.getState().closeDialog(false));
    await waitFor(() => expect(useSecretsStore.getState().dialog).toBeNull());
    expect(api.makeVariablePlain).not.toHaveBeenCalled();
  });

  it("makes an unsaved secret plain without Go, clearing a value set this session", async () => {
    const user = setup([makeVar("fresh", "v")], []);
    await user.click(btn("Make variable 1 secret"));
    await waitFor(() => expect(current.rows[0].secret).toBe(true));
    expect(within(table()).getByLabelText("Value hidden")).toBeInTheDocument();
    await user.click(btn("Make variable 1 plain"));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(/enter the value again/);
    vi.mocked(api.clearSecret).mockRejectedValueOnce(new Error("ignored"));
    await user.click(within(dialog).getByRole("button", { name: "Store in plain text" }));
    await waitFor(() => expect(current.rows[0]).toEqual(makeVar("fresh", "")));
    expect(api.clearSecret).toHaveBeenCalledWith(scope, "fresh");
    expect(api.makeVariablePlain).not.toHaveBeenCalled();
  });
});
