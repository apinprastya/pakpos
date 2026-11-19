import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { api } from "@/lib/api";
import { emptyAuth, emptyOAuth2, type Auth, type OAuth2Status } from "@/lib/model";
import { makeOAuth2Status, makePreview } from "@/test/fixtures";
import { fieldText, setFieldText } from "@/test/editor";
import { useOAuth2Store } from "@/stores/oauth2";
import { useSecretsStore } from "@/stores/secrets";
import { AuthEditor } from "./AuthEditor";
import { InheritedAuth } from "./Inherited";
import { OAuth2Token } from "./OAuth2Token";

const latest: { current: Auth } = { current: emptyAuth() };

function Host({
  initial,
  onMove,
  ownerId = "r1",
}: {
  initial: Partial<Auth>;
  onMove?: (field: string, value: string) => void;
  ownerId?: string;
}) {
  const [auth, setAuth] = useState<Auth>({ ...emptyAuth(), ...initial });
  return (
    <AuthEditor
      auth={auth}
      onChange={(u) =>
        setAuth((a) => {
          latest.current = u(a);
          return latest.current;
        })
      }
      allowInherit
      onMoveToSecret={onMove}
      tokenOwner={{ ownerId, parentId: "c1" }}
    />
  );
}

const oauth = (patch = {}) => ({ type: "oauth2" as const, oauth2: { ...emptyOAuth2(), ...patch } });

async function choose(user: ReturnType<typeof userEvent.setup>, combobox: string, option: string) {
  await user.click(screen.getByRole("combobox", { name: combobox }));
  await user.click(await screen.findByRole("option", { name: option }));
}

