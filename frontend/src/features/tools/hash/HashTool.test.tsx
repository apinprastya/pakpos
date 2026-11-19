import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import type { PreviewVariable } from "@/lib/model";
import type { HashResult } from "@/lib/toolModel";
import { useSecretsStore } from "@/stores/secrets";
import { useActiveTab, useTabsStore } from "@/stores/tabs";
import { useWorkspaceStore } from "@/stores/workspace";
import { editorText, setEditorText, setFieldText } from "@/test/editor";
import { makePreviewVar } from "@/test/fixtures";
import { activeTab, resetTabs } from "@/test/store";
import { ToolTab } from "../ToolTab";
import { MAX_TOOL_INPUT } from "../useSettled";

vi.mock("sonner", async (orig) => {
  const actual = await orig<typeof import("sonner")>();
  return { ...actual, toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } };
});

const SUM: HashResult = { hex: "ba7816bf", base64: "uhgWvw==", bytes: 3 };

function Host() {
  const tab = useActiveTab();
  return tab.tool ? <ToolTab key={tab.id} tab={tab} /> : null;
}

async function renderTool(input?: string) {
  act(() => void useTabsStore.getState().openTool("hash", input));
  render(
    <TooltipProvider>
      <Host />
    </TooltipProvider>,
  );
  await screen.findByRole("heading", { name: "Hash and HMAC" });
}

/** A promise the test settles by hand. */
function held<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function withWorkspace(variables: PreviewVariable[]) {
  useWorkspaceStore.setState({ workspace: { id: "w1", name: "API", path: "/api" } });
  vi.mocked(api.visibleVariables).mockResolvedValue({
    variables,
    shadowed: [],
    environment: { id: "e1", name: "Dev" },
  });
}

const lastRequest = () => vi.mocked(api.hash).mock.lastCall?.[0];

beforeEach(() => {
  resetTabs();
  vi.mocked(api.hash).mockResolvedValue(SUM);
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});

