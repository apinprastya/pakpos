import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "@/App";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { cookieRef, normalizeStoredCookie, type StoredCookie } from "@/lib/model";
import { filterCookies, groupByDomain, useCookiesStore } from "@/stores/cookies";
import { ACTIONS } from "@/features/palette/actions";
import { makeResponse, makeResult } from "@/test/fixtures";
import { resetTabs } from "@/test/store";
import { CookieManagerDialog } from "./CookieManagerDialog";
import {
  emptyCookieDraft,
  expiryLabel,
  flagsLabel,
  fromCookieDraft,
  fromLocalInput,
  toCookieDraft,
  toLocalInput,
} from "./cookieForm";

const HOUR = 60 * 60 * 1000;
const future = Date.now() + 24 * HOUR;

function cookie(p: Partial<StoredCookie>): StoredCookie {
  return normalizeStoredCookie({
    name: "c",
    value: "v",
    domain: "example.com",
    path: "/",
    hostOnly: true,
    ...p,
  });
}

const jar = [
  cookie({
    name: "sid",
    value: "abc",
    domain: "api.example.com",
    expiresAt: future,
    secure: true,
    httpOnly: true,
  }),
  cookie({ name: "theme", value: "dark", domain: "api.example.com", hostOnly: false, sameSite: "lax" }),
  cookie({ name: "track", value: "1", domain: "ads.example.net", expiresAt: future }),
];

function renderDialog(domain = "") {
  vi.mocked(api.listCookies).mockResolvedValue(jar);
  const user = userEvent.setup();
  render(
    <TooltipProvider>
      <CookieManagerDialog />
    </TooltipProvider>,
  );
  act(() => useCookiesStore.getState().openManager(domain));
  return user;
}

describe("cookie helpers", () => {
  it("converts datetime-local values both ways", () => {
    const ms = new Date(2026, 10, 18, 9, 30).getTime();
    expect(toLocalInput(ms)).toBe("2026-11-18T09:30");
    expect(fromLocalInput("2026-11-18T09:30")).toBe(ms);
    expect(fromLocalInput("2026-11-18T09:30:15")).toBe(ms + 15_000);
    expect(fromLocalInput("tomorrow")).toBeNull();
  });

  it("builds cookies from drafts and back", () => {
    const d = { ...emptyCookieDraft(".Example.com"), name: " a ", value: "1", path: "" };
    const c = fromCookieDraft(d).cookie!;
    expect(c).toMatchObject({ name: "a", domain: "example.com", path: "/", hostOnly: true });
    expect(c.expiresAt).toBeGreaterThan(Date.now());
    expect(fromCookieDraft({ ...d, lifetime: "session" }).cookie!.expiresAt).toBe(0);
    expect(fromCookieDraft({ ...d, name: "" }).error).toBe("Enter a name.");
    expect(fromCookieDraft({ ...d, domain: " " }).error).toMatch(/Enter the domain/);
    expect(fromCookieDraft({ ...d, expires: "" }).error).toBe("Enter when the cookie expires.");

    const session = toCookieDraft(cookie({ expiresAt: 0, hostOnly: false }));
    expect(session).toMatchObject({ lifetime: "session", subdomains: true });
    expect(toCookieDraft(cookie({ expiresAt: future })).expires).toBe(toLocalInput(future));
  });

  it("labels expiry and flags", () => {
    expect(expiryLabel(cookie({ expiresAt: 0 }))).toBe("Session");
    expect(expiryLabel(cookie({ expiresAt: future }))).toBe(new Date(future).toLocaleString());
    expect(flagsLabel(cookie({ secure: true, httpOnly: true, sameSite: "strict" }))).toBe(
      "Secure, HttpOnly, SameSite=Strict",
    );
    expect(flagsLabel(cookie({}))).toBe("");
  });

  it("groups by domain with the focused one first, and filters", () => {
    expect(groupByDomain(jar).map((g) => g.domain)).toEqual(["ads.example.net", "api.example.com"]);
    expect(groupByDomain(jar, "api.example.com").map((g) => g.domain)).toEqual([
      "api.example.com",
      "ads.example.net",
    ]);
    expect(filterCookies(jar, "DARK").map((c) => c.name)).toEqual(["theme"]);
    expect(filterCookies(jar, " ")).toBe(jar);
    expect(normalizeStoredCookie({ sameSite: "weird", path: "" })).toMatchObject({ sameSite: "", path: "/" });
    expect(cookieRef(jar[0])).toEqual({ domain: "api.example.com", path: "/", name: "sid" });
  });
});

