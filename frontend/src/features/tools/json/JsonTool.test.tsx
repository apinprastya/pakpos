import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { preloadLanguages } from "@/components/editor/languages";
import { useActiveTab, useTabsStore } from "@/stores/tabs";
import { editorText, editorView, setEditorText } from "@/test/editor";
import { activeTab, resetTabs } from "@/test/store";
import { ToolTab } from "../ToolTab";
import { DEBOUNCE_FROM } from "../useSettled";
import { MAX_JSON_INPUT } from "./JsonTool";

vi.mock("sonner", async (orig) => {
  const actual = await orig<typeof import("sonner")>();
  return { ...actual, toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } };
});

function Host() {
  const tab = useActiveTab();
  return tab.tool ? <ToolTab key={tab.id} tab={tab} /> : null;
}

async function renderTool(input?: string) {
  act(() => void useTabsStore.getState().openTool("json", input));
  render(
    <TooltipProvider>
      <Host />
    </TooltipProvider>,
  );
  await screen.findByRole("heading", { name: "JSON formatter" });
}

const output = () => editorText("JSON output");
const state = () => activeTab().tool?.state as Record<string, unknown>;
const mode = (name: string) =>
  within(screen.getByRole("radiogroup", { name: "Mode" })).getByRole("radio", { name });

beforeAll(() => preloadLanguages(["json"]));
beforeEach(() => {
  resetTabs();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});

describe("JSON tool", () => {
  it("formats as you type, with the chosen indent, minified, or with sorted keys", async () => {
    const user = userEvent.setup();
    await renderTool();
    expect(screen.getByRole("textbox", { name: "JSON output" })).toBeInTheDocument();
    setEditorText("JSON input", '{"b":1,"a":[12345678901234567890]}');
    expect(output()).toBe('{\n  "b": 1,\n  "a": [\n    12345678901234567890\n  ]\n}');
    expect(mode("Format")).toHaveAttribute("aria-checked", "true");

    await user.click(screen.getByRole("combobox", { name: "Indent" }));
    await user.click(await screen.findByRole("option", { name: "Tabs" }));
    expect(output()).toBe('{\n\t"b": 1,\n\t"a": [\n\t\t12345678901234567890\n\t]\n}');
    expect(state().indent).toBe("tab");

    await user.click(screen.getByRole("checkbox", { name: "Sort keys" }));
    await user.click(mode("Minify"));
    expect(output()).toBe('{"a":[12345678901234567890],"b":1}');
    expect(screen.queryByRole("combobox", { name: "Indent" })).not.toBeInTheDocument();
    expect(state()).toMatchObject({ mode: "minify", sortKeys: true });
  });

  it("shows where the JSON is wrong and goes there", async () => {
    const user = userEvent.setup();
    await renderTool('{\n  "a": 1,\n}');
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Line 3, column 1: Remove the comma before }: JSON has no trailing commas.",
    );
    expect(output()).toBe("");
    const view = editorView("JSON input");
    await waitFor(() => expect(view.dom.querySelector(".cm-error-line")).not.toBeNull());
    expect(view.dom.querySelector(".cm-error-mark")?.textContent).toBe("}");

    await user.click(screen.getByRole("button", { name: "Go to error" }));
    expect(view.state.selection.main.head).toBe(12);

    setEditorText("JSON input", '{\n  "a": 1\n}');
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await waitFor(() => expect(view.dom.querySelector(".cm-error-line")).toBeNull());
    expect(output()).toBe('{\n  "a": 1\n}');

    // An error at the very end marks only its line.
    setEditorText("JSON input", "[1,");
    expect(screen.getByRole("alert")).toHaveTextContent("Line 1, column 4:");
    await waitFor(() => expect(view.dom.querySelector(".cm-error-line")).not.toBeNull());
    expect(view.dom.querySelector(".cm-error-mark")).toBeNull();
  });

  it("escapes text into a JSON string and back, and reuses the output", async () => {
    const user = userEvent.setup();
    await renderTool('{"id": 1}');
    await user.click(mode("Escape"));
    expect(output()).toBe('"{\\"id\\": 1}"');

    await user.click(screen.getByRole("button", { name: "Use output as input" }));
    expect(editorText("JSON input")).toBe('"{\\"id\\": 1}"');
    expect(state().mode).toBe("escape");

    await user.click(mode("Unescape"));
    expect(output()).toBe('{"id": 1}');
    await user.click(screen.getByRole("button", { name: "Use output as input" }));
    expect(state()).toMatchObject({ input: '{"id": 1}', mode: "format" });
    expect(output()).toBe('{\n  "id": 1\n}');
  });

  it("copies the output and clears the input", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await renderTool("[1,2]");
    await user.click(screen.getByRole("button", { name: "Copy output" }));
    expect(writeText).toHaveBeenCalledWith("[\n  1,\n  2\n]");
    expect(toast.success).toHaveBeenCalledWith("Output copied");

    writeText.mockRejectedValueOnce(new Error("no"));
    await user.click(screen.getByRole("button", { name: "Copy output" }));
    expect(toast.error).toHaveBeenCalledWith("Couldn't copy the output", expect.anything());

    await user.click(screen.getByRole("button", { name: "Clear input" }));
    expect(editorText("JSON input")).toBe("");
    expect(screen.getByRole("button", { name: "Clear input" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Copy output" })).toBeDisabled();
  });

  it("waits for typing to pause on large input", async () => {
    const big = JSON.stringify("x".repeat(DEBOUNCE_FROM));
    await renderTool(big);
    expect(output()).toBe(big);
    setEditorText("JSON input", `[${big}]`);
    expect(screen.getByRole("status")).toHaveTextContent("Updating…");
    expect(screen.getByRole("button", { name: "Copy output" })).toBeDisabled();
    await waitFor(() => expect(output()).toBe(`[\n  ${big}\n]`));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("refuses input over 10 MiB", async () => {
    await renderTool("x".repeat(MAX_JSON_INPUT + 1));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Input is too large for this tool (over 10 MiB).",
    );
    expect(output()).toBe("");
  });
});
