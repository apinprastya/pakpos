import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import App from "./App";
import { useLayoutStore } from "@/stores/layout";
import { useThemeStore } from "@/stores/theme";

vi.mock("sonner", async (orig) => {
  const actual = await orig<typeof import("sonner")>();
  return { ...actual, toast: { ...actual.toast, info: vi.fn() } };
});

describe("App shell", () => {
  beforeEach(() => {
    useLayoutStore.setState({ sidebarView: "collections", splitOrientation: "vertical" });
    useThemeStore.setState({ mode: "light" });
    vi.mocked(toast.info).mockClear();
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

  it("disables Send until a URL is entered, then sends via button and Ctrl+Enter", async () => {
    const user = userEvent.setup();
    render(<App />);
    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toBeDisabled();

    const url = screen.getByRole("textbox", { name: "Request URL" });
    await user.keyboard("{Control>}{Enter}{/Control}");
    await user.type(url, "https://example.com");
    expect(send).toBeEnabled();

    await user.click(send);
    expect(toast.info).toHaveBeenCalledTimes(1);

    await user.type(url, "{Control>}{Enter}{/Control}");
    expect(toast.info).toHaveBeenCalledTimes(2);

    // Plain Enter submits the form too.
    await user.type(url, "{Enter}");
    expect(toast.info).toHaveBeenCalledTimes(3);
  });

  it("does not send a whitespace-only URL", async () => {
    const user = userEvent.setup();
    render(<App />);
    const url = screen.getByRole("textbox", { name: "Request URL" });
    await user.type(url, "   {Control>}{Enter}{/Control}");
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("changes HTTP method and request section tabs", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("combobox", { name: "HTTP method" }));
    await user.click(screen.getByRole("option", { name: "POST" }));
    expect(screen.getByRole("combobox", { name: "HTTP method" })).toHaveTextContent("POST");

    const request = screen.getByRole("region", { name: "Request" });
    await user.click(within(request).getByRole("tab", { name: "Headers" }));
    expect(within(request).getByText(/Request headers editor/)).toBeInTheDocument();
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