describe("CookieManagerDialog", () => {
  it("lists cookies grouped by domain, the response's domain first", async () => {
    renderDialog("api.example.com");
    const dialog = await screen.findByRole("dialog", { name: "Cookies" });
    const groups = await within(dialog).findAllByRole("region");
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual(["api.example.com", "ads.example.net"]);
    const api1 = within(groups[0]).getByRole("table");
    expect(within(api1).getAllByRole("row")).toHaveLength(3);
    expect(within(api1).getByText("Secure, HttpOnly")).toBeInTheDocument();
    expect(within(api1).getByText("Subdomains, SameSite=Lax")).toBeInTheDocument();
    expect(within(api1).getByText("Session")).toBeInTheDocument();
  });

  it("filters, and says when nothing matches", async () => {
    const user = renderDialog();
    const dialog = await screen.findByRole("dialog", { name: "Cookies" });
    await within(dialog).findByRole("region", { name: "ads.example.net" });
    await user.type(within(dialog).getByRole("textbox", { name: "Filter cookies" }), "track");
    expect(within(dialog).getAllByRole("region")).toHaveLength(1);
    await user.type(within(dialog).getByRole("textbox", { name: "Filter cookies" }), "zzz");
    expect(within(dialog).getByText("No cookies match the filter.")).toBeInTheDocument();
  });

  it("shows an empty state and load errors", async () => {
    vi.mocked(api.listCookies).mockRejectedValue(new Error("db closed"));
    render(
      <TooltipProvider>
        <CookieManagerDialog />
      </TooltipProvider>,
    );
    act(() => useCookiesStore.getState().openManager());
    const dialog = await screen.findByRole("dialog", { name: "Cookies" });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Couldn't load cookies: db closed");
    expect(within(dialog).getByText(/No cookies yet/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Delete all" })).toBeDisabled();
  });

  it("edits a cookie, sending the old identity to Go", async () => {
    const user = renderDialog();
    const dialog = await screen.findByRole("dialog", { name: "Cookies" });
    await user.click(await within(dialog).findByRole("button", { name: "Edit cookie sid" }));
    const form = within(dialog).getByRole("form", { name: "Edit cookie" });
    expect(within(form).getByLabelText("Name")).toHaveValue("sid");
    const value = within(form).getByLabelText("Value");
    await user.clear(value);
    await user.type(value, "new-value");
    await user.click(within(form).getByRole("checkbox", { name: "Include subdomains" }));
    await user.click(within(form).getByRole("combobox", { name: "SameSite" }));
    await user.click(screen.getByRole("option", { name: "Strict" }));
    await user.click(within(form).getByRole("button", { name: "Save cookie" }));
    await waitFor(() =>
      expect(api.updateCookie).toHaveBeenCalledWith(
        { domain: "api.example.com", path: "/", name: "sid" },
        expect.objectContaining({
          name: "sid",
          value: "new-value",
          hostOnly: false,
          sameSite: "strict",
          secure: true,
        }),
      ),
    );
    expect(await within(dialog).findByRole("textbox", { name: "Filter cookies" })).toBeInTheDocument();
    expect(api.listCookies).toHaveBeenCalledTimes(2);
  });

  it("adds a session cookie and shows Go's validation message", async () => {
    const user = renderDialog("api.example.com");
    const dialog = await screen.findByRole("dialog", { name: "Cookies" });
    await user.click(within(dialog).getByRole("button", { name: "Add cookie" }));
    const form = within(dialog).getByRole("form", { name: "Add cookie" });
    expect(within(form).getByLabelText("Domain")).toHaveValue("api.example.com");
    await user.click(within(form).getByRole("button", { name: "Save cookie" }));
    expect(within(form).getByRole("alert")).toHaveTextContent("Enter a name.");

    await user.type(within(form).getByLabelText("Name"), "bad name");
    await user.click(within(form).getByRole("combobox", { name: "Expires" }));
    await user.click(screen.getByRole("option", { name: "When Pakpos quits" }));
    expect(within(form).queryByLabelText("Expiry date")).not.toBeInTheDocument();
    await user.click(within(form).getByRole("checkbox", { name: "Secure (HTTPS only)" }));
    await user.click(within(form).getByRole("checkbox", { name: "HttpOnly" }));
    vi.mocked(api.addCookie).mockRejectedValueOnce(new Error("The name can't contain spaces."));
    await user.click(within(form).getByRole("button", { name: "Save cookie" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("The name can't contain spaces.");
    expect(api.addCookie).toHaveBeenCalledWith(
      expect.objectContaining({ name: "bad name", expiresAt: 0, secure: true, httpOnly: true }),
    );

    await user.click(within(form).getByRole("button", { name: "Cancel" }));
    expect(within(dialog).queryByRole("form")).not.toBeInTheDocument();
  });

  it("deletes a cookie, a domain and everything", async () => {
    const user = renderDialog();
    const dialog = await screen.findByRole("dialog", { name: "Cookies" });
    await user.click(await within(dialog).findByRole("button", { name: "Delete cookie track" }));
    expect(api.deleteCookie).toHaveBeenCalledWith({ domain: "ads.example.net", path: "/", name: "track" });
    expect(within(dialog).queryByRole("region", { name: "ads.example.net" })).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Delete cookies of api.example.com" }));
    expect(api.clearCookieDomain).toHaveBeenCalledWith("api.example.com");
    expect(within(dialog).getByText(/No cookies yet/)).toBeInTheDocument();

    act(() => useCookiesStore.setState({ cookies: jar }));
    await user.click(within(dialog).getByRole("button", { name: "Delete all" }));
    const confirm = within(dialog).getByRole("alertdialog", { name: "Delete all cookies" });
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(api.clearAllCookies).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Delete all" }));
    await user.click(within(dialog).getByRole("button", { name: "Delete all cookies" }));
    expect(api.clearAllCookies).toHaveBeenCalled();
    expect(useCookiesStore.getState().cookies).toEqual([]);
  });

  it("shows a failed delete", async () => {
    vi.mocked(api.deleteCookie).mockRejectedValue(new Error("database is locked"));
    const user = renderDialog();
    const dialog = await screen.findByRole("dialog", { name: "Cookies" });
    await user.click(await within(dialog).findByRole("button", { name: "Delete cookie track" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("database is locked");
  });

  it("closes with Escape", async () => {
    const user = renderDialog();
    await screen.findByRole("dialog", { name: "Cookies" });
    await user.keyboard("{Escape}");
    expect(useCookiesStore.getState().open).toBe(false);
  });
});

describe("cookie manager entry points", () => {
  it("opens lazily from the palette action", async () => {
    render(<App />);
    const action = ACTIONS.find((a) => a.id === "manage-cookies")!;
    expect(action.label).toBe("Manage cookies");
    expect(action.enabled({} as never)).toBe(true);
    act(() => action.run({} as never));
    expect(await screen.findByRole("dialog", { name: "Cookies" })).toBeInTheDocument();
    expect(api.listCookies).toHaveBeenCalled();
  });

  it("opens from the response Cookies tab with the response's host", async () => {
    resetTabs(
      {},
      {
        result: makeResult({
          response: makeResponse({ url: "https://api.example.com/x", cookies: [] }),
          historyId: 1,
        }),
        sections: { response: "cookies" },
      },
    );
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Manage cookies" }));
    expect(await screen.findByRole("dialog", { name: "Cookies" })).toBeInTheDocument();
    expect(useCookiesStore.getState().focusDomain).toBe("api.example.com");
  });
});