describe("OAuth 2.0 auth editor", () => {
  it("is offered as an auth type and starts with empty settings", async () => {
    const user = userEvent.setup();
    render(<Host initial={{ type: "none" }} />);
    await choose(user, "Type", "OAuth 2.0");
    expect(latest.current.type).toBe("oauth2");
    expect(latest.current.oauth2).toEqual(emptyOAuth2());
    expect(screen.getByRole("combobox", { name: "Grant type" })).toHaveTextContent(
      "Authorization code (with PKCE)",
    );
    // Switching away and back keeps what was typed.
    await choose(user, "Type", "Bearer token");
    await choose(user, "Type", "OAuth 2.0");
    expect(latest.current.oauth2).toEqual(emptyOAuth2());
  });

  it("shows only the fields the grant uses", async () => {
    const user = userEvent.setup();
    render(<Host initial={oauth({ grant: "authorization_code" })} />);
    for (const name of ["Auth URL", "Token URL", "Client ID", "Scope"]) {
      expect(screen.getByRole("textbox", { name })).toBeInTheDocument();
    }
    expect(screen.getByLabelText("Client secret")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Use PKCE" })).toBeChecked();
    expect(screen.queryByRole("textbox", { name: "Username" })).not.toBeInTheDocument();

    await choose(user, "Grant type", "Client credentials");
    expect(latest.current.oauth2?.grant).toBe("client_credentials");
    expect(screen.queryByRole("textbox", { name: "Auth URL" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Callback" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Use PKCE" })).not.toBeInTheDocument();

    await choose(user, "Grant type", "Password");
    expect(screen.getByRole("textbox", { name: "Username" })).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();

    await choose(user, "Grant type", "Implicit");
    expect(screen.getByText(/implicit grant is deprecated/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Token URL" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Client secret")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /Refresh the token/ })).not.toBeInTheDocument();
  });

  it("edits PKCE, client auth, placement and refresh", async () => {
    const user = userEvent.setup();
    render(<Host initial={oauth()} />);
    await choose(user, "PKCE method", "Plain (not recommended)");
    expect(latest.current.oauth2?.pkceMethod).toBe("plain");
    await user.click(screen.getByRole("checkbox", { name: "Use PKCE" }));
    expect(latest.current.oauth2?.disablePkce).toBe(true);
    expect(screen.queryByRole("combobox", { name: "PKCE method" })).not.toBeInTheDocument();
    await choose(user, "Client auth", "Client ID and secret in the body");
    expect(latest.current.oauth2?.clientAuth).toBe("body");
    expect(screen.getByRole("textbox", { name: "Header prefix" })).toBeInTheDocument();
    await choose(user, "Send token", "In the query");
    expect(latest.current.oauth2?.placement).toBe("query");
    expect(screen.getByRole("textbox", { name: "Query parameter" })).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: /Refresh the token/ }));
    expect(latest.current.oauth2?.disableAutoRefresh).toBe(true);
    expect(screen.getByRole("table", { name: "Extra OAuth 2.0 parameters" })).toBeInTheDocument();
  });

  it("explains the random port and copies a fixed callback URL", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<Host initial={oauth()} />);
    expect(screen.getByText(/random port and \/callback/)).toBeInTheDocument();
    await choose(user, "Callback", "Fixed URL");
    expect(latest.current.oauth2?.redirectUrl).toBe("http://127.0.0.1:8765/callback");
    expect(fieldText("Callback URL")).toBe("http://127.0.0.1:8765/callback");
    await user.click(screen.getByRole("button", { name: "Copy callback URL" }));
    expect(writeText).toHaveBeenCalledWith("http://127.0.0.1:8765/callback");
    await choose(user, "Callback", "Random port");
    expect(latest.current.oauth2?.redirectUrl).toBe("");
  });

  it("edits every text field", async () => {
    const user = userEvent.setup();
    render(<Host initial={oauth({ grant: "password", redirectUrl: "http://127.0.0.1:1/cb" })} />);
    const edits: [string, string, keyof NonNullable<Auth["oauth2"]>][] = [
      ["Token URL", "https://a/token", "tokenUrl"],
      ["Client ID", "pk", "clientId"],
      ["Username", "ann", "username"],
      ["Scope", "read", "scope"],
      ["Header prefix", "Token", "headerPrefix"],
    ];
    for (const [label, value, key] of edits) {
      setFieldText(label, value);
      expect(latest.current.oauth2?.[key]).toBe(value);
    }
    await user.type(screen.getByLabelText("Client secret"), "s");
    await user.type(screen.getByLabelText("Password"), "p");
    expect(latest.current.oauth2).toMatchObject({ clientSecret: "s", password: "p" });
    await choose(user, "Send token", "In the query");
    setFieldText("Query parameter", "tok");
    expect(latest.current.oauth2?.queryParam).toBe("tok");
    await choose(user, "Grant type", "Authorization code (with PKCE)");
    setFieldText("Auth URL", "https://a/auth");
    expect(latest.current.oauth2?.authUrl).toBe("https://a/auth");
    setFieldText("Callback URL", "http://localhost:9/cb");
    expect(latest.current.oauth2?.redirectUrl).toBe("http://localhost:9/cb");
    setFieldText("Callback URL", "");
    expect(latest.current.oauth2?.redirectUrl).toBe("http://127.0.0.1:8765/callback");
    const table = screen.getByRole("table", { name: "Extra OAuth 2.0 parameters" });
    await user.type(within(table).getAllByRole("textbox")[0], "a");
    expect(latest.current.oauth2?.extraParams[0]?.key).toBe("a");
  });

  it("says when the callback URL can't be copied", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("no")) },
      configurable: true,
    });
    render(<Host initial={oauth({ redirectUrl: "http://127.0.0.1:1/cb" })} />);
    await user.click(screen.getByRole("button", { name: "Copy callback URL" }));
  });

  it("flags a callback URL Pakpos can't listen on", () => {
    render(<Host initial={oauth({ redirectUrl: "https://example.com/cb" })} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Use http://127.0.0.1:<port>/<path>");
  });

  it("offers to move a literal client secret or password to a secret variable", async () => {
    const user = userEvent.setup();
    const onMove = vi.fn();
    render(
      <Host
        initial={oauth({ grant: "password", clientSecret: "lit-secret", password: "{{pw}}" })}
        onMove={onMove}
      />,
    );
    expect(screen.getByLabelText("Client secret")).toHaveAttribute("type", "password");
    expect(fieldText("Password")).toBe("{{pw}}");
    const hints = screen.getAllByRole("button", { name: "Move to secret variable" });
    expect(hints).toHaveLength(1);
    await user.click(hints[0]);
    expect(onMove).toHaveBeenCalledWith("oauth2ClientSecret", "lit-secret");
  });
});

