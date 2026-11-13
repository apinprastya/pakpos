import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { api } from "@/lib/api";
import { editorView, setEditorText } from "@/test/editor";
import { resetTabs } from "@/test/store";
import { useLayoutStore } from "@/stores/layout";
import { useThemeStore } from "@/stores/theme";

describe("App shell", () => {
  beforeEach(() => {
    useLayoutStore.setState({ sidebarView: "collections", splitOrientation: "vertical" });
    useThemeStore.setState({ mode: "light" });
    resetTabs();
  });

  it("renders sidebar, tab, request and response areas", () => {
    render(<App />);
    expect(screen.getByRole("complementary", { name: "Sidebar" })).toBeInTheDocument();
    expect(screen.getByText("No workspace open")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Untitled request/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("region", { name: "Request" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Response" })).toBeInTheDocument();
  });

  it("switches sidebar between collections and history", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "History" }));
    expect(screen.getByText("No requests sent yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "History" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Collections" }));
    expect(screen.getByText("No workspace open")).toBeInTheDocument();
  });

  it("toggles the request/response split orientation", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Show response beside request" }));
    expect(useLayoutStore.getState().splitOrientation).toBe("horizontal");
    expect(screen.getByRole("button", { name: "Show response below request" })).toBeInTheDocument();
  });

  it("disables Send until a URL is entered, then sends via button, Enter and Ctrl+Enter", async () => {
    const user = userEvent.setup();
    render(<App />);
    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toBeDisabled();

    setEditorText("Request URL", "https://example.com");
    expect(send).toBeEnabled();

    await user.click(send);
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));

    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(2));

    // Enter inside the URL editor sends too.
    editorView("Request URL").contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(3));
  });

  it("changes HTTP method and request section tabs", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("combobox", { name: "HTTP method" }));
    await user.click(screen.getByRole("option", { name: "POST" }));
    expect(screen.getByRole("combobox", { name: "HTTP method" })).toHaveTextContent("POST");
    expect(screen.getByRole("tab", { name: /Untitled request/ })).toHaveTextContent("POST");

    const request = screen.getByRole("region", { name: "Request" });
    await user.click(within(request).getByRole("tab", { name: "Headers" }));
    expect(within(request).getByRole("table", { name: "Headers" })).toBeInTheDocument();
  });

  it("switches theme from the theme menu", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Change theme" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Dark" }));
    expect(useThemeStore.getState().mode).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});
