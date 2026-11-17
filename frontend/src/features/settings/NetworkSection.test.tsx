import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import App from "@/App";
import { api } from "@/lib/api";
import { DEFAULT_SETTINGS, type AppSettings } from "@/lib/model";
import { useSecretsStore } from "@/stores/secrets";
import { useSettingsStore } from "@/stores/settings";

vi.mock("sonner", async (orig) => {
  const actual = await orig<typeof import("sonner")>();
  return { ...actual, toast: { ...actual.toast, success: vi.fn(), info: vi.fn(), error: vi.fn() } };
});

async function openNetwork(settings: Partial<AppSettings> = {}) {
  vi.mocked(api.getSettings).mockResolvedValue({ ...DEFAULT_SETTINGS, ...settings });
  const user = userEvent.setup();
  render(<App />);
  useSettingsStore.getState().openDialog("network");
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  const region = await within(dialog).findByRole("region", { name: "Network" });
  return { user, dialog, region };
}

const save = (user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) =>
  user.click(within(dialog).getByRole("button", { name: "Save settings" }));

describe("Network settings", () => {
  beforeEach(() => vi.mocked(toast.success).mockClear());

  it("sets a custom proxy and stores its password after saving the settings", async () => {
    const { user, dialog, region } = await openNetwork();
    expect(within(region).getByRole("radio", { name: "Use the system proxy" })).toBeChecked();
    await user.click(within(region).getByRole("radio", { name: "Custom proxy" }));
    await user.type(within(region).getByLabelText("Proxy URL"), "http://proxy.local:3128");
    await user.type(within(region).getByLabelText("User name"), "alice");
    await user.type(within(region).getByLabelText("Password"), "s3cret");
    expect(within(region).getByText("Replaces the stored value when you save.")).toBeInTheDocument();
    await user.type(within(region).getByLabelText("Connect directly to"), "localhost, *.internal");
    await save(user, dialog);

    await waitFor(() => expect(api.setProxyPassword).toHaveBeenCalledWith("s3cret"));
    expect(api.setSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        proxy: {
          mode: "custom",
          url: "http://proxy.local:3128",
          username: "alice",
          bypass: "localhost, *.internal",
        },
      }),
    );
    // The password never goes into the settings.
    expect(JSON.stringify(vi.mocked(api.setSettings).mock.calls)).not.toContain("s3cret");
    expect(vi.mocked(api.setSettings).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.setProxyPassword).mock.invocationCallOrder[0],
    );
    expect(toast.success).toHaveBeenCalledWith("Settings saved");
  });

  it("shows field errors in the Network section and doesn't save", async () => {
    const { user, dialog, region } = await openNetwork();
    useSettingsStore.getState().setSection("appearance");
    useSettingsStore.getState().setSection("network");
    await user.click(within(region).getByRole("radio", { name: "Custom proxy" }));
    await user.type(within(region).getByLabelText("Proxy URL"), "proxy:8080");
    useSettingsStore.getState().setSection("appearance");
    await save(user, dialog);
    const net = await within(dialog).findByRole("region", { name: "Network" });
    expect(within(net).getByText(/Start the URL with http/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /^Network, has errors/ })).toBeInTheDocument();
    expect(api.setSettings).not.toHaveBeenCalled();
  });

  it("removes a stored proxy password and says when the store is locked", async () => {
    vi.mocked(api.networkSecretStatus).mockResolvedValue({
      locked: false,
      proxyPassword: true,
      certPassphrases: [],
    });
    const { user, dialog, region } = await openNetwork({
      proxy: { mode: "custom", url: "http://p:1", username: "me", bypass: "" },
    });
    expect(await within(region).findByText(/A value is stored on this machine/)).toBeInTheDocument();
    await user.click(within(region).getByRole("button", { name: "Remove stored password" }));
    expect(within(region).getByText("The stored value is removed when you save.")).toBeInTheDocument();
    await save(user, dialog);
    await waitFor(() => expect(api.setProxyPassword).toHaveBeenCalledWith(""));
  });

  it("asks to unlock the secret store first, and saves nothing when cancelled", async () => {
    vi.mocked(api.secretsStatus).mockResolvedValue({ backend: "file", hasPassword: true, locked: true });
    vi.mocked(api.networkSecretStatus).mockResolvedValue({
      locked: true,
      proxyPassword: false,
      certPassphrases: [],
    });
    const { user, dialog, region } = await openNetwork({
      proxy: { mode: "custom", url: "http://p:1", username: "me", bypass: "" },
    });
    expect(await within(region).findByText(/Unlock the secret store to see/)).toBeInTheDocument();
    await user.type(within(region).getByLabelText("Password"), "pw");
    await save(user, dialog);
    await waitFor(() => expect(useSecretsStore.getState().dialog).toBe("unlock"));
    useSecretsStore.getState().closeDialog(false);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Nothing was saved");
    expect(api.setSettings).not.toHaveBeenCalled();
  });

  it("keeps the settings when storing a password fails, and says so", async () => {
    vi.mocked(api.setProxyPassword).mockRejectedValue(new Error("The keychain refused"));
    const { user, dialog, region } = await openNetwork({
      proxy: { mode: "custom", url: "http://p:1", username: "me", bypass: "" },
    });
    await user.type(within(region).getByLabelText("Password"), "pw");
    await save(user, dialog);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Settings saved, but a password couldn't be stored: The keychain refused",
    );
    expect(api.setSettings).toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Password")).toHaveValue("pw");
  });

  it("shows Go's error when a certificate file can't be loaded", async () => {
    vi.mocked(api.setSettings).mockRejectedValue(
      new Error("The CA certificate file /nope.pem couldn't be read"),
    );
    const { user, dialog, region } = await openNetwork();
    await user.type(within(region).getByLabelText("CA certificates"), "/nope.pem");
    await save(user, dialog);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("/nope.pem couldn't be read");
  });

  it("adds PEM and PKCS#12 client certificates, chooses files and stores the passphrase", async () => {
    vi.mocked(api.pickFile).mockResolvedValueOnce("/certs/ca.pem").mockResolvedValueOnce("/certs/me.p12");
    const { user, dialog, region } = await openNetwork();
    expect(within(region).getByText(/No client certificates/)).toBeInTheDocument();
    await user.click(within(region).getByRole("button", { name: "Choose file for CA certificates" }));
    await waitFor(() =>
      expect(within(region).getByLabelText("CA certificates")).toHaveValue("/certs/ca.pem"),
    );

    await user.click(within(region).getByRole("button", { name: "Add client certificate" }));
    await user.click(within(region).getByRole("button", { name: "Add client certificate" }));
    const first = within(region).getByRole("group", { name: "Client certificate 1" });
    await user.type(within(first).getByLabelText("Host"), "api.example.com");
    await user.type(within(first).getByLabelText("Certificate file"), "/certs/me.crt");
    await user.type(within(first).getByLabelText("Key file"), "/certs/me.key");

    const second = within(region).getByRole("group", { name: "Client certificate 2" });
    await user.type(within(second).getByLabelText("Host"), "*.corp");
    await user.click(within(second).getByRole("combobox", { name: "Format" }));
    await user.click(screen.getByRole("option", { name: "PKCS#12 (.p12, .pfx)" }));
    await user.click(within(second).getByRole("button", { name: "Choose file for PKCS#12 file" }));
    await waitFor(() => expect(within(second).getByLabelText("PKCS#12 file")).toHaveValue("/certs/me.p12"));
    await user.type(within(second).getByLabelText("Passphrase"), "p12pass");
    await save(user, dialog);

    await waitFor(() => expect(api.setCertPassphrase).toHaveBeenCalledWith(expect.any(String), "p12pass"));
    const saved = vi.mocked(api.setSettings).mock.calls[0][0];
    expect(saved.caFile).toBe("/certs/ca.pem");
    expect(saved.clientCerts).toEqual([
      expect.objectContaining({
        host: "api.example.com",
        certFile: "/certs/me.crt",
        keyFile: "/certs/me.key",
        pfxFile: "",
      }),
      expect.objectContaining({ host: "*.corp", certFile: "", keyFile: "", pfxFile: "/certs/me.p12" }),
    ]);
    expect(vi.mocked(api.setCertPassphrase).mock.calls[0][0]).toBe(saved.clientCerts[1].id);
  });

  it("flags incomplete certificates and removes one", async () => {
    vi.mocked(api.networkSecretStatus).mockResolvedValue({
      locked: false,
      proxyPassword: false,
      certPassphrases: ["c2"],
    });
    const { user, dialog, region } = await openNetwork({
      clientCerts: [
        { id: "c1", host: "a.example", certFile: "", keyFile: "", pfxFile: "" },
        { id: "c2", host: "b.example", certFile: "", keyFile: "", pfxFile: "/b.p12" },
      ],
    });
    const second = within(region).getByRole("group", { name: "Client certificate 2" });
    expect(await within(second).findByText(/A value is stored on this machine/)).toBeInTheDocument();
    await save(user, dialog);
    const first = within(await within(dialog).findByRole("region", { name: "Network" })).getByRole("group", {
      name: "Client certificate 1",
    });
    expect(within(first).getByRole("alert")).toHaveTextContent(
      "Choose the certificate file and its key file.",
    );
    await user.click(within(first).getByRole("button", { name: "Remove client certificate 1" }));
    await save(user, dialog);
    await waitFor(() => expect(api.setSettings).toHaveBeenCalled());
    expect(vi.mocked(api.setSettings).mock.calls[0][0].clientCerts).toEqual([
      { id: "c2", host: "b.example", certFile: "", keyFile: "", pfxFile: "/b.p12" },
    ]);
    expect(api.setCertPassphrase).not.toHaveBeenCalled();
  });

  it("hides proxy fields for no proxy and tolerates failing status and file dialogs", async () => {
    vi.mocked(api.networkSecretStatus).mockRejectedValue(new Error("x"));
    vi.mocked(api.pickFile).mockRejectedValue(new Error("no dialog"));
    const { user, region } = await openNetwork();
    await user.click(within(region).getByRole("radio", { name: "No proxy" }));
    expect(within(region).queryByLabelText("Connect directly to")).not.toBeInTheDocument();
    await user.click(within(region).getByRole("button", { name: "Choose file for CA certificates" }));
    expect(within(region).getByLabelText("CA certificates")).toHaveValue("");
  });
});