describe("Hash and HMAC tool", () => {
  it("hashes text as you type and switches algorithms", async () => {
    const user = userEvent.setup();
    await renderTool();
    expect(screen.getByText("The digest shows here as you type.")).toBeInTheDocument();
    setEditorText("Text to hash", "abc");
    expect(await screen.findByLabelText("Hex digest")).toHaveTextContent("ba7816bf");
    expect(screen.getByLabelText("Base64 digest")).toHaveTextContent("uhgWvw==");
    expect(screen.getByText("From 3 bytes.")).toBeInTheDocument();
    expect(lastRequest()).toEqual({
      algorithm: "sha256",
      text: "abc",
      filePath: "",
      hmac: false,
      key: "",
      keyFormat: "text",
    });

    await user.click(screen.getByRole("combobox", { name: "Algorithm" }));
    await user.click(await screen.findByRole("option", { name: "MD5 (not secure, for checksums only)" }));
    expect(screen.getByText(/This algorithm isn't secure/)).toBeInTheDocument();
    await waitFor(() => expect(lastRequest()?.algorithm).toBe("md5"));
    expect(await screen.findByLabelText("Hex digest")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear text" }));
    expect(editorText("Text to hash")).toBe("");
    expect(screen.getByText("The digest shows here as you type.")).toBeInTheDocument();
  });

  it("shows only the answer to the latest text", async () => {
    const first = held<HashResult>();
    const second = held<HashResult>();
    vi.mocked(api.hash).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await renderTool("a");
    await waitFor(() => expect(api.hash).toHaveBeenCalledTimes(1));
    setEditorText("Text to hash", "ab");
    await waitFor(() => expect(api.hash).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("status")).toHaveTextContent("Hashing…");

    await act(async () => second.resolve({ hex: "newer", base64: "bmV3", bytes: 2 }));
    await act(async () => first.resolve({ hex: "older", base64: "b2xk", bytes: 1 }));
    expect(screen.getByLabelText("Hex digest")).toHaveTextContent("newer");
    expect(screen.queryByText("older")).not.toBeInTheDocument();
  });

  it("shows Go's errors, such as a key that isn't valid hex", async () => {
    const user = userEvent.setup();
    await renderTool("abc");
    await screen.findByLabelText("Hex digest");
    vi.mocked(api.hash).mockRejectedValue(
      new Error("The HMAC key can't be read: it isn't valid hex (use the digits 0-9 and a-f, two per byte)."),
    );
    await user.click(screen.getByRole("checkbox", { name: "HMAC" }));
    setFieldText("HMAC key", "xyz");
    await user.click(screen.getByRole("combobox", { name: "Key format" }));
    await user.click(await screen.findByRole("option", { name: "Hex" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The HMAC key can't be read: it isn't valid hex",
    );
    expect(lastRequest()).toMatchObject({ hmac: true, key: "xyz", keyFormat: "hex" });
  });

  it("uses a secret variable as the key only once revealed", async () => {
    const user = userEvent.setup();
    withWorkspace([makePreviewVar("signing_key", "", { secret: true, scope: "environment", scopeId: "e1" })]);
    const ready = vi.spyOn(useSecretsStore.getState(), "ensureReady").mockResolvedValue(true);
    vi.mocked(api.revealSecret).mockResolvedValue("s3cret");
    await renderTool("payload");
    await screen.findByLabelText("Hex digest");
    await user.click(screen.getByRole("checkbox", { name: "HMAC" }));
    setFieldText("HMAC key", "{{signing_key}}");
    expect(await screen.findByText(/is a secret, not revealed/)).toBeInTheDocument();
    vi.mocked(api.hash).mockClear();

    await user.click(screen.getByRole("button", { name: "Reveal" }));
    expect(ready).toHaveBeenCalled();
    expect(api.revealSecret).toHaveBeenCalledWith({ kind: "environment", id: "e1" }, "signing_key");
    expect(await screen.findByText(/Using the revealed value of/)).toBeInTheDocument();
    await waitFor(() => expect(lastRequest()).toMatchObject({ hmac: true, key: "s3cret", text: "payload" }));
    expect(localStorage.getItem("pakpos-tabs") ?? "").not.toContain("s3cret");
    expect(localStorage.getItem("pakpos-tabs") ?? "").not.toContain("payload");

    await user.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.getByText(/is a secret, not revealed/)).toBeInTheDocument();
    expect(activeTab().tool?.state).toMatchObject({ revealed: {} });

    vi.mocked(api.revealSecret).mockRejectedValueOnce(new Error("Locked"));
    await user.click(screen.getByRole("button", { name: "Reveal" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't reveal {{signing_key}}", { description: "Locked" }),
    );
    ready.mockResolvedValueOnce(false);
    vi.mocked(api.revealSecret).mockClear();
    await user.click(screen.getByRole("button", { name: "Reveal" }));
    expect(api.revealSecret).not.toHaveBeenCalled();
  });

  it("explains a key variable that can't be resolved", async () => {
    const user = userEvent.setup();
    withWorkspace([]);
    await renderTool("abc");
    await user.click(screen.getByRole("checkbox", { name: "HMAC" }));
    setFieldText("HMAC key", "{{missing}}");
    expect(await screen.findByText(/{{missing}} isn't defined in any active scope/)).toBeInTheDocument();
  });

  it("copies each digest", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await renderTool("abc");
    await user.click(await screen.findByRole("button", { name: "Copy hex digest" }));
    expect(writeText).toHaveBeenCalledWith("ba7816bf");
    expect(toast.success).toHaveBeenCalledWith("Hex digest copied");
    writeText.mockRejectedValueOnce(new Error("no"));
    await user.click(screen.getByRole("button", { name: "Copy base64 digest" }));
    expect(toast.error).toHaveBeenCalledWith("Couldn't copy the base64 digest", expect.anything());
  });

  it("hashes a chosen file on request", async () => {
    const user = userEvent.setup();
    await renderTool();
    await user.click(screen.getByRole("radio", { name: "File" }));
    expect(screen.getByText("Choose a file, then select Hash file.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hash file" })).toBeDisabled();

    vi.mocked(api.pickHashFile).mockResolvedValueOnce("");
    await user.click(screen.getByRole("button", { name: "Choose file…" }));
    expect(screen.getByRole("button", { name: "Hash file" })).toBeDisabled();
    vi.mocked(api.pickHashFile).mockResolvedValueOnce("/data/big.iso");
    await user.click(screen.getByRole("button", { name: "Choose file…" }));
    expect(await screen.findByText("big.iso")).toBeInTheDocument();
    expect(screen.getByText("/data/big.iso")).toBeInTheDocument();
    expect(screen.getByText("Select Hash file to read it.")).toBeInTheDocument();
    expect(api.hash).not.toHaveBeenCalled();

    const pending = held<HashResult>();
    vi.mocked(api.hash).mockReturnValueOnce(pending.promise);
    await user.click(screen.getByRole("button", { name: "Hash file" }));
    expect(screen.getByRole("button", { name: "Hashing…" })).toBeDisabled();
    expect(lastRequest()).toMatchObject({ filePath: "/data/big.iso", text: "" });
    await act(async () => pending.resolve({ hex: "f00d", base64: "8A0=", bytes: 4_000_000_000 }));
    expect(screen.getByLabelText("Hex digest")).toHaveTextContent("f00d");
    expect(screen.getByText("From 4,000,000,000 bytes.")).toBeInTheDocument();

    // Other options need another run.
    await user.click(screen.getByRole("checkbox", { name: "HMAC" }));
    expect(screen.queryByLabelText("Hex digest")).not.toBeInTheDocument();

    vi.mocked(api.pickHashFile).mockRejectedValueOnce(new Error("no dialog"));
    await user.click(screen.getByRole("button", { name: "Choose file…" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't open the file picker", { description: "no dialog" }),
    );
  });

  it("refuses text over 10 MiB", async () => {
    await renderTool("x".repeat(MAX_TOOL_INPUT + 1));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Input is too large for this tool (over 10 MiB).",
    );
    expect(api.hash).not.toHaveBeenCalled();
  });
});
