import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useActiveTab, useTabsStore } from "@/stores/tabs";
import { editorText, setEditorText } from "@/test/editor";
import { activeTab, resetTabs } from "@/test/store";
import { ToolTab } from "../ToolTab";
import { DEBOUNCE_FROM, MAX_TOOL_INPUT } from "../useSettled";

vi.mock("sonner", async (orig) => {
  const actual = await orig<typeof import("sonner")>();
  return { ...actual, toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } };
});

function Host() {
  const tab = useActiveTab();
  return tab.tool ? <ToolTab key={tab.id} tab={tab} /> : null;
}

async function renderTool(input?: string) {
  act(() => void useTabsStore.getState().openTool("url", input));
  render(
    <TooltipProvider>
      <Host />
    </TooltipProvider>,
  );
  await screen.findByRole("heading", { name: "URL encoder" });
}

const output = () => editorText("URL output");
const state = () => activeTab().tool?.state as Record<string, unknown>;
const radio = (group: string, name: string) =>
  within(screen.getByRole("radiogroup", { name: group })).getByRole("radio", { name });
const parsePanel = () => screen.getByRole("region", { name: "Parse URL" });

beforeEach(() => {
  resetTabs();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});

describe("URL tool", () => {
  it("encodes and decodes as you type in each mode", async () => {
    const user = userEvent.setup();
    await renderTool();
    expect(
      within(parsePanel()).getByText("Paste a URL to see its scheme, host, path and query."),
    ).toBeInTheDocument();
    setEditorText("URL input", "a b&c/é");
    expect(radio("Direction", "Encode")).toHaveAttribute("aria-checked", "true");
    expect(radio("Mode", "Component")).toHaveAttribute("aria-checked", "true");
    expect(output()).toBe("a%20b%26c%2F%C3%A9");

    await user.click(radio("Mode", "Form"));
    expect(output()).toBe("a+b%26c%2F%C3%A9");
    expect(screen.getByText(/spaces become \+/)).toBeInTheDocument();

    await user.click(radio("Mode", "Full URL"));
    expect(output()).toBe("a%20b&c/%C3%A9");

    await user.click(radio("Direction", "Decode"));
    setEditorText("URL input", "a+b%20c%2F");
    expect(output()).toBe("a+b c%2F");
    await user.click(radio("Mode", "Form"));
    expect(output()).toBe("a b c/");
    await user.click(radio("Mode", "Component"));
    expect(output()).toBe("a+b c/");
    expect(state()).toMatchObject({ mode: "component", direction: "decode" });
  });

  it("names the position of a bad escape instead of failing", async () => {
    await renderTool();
    await userEvent.setup().click(radio("Direction", "Decode"));
    setEditorText("URL input", "abcd%zz");
    expect(screen.getByRole("alert")).toHaveTextContent("The %-escape at column 5 isn't valid");
    expect(output()).toBe("");
    expect(screen.getByRole("button", { name: "Copy output" })).toBeDisabled();
    setEditorText("URL input", "abcd%20");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("parses the URL and opens it as a request", async () => {
    const user = userEvent.setup();
    await renderTool("https://api.dev:8443/v1/users?q=a%20b&page=2#top");
    const panel = parsePanel();
    expect(within(panel).getByRole("rowheader", { name: "Host" }).nextSibling).toHaveTextContent("api.dev");
    expect(within(panel).getByRole("rowheader", { name: "Port" }).nextSibling).toHaveTextContent("8443");
    expect(within(panel).getByRole("rowheader", { name: "Path" }).nextSibling).toHaveTextContent("/v1/users");
    expect(within(panel).getByRole("rowheader", { name: "Fragment" }).nextSibling).toHaveTextContent("top");
    const query = within(panel).getByRole("table", { name: "Query" });
    expect(within(query).getByRole("cell", { name: "a b" })).toBeInTheDocument();
    expect(within(query).getByRole("cell", { name: "page" })).toBeInTheDocument();

    await user.click(within(panel).getByRole("button", { name: "Open as request" }));
    const tab = activeTab();
    expect(tab.tool).toBeNull();
    expect(tab.request.url).toBe("https://api.dev:8443/v1/users?q=a%20b&page=2#top");
    expect(tab.request.query.map((q) => [q.key, q.value])).toEqual([
      ["q", "a b"],
      ["page", "2"],
    ]);
    expect(tab.saved).toBeNull();
  });

  it("parses the decoded output, and explains when there's no URL", async () => {
    const user = userEvent.setup();
    await renderTool("https%3A%2F%2Fx.dev%2Fa");
    expect(within(parsePanel()).getByText(/This isn't a URL/)).toBeInTheDocument();
    expect(within(parsePanel()).getByRole("button", { name: "Open as request" })).toBeDisabled();
    expect(within(parsePanel()).queryByRole("table", { name: "Query" })).not.toBeInTheDocument();
    await user.click(radio("Direction", "Decode"));
    expect(output()).toBe("https://x.dev/a");
    expect(within(parsePanel()).getByRole("rowheader", { name: "Port" }).nextSibling).toHaveTextContent(
      "none",
    );
    expect(within(parsePanel()).getByRole("button", { name: "Open as request" })).toBeEnabled();
  });

  it("copies the output, reuses it as input, and clears", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await renderTool("a b");
    await user.click(screen.getByRole("button", { name: "Copy output" }));
    expect(writeText).toHaveBeenCalledWith("a%20b");
    expect(toast.success).toHaveBeenCalledWith("Output copied");
    writeText.mockRejectedValueOnce(new Error("no"));
    await user.click(screen.getByRole("button", { name: "Copy output" }));
    expect(toast.error).toHaveBeenCalledWith("Couldn't copy the output", expect.anything());

    await user.click(screen.getByRole("button", { name: "Use output as input" }));
    expect(state()).toMatchObject({ input: "a%20b", direction: "decode" });
    expect(output()).toBe("a b");
    await user.click(screen.getByRole("button", { name: "Use output as input" }));
    expect(state()).toMatchObject({ input: "a b", direction: "encode" });

    await user.click(screen.getByRole("button", { name: "Clear input" }));
    expect(editorText("URL input")).toBe("");
    expect(screen.getByRole("button", { name: "Clear input" })).toBeDisabled();
  });

  it("waits for typing to pause on large input", async () => {
    const big = "a b".repeat(DEBOUNCE_FROM);
    await renderTool(big);
    expect(output()).toBe("a%20b".repeat(DEBOUNCE_FROM));
    setEditorText("URL input", big + "!");
    expect(screen.getByRole("status")).toHaveTextContent("Updating…");
    await waitFor(() => expect(output()).toBe("a%20b".repeat(DEBOUNCE_FROM) + "!"));
  });

  it("refuses input over 10 MiB", async () => {
    await renderTool("x".repeat(MAX_TOOL_INPUT + 1));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Input is too large for this tool (over 10 MiB).",
    );
    expect(output()).toBe("");
  });
});
