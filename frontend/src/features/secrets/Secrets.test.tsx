import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { useSecretsStore } from "@/stores/secrets";
import { fileStoreState, newPasswordError, passwordStrength } from "./password";
import { LockIndicator, SecretsSection } from "./SecretsControls";
import { SecretsDialogs } from "./SecretsDialogs";

const file = (hasPassword: boolean, locked: boolean) => ({ backend: "file" as const, hasPassword, locked });
const store = () => useSecretsStore.getState();

function renderUi(ui: React.ReactNode) {
  const user = userEvent.setup();
  render(
    <TooltipProvider>
      {ui}
      <SecretsDialogs />
    </TooltipProvider>,
  );
  return user;
}

describe("password helpers", () => {
  it("rates strength", () => {
    expect(passwordStrength("short").strength).toBe("too-short");
    expect(passwordStrength("abcdefgh").strength).toBe("weak");
    expect(passwordStrength("abcdefghijkl").strength).toBe("fair");
    expect(passwordStrength("Abc1efgh").strength).toBe("fair");
    expect(passwordStrength("Abcdefgh1234").strength).toBe("strong");
  });

  it("validates a new password and its confirmation", () => {
    expect(newPasswordError("short", "short")).toMatch(/at least 8/);
    expect(newPasswordError("longenough", "other")).toMatch(/don't match/);
    expect(newPasswordError("longenough", "longenough")).toBeNull();
  });

  it("describes the file store", () => {
    expect(fileStoreState(file(false, true)).label).toBe("No master password set");
    expect(fileStoreState(file(true, true)).action).toBe("Unlock secrets");
    expect(fileStoreState(file(true, false)).action).toBe("Lock secrets");
  });
});

describe("set password dialog", () => {
  it("validates, warns and sets the password", async () => {
    const user = renderUi(null);
    const ready = store().ensureReady.bind(null);
    vi.mocked(api.secretsStatus).mockResolvedValue(file(false, true));
    const waiting = ready();
    const dialog = await screen.findByRole("dialog", { name: "Set a master password" });
    expect(dialog).toHaveTextContent(/can't be recovered/);
    const pw = within(dialog).getByLabelText("Master password");
    await user.type(pw, "abc");
    expect(within(dialog).getByText(/Too short/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Set password" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Use at least 8 characters.");

    await user.type(pw, "defgh1234X");
    expect(within(dialog).getByText("Strong password.")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Confirm master password"), "nope");
    await user.click(within(dialog).getByRole("button", { name: "Set password" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent(/don't match/);

    await user.clear(within(dialog).getByLabelText("Confirm master password"));
    await user.type(within(dialog).getByLabelText("Confirm master password"), "abcdefgh1234X");
    vi.mocked(api.setMasterPassword).mockRejectedValueOnce(new Error("Enter a master password."));
    await user.click(within(dialog).getByRole("button", { name: "Set password" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Enter a master password.");

    await user.click(within(dialog).getByRole("button", { name: "Set password" }));
    expect(await waiting).toBe(true);
    expect(api.setMasterPassword).toHaveBeenLastCalledWith("abcdefgh1234X");
  });

  it("cancels", async () => {
    const user = renderUi(null);
    store().openDialog("set-password");
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(store().dialog).toBeNull();
  });
});

describe("unlock dialog", () => {
  it("shows a wrong password and unlocks", async () => {
    const user = renderUi(null);
    store().openDialog("unlock");
    const dialog = await screen.findByRole("dialog", { name: "Unlock secrets" });
    await user.click(within(dialog).getByRole("button", { name: "Unlock" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Enter your master password.");
    vi.mocked(api.unlockSecrets).mockRejectedValueOnce(
      new Error("Wrong password, or the secrets file is damaged."),
    );
    await user.type(within(dialog).getByLabelText("Master password"), "bad{Enter}");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Wrong password, or the secrets file is damaged.",
    );
    await user.type(within(dialog).getByLabelText("Master password"), "good{Enter}");
    await waitFor(() => expect(store().dialog).toBeNull());
    expect(api.unlockSecrets).toHaveBeenLastCalledWith("badgood");
  });

  it("leads to a destructive reset", async () => {
    const user = renderUi(null);
    store().openDialog("unlock");
    await user.click(await screen.findByRole("button", { name: "Reset secret store…" }));
    const alert = await screen.findByRole("alertdialog", { name: "Reset the secret store?" });
    expect(alert).toHaveTextContent(/keep their names/);
    vi.mocked(api.resetSecretStore).mockRejectedValueOnce(new Error("permission denied"));
    await user.click(within(alert).getByRole("button", { name: "Reset secret store" }));
    expect(await within(alert).findByRole("alert")).toHaveTextContent("permission denied");
    await user.click(within(alert).getByRole("button", { name: "Reset secret store" }));
    await waitFor(() => expect(store().dialog).toBeNull());
    expect(api.resetSecretStore).toHaveBeenCalledTimes(2);
  });
});

describe("change password dialog", () => {
  it("checks the fields and changes the password", async () => {
    const user = renderUi(null);
    store().openDialog("change-password");
    const dialog = await screen.findByRole("dialog", { name: "Change master password" });
    const submit = () => user.click(within(dialog).getByRole("button", { name: "Change password" }));
    await submit();
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Enter your current master password.");
    await user.type(within(dialog).getByLabelText("Current password"), "old");
    await submit();
    expect(within(dialog).getByRole("alert")).toHaveTextContent(/at least 8/);
    await user.type(within(dialog).getByLabelText("New password"), "newpassword");
    await user.type(within(dialog).getByLabelText("Confirm new password"), "newpassword");
    vi.mocked(api.changeMasterPassword).mockRejectedValueOnce(
      new Error("Wrong password, or the secrets file is damaged."),
    );
    await submit();
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/Wrong password/);
    await submit();
    await waitFor(() => expect(store().dialog).toBeNull());
    expect(api.changeMasterPassword).toHaveBeenLastCalledWith("old", "newpassword");
  });
});

describe("secrets section and lock indicator", () => {
  it("describes the keychain, with no lock indicator", async () => {
    vi.mocked(api.secretsStatus).mockResolvedValue({
      backend: "keychain",
      hasPassword: false,
      locked: false,
    });
    renderUi(
      <>
        <SecretsSection />
        <LockIndicator />
      </>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Checking the secret store…");
    expect(await screen.findByText("System keychain")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Secrets/ })).not.toBeInTheDocument();
  });

  it("offers set password, unlock, lock, change and reset for the file store", async () => {
    vi.mocked(api.secretsStatus).mockResolvedValue(file(false, true));
    const user = renderUi(
      <>
        <SecretsSection />
        <LockIndicator />
      </>,
    );
    await user.click(await screen.findByRole("button", { name: "Set master password…" }));
    expect(store().dialog).toBe("set-password");
    act(() => store().closeDialog());
    await user.click(
      await screen.findByRole("button", { name: "No master password set. Set a master password" }),
    );
    expect(store().dialog).toBe("set-password");
    act(() => store().closeDialog());

    vi.mocked(api.secretsStatus).mockResolvedValue(file(true, true));
    await store().refresh();
    await user.click(await screen.findByRole("button", { name: "Unlock…" }));
    expect(store().dialog).toBe("unlock");
    act(() => store().closeDialog());
    await user.click(await screen.findByRole("button", { name: "Secrets locked. Unlock secrets" }));
    expect(store().dialog).toBe("unlock");
    act(() => store().closeDialog());

    vi.mocked(api.secretsStatus).mockResolvedValue(file(true, false));
    await store().refresh();
    await user.click(await screen.findByRole("button", { name: "Lock now" }));
    expect(api.lockSecrets).toHaveBeenCalledTimes(1);
    await user.click(await screen.findByRole("button", { name: "Secrets unlocked. Lock secrets" }));
    expect(api.lockSecrets).toHaveBeenCalledTimes(2);
    await user.click(await screen.findByRole("button", { name: "Change master password…" }));
    expect(store().dialog).toBe("change-password");
    act(() => store().closeDialog());
    await user.click(await screen.findByRole("button", { name: "Reset secret store…" }));
    expect(store().dialog).toBe("reset");
  });
});
