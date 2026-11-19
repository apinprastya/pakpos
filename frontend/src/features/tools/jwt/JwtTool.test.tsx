import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { preloadLanguages } from "@/components/editor/languages";
import { api } from "@/lib/api";
import type { PreviewVariable } from "@/lib/model";
import { useSecretsStore } from "@/stores/secrets";
import { useActiveTab, useTabsStore } from "@/stores/tabs";
import { useWorkspaceStore } from "@/stores/workspace";
import { editorText, setEditorText } from "@/test/editor";
import { makePreviewVar } from "@/test/fixtures";
import { activeTab, resetTabs } from "@/test/store";
import { ToolTab } from "../ToolTab";
import { MAX_INPUT } from "./JwtTool";

vi.mock("sonner", async (orig) => {
  const actual = await orig<typeof import("sonner")>();
  return { ...actual, toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } };
});

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
const NOW_S = NOW / 1000;

function b64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const seg = (v: unknown) => b64(JSON.stringify(v));
const jwt = (header: unknown, payload: unknown, sig = "c2lnbmF0dXJl") =>
  `${seg(header)}.${seg(payload)}.${sig}`;
const HS = { alg: "HS256", typ: "JWT" };
const VALID = jwt(HS, { sub: "user-1", aud: ["api", "web"], exp: NOW_S + 720, iat: NOW_S - 60 });

function Host() {
  const tab = useActiveTab();
  return tab.tool ? <ToolTab key={tab.id} tab={tab} /> : null;
}

async function renderTool(input?: string) {
  act(() => void useTabsStore.getState().openTool("jwt", input));
  const utils = render(
    <TooltipProvider>
      <Host />
    </TooltipProvider>,
  );
  await screen.findByRole("heading", { name: "JWT decoder" });
  return utils;
}

const decodedPane = () => screen.getByRole("region", { name: "Decoded token" });

function withWorkspace(variables: PreviewVariable[]) {
  useWorkspaceStore.setState({ workspace: { id: "w1", name: "API", path: "/api" } });
  vi.mocked(api.visibleVariables).mockResolvedValue({
    variables,
    shadowed: [],
    environment: { id: "e1", name: "Dev" },
  });
}

beforeAll(() => preloadLanguages(["json", "jwt"]));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  resetTabs();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});

afterEach(() => vi.useRealTimers());