describe("OAuth 2.0 token panel", () => {
  it("asks to save an unsaved request first", () => {
    render(<Host initial={oauth()} ownerId="" />);
    expect(screen.getByText(/Save the request to get an access token/)).toBeInTheDocument();
    expect(api.oauth2TokenStatus).not.toHaveBeenCalled();
  });

  it("gets a new token through the browser, with a waiting state and Cancel", async () => {
    const user = userEvent.setup();
    let flow: ((ev: { flowId: string; stage: string; authUrl: string }) => void) | undefined;
    vi.mocked(api.onOAuth2Flow).mockImplementation((cb) => {
      flow = cb;
      return () => {};
    });
    let finish: (v: OAuth2Status) => void = () => {};
    let fail: (e: unknown) => void = () => {};
    vi.mocked(api.startOAuth2).mockImplementation(
      () =>
        new Promise((res, rej) => {
          finish = res;
          fail = rej;
        }),
    );
    render(<Host initial={oauth({ clientId: "pk" })} />);
    expect(await screen.findByText("No access token yet.")).toBeInTheDocument();
    expect(api.oauth2TokenStatus).toHaveBeenCalledWith("r1");

    await user.click(screen.getByRole("button", { name: "Get new access token" }));
    await waitFor(() => expect(api.startOAuth2).toHaveBeenCalled());
    const [flowId, owner, parent, auth] = vi.mocked(api.startOAuth2).mock.calls[0];
    expect([owner, parent, auth.oauth2?.clientId]).toEqual(["r1", "c1", "pk"]);
    expect(screen.getByText("Getting an access token…")).toBeInTheDocument();

    act(() => flow!({ flowId: "other", stage: "browser", authUrl: "https://x" }));
    expect(screen.queryByText(/Waiting for you to sign in/)).not.toBeInTheDocument();
    act(() => flow!({ flowId, stage: "browser", authUrl: "https://auth/authorize?x" }));
    expect(screen.getByText("Waiting for you to sign in in the browser…")).toBeInTheDocument();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await user.click(screen.getByRole("button", { name: "Copy the link" }));
    expect(writeText).toHaveBeenCalledWith("https://auth/authorize?x");

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.cancelOAuth2).toHaveBeenCalledWith(flowId);
    await act(async () => fail(new Error("Cancelled.")));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Get new access token" })).toBeInTheDocument();

    // Next try: the provider refuses.
    await user.click(screen.getByRole("button", { name: "Get new access token" }));
    await waitFor(() => expect(api.startOAuth2).toHaveBeenCalledTimes(2));
    await act(async () => fail(new Error("The authorization server returned access_denied.")));
    expect(screen.getByRole("alert")).toHaveTextContent("access_denied");

    // And then it works.
    await user.click(screen.getByRole("button", { name: "Get new access token" }));
    await waitFor(() => expect(api.startOAuth2).toHaveBeenCalledTimes(3));
    await act(async () => finish(makeOAuth2Status({ expiresAt: Date.now() + 3_600_000 })));
    expect(screen.getByText(/^Valid until .*\(in (60 min|1 h)\)\.$/)).toBeInTheDocument();
    expect(screen.getByText("Scope: read")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("refreshes, reveals and clears a token", async () => {
    const user = userEvent.setup();
    vi.mocked(api.oauth2TokenStatus).mockResolvedValue(makeOAuth2Status({ expiresAt: Date.now() - 120_000 }));
    vi.mocked(api.refreshOAuth2).mockResolvedValue(makeOAuth2Status({ hasRefreshToken: false }));
    vi.mocked(api.revealOAuth2Token).mockResolvedValue("at-123456");
    render(<Host initial={oauth()} />);
    expect(await screen.findByText("Expired 2 min ago.")).toBeInTheDocument();
    expect(screen.queryByText("at-123456")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reveal" }));
    expect(await screen.findByText("at-123456")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.queryByText("at-123456")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(api.refreshOAuth2).toHaveBeenCalledWith("r1", "c1", expect.objectContaining({ type: "oauth2" })),
    );
    expect(await screen.findByText("Access token without an expiry.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refresh" })).not.toBeInTheDocument();

    vi.mocked(api.oauth2TokenStatus).mockResolvedValue(makeOAuth2Status({ hasToken: false }));
    await user.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(api.clearOAuth2Token).toHaveBeenCalledWith("r1"));
    expect(await screen.findByText("No access token yet.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reveal" })).not.toBeInTheDocument();
  });

  it("shows errors from refresh, reveal, clear and loading", async () => {
    const user = userEvent.setup();
    vi.mocked(api.oauth2TokenStatus).mockResolvedValue(makeOAuth2Status());
    vi.mocked(api.refreshOAuth2).mockRejectedValue(new Error("Couldn't refresh: invalid_grant"));
    vi.mocked(api.revealOAuth2Token).mockRejectedValue(new Error("The secret store is locked."));
    vi.mocked(api.clearOAuth2Token).mockRejectedValue(new Error("Clear failed"));
    render(<Host initial={oauth()} />);
    await user.click(await screen.findByRole("button", { name: "Refresh" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("invalid_grant");
    await user.click(screen.getByRole("button", { name: "Reveal" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("locked"));
    expect(screen.getByRole("button", { name: "Reveal" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Clear failed"));

    vi.mocked(api.oauth2TokenStatus).mockRejectedValue(new Error("No workspace"));
    await act(() => useOAuth2Store.getState().load("r2"));
    expect(useOAuth2Store.getState().errors.r2).toBe("No workspace");
    await act(() => useOAuth2Store.getState().load(""));
  });

  it("unlocks a locked store", async () => {
    const user = userEvent.setup();
    vi.mocked(api.oauth2TokenStatus).mockResolvedValueOnce(
      makeOAuth2Status({ hasToken: false, locked: true }),
    );
    render(<OAuth2Token ownerId="c9" parentId="" auth={{ ...emptyAuth(), ...oauth() }} />);
    expect(await screen.findByText(/secret store is locked/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Unlock" }));
    expect(await screen.findByText("No access token yet.")).toBeInTheDocument();
  });

  it("does nothing when the secret store isn't made ready", async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(useSecretsStore.getState(), "ensureReady").mockResolvedValue(false);
    vi.mocked(api.oauth2TokenStatus).mockResolvedValue(makeOAuth2Status());
    render(<Host initial={oauth()} />);
    await user.click(await screen.findByRole("button", { name: "Get new access token" }));
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await user.click(screen.getByRole("button", { name: "Reveal" }));
    await user.click(screen.getByRole("button", { name: "Clear" }));
    await user.click(screen.getByRole("button", { name: "Reveal" }));
    expect(api.startOAuth2).not.toHaveBeenCalled();
    expect(api.refreshOAuth2).not.toHaveBeenCalled();
    expect(api.revealOAuth2Token).not.toHaveBeenCalled();
    expect(api.clearOAuth2Token).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("ignores a second start while a flow runs, and a cancel without one", async () => {
    vi.mocked(api.startOAuth2).mockReturnValue(new Promise(() => {}));
    const s = useOAuth2Store.getState();
    void s.start("o", "", { ...emptyAuth(), ...oauth() });
    await waitFor(() => expect(useOAuth2Store.getState().flows.o).toBeDefined());
    expect(await s.start("o", "", { ...emptyAuth(), ...oauth() })).toBe(false);
    await s.cancel("nothing");
    expect(api.cancelOAuth2).not.toHaveBeenCalled();
  });

  it("shows an inherited token read-only", async () => {
    vi.mocked(api.oauth2TokenStatus).mockResolvedValue(makeOAuth2Status());
    render(
      <InheritedAuth
        state={{
          preview: makePreview({
            auth: { ...emptyAuth(), ...oauth() },
            authSource: { kind: "collection", id: "c1", name: "Users" },
          }),
          loading: false,
          error: null,
        }}
        hasParent
        subject="request"
      />,
    );
    const panel = await screen.findByRole("region", { name: "Access token" });
    expect(api.oauth2TokenStatus).toHaveBeenCalledWith("c1");
    expect(screen.getByText(/in the collection's settings/)).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Reveal" })).toBeInTheDocument();
    for (const name of ["Get new access token", "Refresh", "Clear"]) {
      expect(within(panel).queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });
});
