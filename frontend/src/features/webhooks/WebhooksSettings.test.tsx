import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "@/lib/api";
import { useSettingsStore } from "@/stores/settings";
import { useWebhooksStore } from "@/stores/webhooks";
import { WebhooksSettings } from "./WebhooksSettings";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

const found = {
  found: true,
  path: "/home/me/.config/pakpos/bin/cloudflared",
  source: "downloaded",
  version: "2026.11.1",
  error: "",
  customPath: "",
  canDownload: true,
};

describe("WebhooksSettings", () => {
  it("shows the cloudflared in use and offers an update", async () => {
    vi.mocked(api.cloudflaredStatus).mockResolvedValue(found);
    const user = userEvent.setup();
    render(<WebhooksSettings />);
    expect(screen.getByText("Looking for cloudflared…")).toBeInTheDocument();
    expect(await screen.findByText(found.path)).toBeInTheDocument();
    expect(screen.getByText("Downloaded by Pakpos")).toBeInTheDocument();
    vi.mocked(api.installCloudflared).mockReturnValue(new Promise(() => {}) as never);
    await user.click(screen.getByRole("button", { name: "Update cloudflared" }));
    act(() => useWebhooksStore.getState().setInstallProgress(1, 4));
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
    expect(screen.getByText("1 B of 4 B")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.cancelCloudflaredInstall).toHaveBeenCalled();
  });

  it("explains a missing or broken cloudflared, and changes the path", async () => {
    vi.mocked(api.cloudflaredStatus).mockResolvedValue({
      ...found,
      found: false,
      path: "",
      source: "",
      canDownload: false,
    });
    const chosen = { ...found, source: "settings", customPath: "/opt/cloudflared", path: "/opt/cloudflared" };
    vi.mocked(api.pickCloudflared).mockResolvedValue(chosen);
    vi.mocked(api.setCloudflaredPath).mockResolvedValue({
      ...found,
      found: false,
      customPath: "/bad",
      error: "It doesn't run",
    });
    const user = userEvent.setup();
    render(<WebhooksSettings />);
    expect(await screen.findByText(/Download it, or choose the file/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Download cloudflared/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Choose file…" }));
    expect(await screen.findByText("Chosen by you")).toBeInTheDocument();
    expect(useSettingsStore.getState().settings.cloudflaredPath).toBe("/opt/cloudflared");

    await user.click(screen.getByRole("button", { name: "Find it automatically" }));
    expect(api.setCloudflaredPath).toHaveBeenCalledWith("");
    expect(await screen.findByText("It doesn't run")).toBeInTheDocument();
    expect(useSettingsStore.getState().settings.cloudflaredPath).toBe("/bad");
  });
});