describe("JWT decoder", () => {
  it("shows what to do while empty, then decodes as you type", async () => {
    await renderTool();
    expect(within(decodedPane()).getByText("Nothing to decode yet")).toBeInTheDocument();
    setEditorText("JWT", `Bearer ${VALID}`);

    const pane = decodedPane();
    expect(within(pane).getByText("HS256")).toBeInTheDocument();
    expect(within(pane).getByText("Valid, expires in 12 min")).toHaveClass("text-status-ok");
    expect(within(pane).getByText("Signature not checked")).toBeInTheDocument();
    expect(editorText("Header JSON")).toBe('{\n  "alg": "HS256",\n  "typ": "JWT"\n}');
    expect(editorText("Payload JSON")).toContain('"sub": "user-1"');
    const claims = within(pane).getByRole("region", { name: "Claims" });
    expect(within(claims).getByRole("rowheader", { name: "Audience (aud)" })).toBeInTheDocument();
    expect(within(claims).getByText("api, web")).toBeInTheDocument();
    expect(within(claims).getByText("expires in 12 min")).toHaveClass("text-status-ok");
    expect(within(claims).getByText("issued 1 min ago")).toBeInTheDocument();
    expect(within(pane).getByText("c2lnbmF0dXJl")).toBeInTheDocument();
    expect(activeTab().tool?.state).toEqual({ token: `Bearer ${VALID}`, revealed: {} });
  });

  it("marks expired, not yet valid and unsigned tokens", async () => {
    await renderTool(jwt(HS, { exp: NOW_S - 3 * 3600 }));
    expect(within(decodedPane()).getByText("Expired 3 h ago")).toHaveClass("text-status-client");
    expect(within(decodedPane()).getByText("expired 3 h ago")).toHaveClass("text-status-client");

    setEditorText("JWT", jwt(HS, { nbf: NOW_S + 300 }));
    expect(within(decodedPane()).getByText("Not valid yet (starts in 5 min)")).toBeInTheDocument();

    setEditorText("JWT", jwt({ alg: "none" }, { nbf: NOW_S - 10 }, ""));
    expect(within(decodedPane()).getByText("Unsigned token")).toHaveClass("text-status-client");
    expect(within(decodedPane()).queryByText("Signature not checked")).not.toBeInTheDocument();
    expect(within(decodedPane()).getByText("Valid, no expiry")).toHaveClass("text-status-ok");
  });

  it("names the part that's wrong, and shows warnings", async () => {
    await renderTool(`${seg(HS)}.%%%.sig`);
    expect(within(decodedPane()).getByRole("alert", { name: "Problems" })).toHaveTextContent(
      "The payload isn't valid base64url.",
    );
    setEditorText("JWT", `${seg(HS)}.${b64("plain")}.`);
    expect(editorText("Payload JSON")).toBe("plain");
    expect(within(decodedPane()).getByRole("list", { name: "Warnings" })).toHaveTextContent(
      "The header says HS256, but the token has no signature.",
    );
  });

  it("recognises an encrypted token", async () => {
    await renderTool(`${seg({ alg: "RSA-OAEP", enc: "A256GCM" })}.a.b.c.d`);
    expect(
      within(decodedPane()).getByText("Encrypted token (JWE), can't be decoded without the key."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Payload JSON" })).not.toBeInTheDocument();
  });

  it("copies the parts and clears the token", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await renderTool(VALID);
    await user.click(screen.getByRole("button", { name: "Copy header" }));
    expect(writeText).toHaveBeenCalledWith('{\n  "alg": "HS256",\n  "typ": "JWT"\n}');
    expect(toast.success).toHaveBeenCalledWith("Header copied");
    await user.click(screen.getByRole("button", { name: "Copy signature" }));
    expect(writeText).toHaveBeenLastCalledWith("c2lnbmF0dXJl");

    writeText.mockRejectedValueOnce(new Error("no"));
    await user.click(screen.getByRole("button", { name: "Copy payload" }));
    expect(toast.error).toHaveBeenCalledWith("Couldn't copy the payload", expect.anything());

    await user.click(screen.getByRole("button", { name: "Clear token" }));
    expect(editorText("JWT")).toBe("");
    expect(screen.getByRole("button", { name: "Clear token" })).toBeDisabled();
    expect(within(decodedPane()).getByText("Nothing to decode yet")).toBeInTheDocument();
  });

  it("resolves {{variables}} with the selected environment", async () => {
    withWorkspace([makePreviewVar("token", VALID), makePreviewVar("empty", "")]);
    await renderTool("{{token}}");
    expect(screen.getByText("Loading variables…")).toBeInTheDocument();
    expect(await screen.findByText("Variables resolved with the Dev environment.")).toBeInTheDocument();
    expect(api.visibleVariables).toHaveBeenCalledWith("", "");
    expect(within(decodedPane()).getByText("HS256")).toBeInTheDocument();

    setEditorText("JWT", "{{empty}}");
    expect(within(decodedPane()).getByText("The variable is empty.", { exact: false })).toBeInTheDocument();

    setEditorText("JWT", "{{nope}}");
    expect(screen.getByRole("alert")).toHaveTextContent("{{nope}} isn't defined in any active scope.");
  });

  it("refuses input over 10 MiB", async () => {
    withWorkspace([makePreviewVar("big", "x".repeat(MAX_INPUT + 1))]);
    await renderTool("{{big}}");
    expect(await screen.findByText("Input is too large for this tool (over 10 MiB).")).toBeInTheDocument();
    expect(within(decodedPane()).getByText("Nothing to decode yet")).toBeInTheDocument();
  });

  it("reveals a secret variable only on request and keeps it in the tab", async () => {
    const user = userEvent.setup();
    const secret = makePreviewVar("access_token", "", { secret: true, scope: "environment", scopeId: "e1" });
    withWorkspace([secret]);
    const ready = vi.spyOn(useSecretsStore.getState(), "ensureReady").mockResolvedValue(true);
    vi.mocked(api.revealSecret).mockResolvedValue(VALID);
    await renderTool("{{access_token}}");
    expect(await screen.findByText(/is a secret, not revealed/)).toBeInTheDocument();
    expect(api.revealSecret).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Reveal" }));
    expect(ready).toHaveBeenCalled();
    expect(api.revealSecret).toHaveBeenCalledWith({ kind: "environment", id: "e1" }, "access_token");
    expect(await screen.findByText(/Using the revealed value of/)).toBeInTheDocument();
    expect(within(decodedPane()).getByText("HS256")).toBeInTheDocument();
    expect(activeTab().tool?.state).toEqual({ token: "{{access_token}}", revealed: { access_token: VALID } });
    expect(localStorage.getItem("pakpos-tabs") ?? "").not.toContain(VALID);

    await user.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.getByText(/is a secret, not revealed/)).toBeInTheDocument();
    expect(activeTab().tool?.state).toEqual({ token: "{{access_token}}", revealed: {} });

    vi.mocked(api.revealSecret).mockRejectedValueOnce(new Error("Locked"));
    await user.click(screen.getByRole("button", { name: "Reveal" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't reveal {{access_token}}", { description: "Locked" }),
    );

    ready.mockResolvedValueOnce(false);
    vi.mocked(api.revealSecret).mockClear();
    await user.click(screen.getByRole("button", { name: "Reveal" }));
    expect(api.revealSecret).not.toHaveBeenCalled();
  });
});
