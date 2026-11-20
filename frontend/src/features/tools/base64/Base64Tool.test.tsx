import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { useActiveTab, useTabsStore } from "@/stores/tabs";
import { editorText, setEditorText } from "@/test/editor";
import { activeTab, resetTabs } from "@/test/store";
import { ToolTab } from "../ToolTab";
import { DEBOUNCE_FROM, MAX_TOOL_INPUT } from "../useSettled";
import { bytesToBase64, MAX_HEX_BYTES } from "./base64";

vi.mock("sonner", async (orig) => {
  const actual = await orig<typeof import("sonner")>();
  return { ...actual, toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } };
});

function Host() {
  const tab = useActiveTab();
  return tab.tool ? <ToolTab key={tab.id} tab={tab} /> : null;
}

async function renderTool(input?: string) {
  act(() => void useTabsStore.getState().openTool("base64", input));
  render(
    <TooltipProvider>
      <Host />
    </TooltipProvider>,
  );
  await screen.findByRole("heading", { name: "Base64" });
}

const output = () => editorText("Base64 output");
const state = () => activeTab().tool?.state as Record<string, unknown>;
const radio = (group: string, name: string) =>
  within(screen.getByRole("radiogroup", { name: group })).getByRole("radio", { name });

beforeEach(() => {
  resetTabs();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});

describe("Base64 tool", () => {
  it("encodes as you type, with either alphabet and optional padding", async () => {
    const user = userEvent.setup();
    await renderTool();
    expect(radio("Direction", "Encode")).toHaveAttribute("aria-checked", "true");
    setEditorText("Base64 input", "??> Zoë");
    expect(output()).toBe("Pz8+IFpvw6s=");

    await user.click(radio("Alphabet", "URL-safe"));
    expect(output()).toBe("Pz8-IFpvw6s=");
    await user.click(screen.getByRole("checkbox", { name: "Padding (=)" }));
    expect(output()).toBe("Pz8-IFpvw6s");
    expect(state()).toMatchObject({ alphabet: "url", padding: false });

    await user.click(screen.getByRole("button", { name: "Use output as input" }));
    expect(state()).toMatchObject({ input: "Pz8-IFpvw6s", direction: "decode" });
    expect(screen.queryByRole("radiogroup", { name: "Alphabet" })).not.toBeInTheDocument();
    expect(output()).toBe("??> Zoë");
  });

  it("explains invalid input when decoding", async () => {
    await renderTool("Zm9v#");
    expect(screen.getByRole("alert")).toHaveTextContent('Character 5 isn\'t valid Base64: "#".');
    expect(output()).toBe("");
    setEditorText("Base64 input", "Zm9v\nYmFy");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(output()).toBe("foobar");
  });

  it("shows binary data as hex and saves it to a file", async () => {
    const user = userEvent.setup();
    await renderTool("AAH/");
    expect(screen.getByText("Binary data (3 bytes), shown as hex.")).toBeInTheDocument();
    expect(output()).toBe("00 01 ff");
    expect(screen.getByRole("button", { name: "Use output as input" })).toBeDisabled();

    vi.mocked(api.saveBytes).mockResolvedValueOnce("/home/me/decoded.bin");
    await user.click(screen.getByRole("button", { name: "Save to file…" }));
    expect(api.saveBytes).toHaveBeenCalledWith("decoded.bin", "AAH/");
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("File saved", { description: "/home/me/decoded.bin" }),
    );

    vi.mocked(toast.success).mockClear();
    vi.mocked(api.saveBytes).mockResolvedValueOnce("");
    await user.click(screen.getByRole("button", { name: "Save to file…" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save to file…" })).toBeEnabled());
    expect(toast.success).not.toHaveBeenCalled();

    vi.mocked(api.saveBytes).mockRejectedValueOnce(new Error("Disk full"));
    await user.click(screen.getByRole("button", { name: "Save to file…" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't save the file", { description: "Disk full" }),
    );
  });

  it("says when only the start of large binary data is shown", async () => {
    await renderTool(bytesToBase64(new Uint8Array(MAX_HEX_BYTES + 1).fill(255)));
    expect(
      screen.getByText(`Binary data (65,537 bytes), shown as hex; the first 65,536 bytes.`),
    ).toBeInTheDocument();
  });

  it("copies the output and clears the input", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await renderTool("aGk=");
    await user.click(screen.getByRole("button", { name: "Copy output" }));
    expect(writeText).toHaveBeenCalledWith("hi");
    expect(toast.success).toHaveBeenCalledWith("Output copied");

    writeText.mockRejectedValueOnce(new Error("no"));
    await user.click(screen.getByRole("button", { name: "Copy output" }));
    expect(toast.error).toHaveBeenCalledWith("Couldn't copy the output", expect.anything());

    await user.click(screen.getByRole("button", { name: "Clear input" }));
    expect(editorText("Base64 input")).toBe("");
    expect(screen.getByRole("button", { name: "Copy output" })).toBeDisabled();
  });

  it("waits for typing to pause on large input", async () => {
    const big = "x".repeat(DEBOUNCE_FROM);
    await renderTool();
    setEditorText("Base64 input", big);
    expect(screen.getByRole("status")).toHaveTextContent("Updating…");
    expect(screen.getByRole("button", { name: "Copy output" })).toBeDisabled();
    await waitFor(() => expect(output().length).toBe(Math.ceil(DEBOUNCE_FROM / 3) * 4));
  });

  it("refuses input over 10 MiB", async () => {
    await renderTool("x".repeat(MAX_TOOL_INPUT + 1));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Input is too large for this tool (over 10 MiB).",
    );
    expect(output()).toBe("");
  });
});
