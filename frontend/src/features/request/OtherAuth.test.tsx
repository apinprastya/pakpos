import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import {
  emptyAuth,
  emptyAWSV4,
  emptyDigest,
  emptyHawk,
  emptyJWT,
  emptyNTLM,
  normalizeRequest,
  type Auth,
} from "@/lib/model";
import { editorText, setEditorText, setFieldText } from "@/test/editor";
import { AUTH_LABELS, secretFieldValue, withSecretField } from "./auth";
import { AuthEditor } from "./AuthEditor";

const latest: { current: Auth } = { current: emptyAuth() };

function Host({
  initial,
  onMove,
}: {
  initial: Partial<Auth>;
  onMove?: (field: string, value: string) => void;
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
    />
  );
}

async function choose(user: ReturnType<typeof userEvent.setup>, combobox: string, option: string) {
  await user.click(screen.getByRole("combobox", { name: combobox }));
  await user.click(await screen.findByRole("option", { name: option }));
}

describe("other auth types", () => {
  it.each([
    ["Digest auth", "digest", emptyDigest(), "Username"],
    ["AWS Signature v4", "awsv4", emptyAWSV4(), "Access key"],
    ["JWT bearer", "jwt", emptyJWT(), "Prefix"],
    ["Hawk", "hawk", emptyHawk(), "Hawk ID"],
    ["NTLM", "ntlm", emptyNTLM(), "Domain"],
  ] as const)("offers %s with empty settings", async (label, type, empty, field) => {
    const user = userEvent.setup();
    render(<Host initial={{ type: "none" }} />);
    await choose(user, "Type", label);
    expect(latest.current.type).toBe(type);
    expect(latest.current[type]).toEqual(empty);
    expect(await screen.findByRole("textbox", { name: field })).toBeInTheDocument();
    // Switching away and back keeps the block.
    await choose(user, "Type", "Bearer token");
    await choose(user, "Type", label);
    expect(latest.current[type]).toEqual(empty);
  });

  it("edits Digest settings and offers to move a literal password", async () => {
    const user = userEvent.setup();
    const onMove = vi.fn();
    render(<Host initial={{ type: "digest", digest: emptyDigest() }} onMove={onMove} />);
    await screen.findByRole("textbox", { name: "Username" });
    setFieldText("Username", "ann");
    expect(latest.current.digest?.username).toBe("ann");
    await user.type(screen.getByLabelText("Password"), "pw");
    expect(latest.current.digest?.password).toBe("pw");
    await user.click(screen.getByRole("button", { name: "Move to secret variable" }));
    expect(onMove).toHaveBeenCalledWith("digestPassword", "pw");
    await choose(user, "Algorithm", "SHA-256");
    expect(latest.current.digest?.algorithm).toBe("SHA-256");
    await choose(user, "Algorithm", "Server's choice");
    expect(latest.current.digest?.algorithm).toBe("");
    await user.click(screen.getByRole("checkbox", { name: /auth-int/ }));
    expect(latest.current.digest?.qop).toBe("auth-int");
    await user.click(screen.getByRole("checkbox", { name: /auth-int/ }));
    expect(latest.current.digest?.qop).toBe("");
    expect(screen.getByText(/sent again once with the answer/)).toBeInTheDocument();
  });

  it("edits AWS Signature v4 settings", async () => {
    const user = userEvent.setup();
    render(<Host initial={{ type: "awsv4" }} />);
    await screen.findByRole("textbox", { name: "Access key" });
    setFieldText("Access key", "AKID");
    setFieldText("Region", "eu-west-1");
    setFieldText("Service", "s3");
    await user.type(screen.getByLabelText("Secret key"), "sk");
    await user.type(screen.getByLabelText("Session token"), "tok");
    await user.click(screen.getByRole("checkbox", { name: /UNSIGNED-PAYLOAD/ }));
    expect(latest.current.awsv4).toEqual({
      accessKey: "AKID",
      secretKey: "sk",
      sessionToken: "tok",
      region: "eu-west-1",
      service: "s3",
      unsignedPayload: true,
    });
  });

  it("edits JWT settings", async () => {
    const user = userEvent.setup();
    render(<Host initial={{ type: "jwt", jwt: emptyJWT() }} />);
    await screen.findByRole("textbox", { name: "Prefix" });
    expect(screen.getByLabelText("Secret")).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "The secret is base64 encoded" }));
    expect(latest.current.jwt?.secretBase64).toBe(true);
    setEditorText("JWT payload", '{"sub":"{{user}}"}');
    expect(latest.current.jwt?.payload).toBe('{"sub":"{{user}}"}');
    setEditorText("JWT header fields", '{"kid":"k"}');
    expect(latest.current.jwt?.header).toBe('{"kid":"k"}');
    await user.type(screen.getByRole("spinbutton", { name: "Lifetime (s)" }), "300");
    expect(latest.current.jwt?.lifetimeSeconds).toBe(300);
    await user.click(screen.getByRole("checkbox", { name: "Add issued at (iat)" }));
    expect(latest.current.jwt?.disableIssuedAt).toBe(true);
    await user.click(screen.getByRole("checkbox", { name: /jti/ }));
    expect(latest.current.jwt?.addJti).toBe(true);
    setFieldText("Prefix", "JWT");
    expect(latest.current.jwt?.headerPrefix).toBe("JWT");

    await choose(user, "Algorithm", "RS256");
    expect(latest.current.jwt?.algorithm).toBe("RS256");
    expect(screen.getByLabelText("Private key")).toBeInTheDocument();
    expect(screen.getByText(/PEM private key/)).toBeInTheDocument();
    await choose(user, "Algorithm", "HS256");
    expect(latest.current.jwt?.algorithm).toBe("");

    await choose(user, "Send in", "Query parameter");
    expect(latest.current.jwt?.placement).toBe("query");
    setFieldText("Parameter", "jwt");
    expect(latest.current.jwt?.queryParam).toBe("jwt");
    await choose(user, "Send in", "Authorization header");
    expect(latest.current.jwt?.placement).toBe("");
    expect(editorText("JWT payload")).toBe('{"sub":"{{user}}"}');
  });

  it("edits Hawk and NTLM settings", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Host initial={{ type: "hawk" }} />);
    await screen.findByRole("textbox", { name: "Hawk ID" });
    setFieldText("Hawk ID", "id1");
    setFieldText("Ext", "e");
    setFieldText("App", "a");
    setFieldText("Delegated by", "d");
    await user.type(screen.getByLabelText("Key"), "k");
    await choose(user, "Algorithm", "SHA-1");
    await user.click(screen.getByRole("checkbox", { name: "Include a payload hash" }));
    expect(latest.current.hawk).toEqual({
      id: "id1",
      key: "k",
      algorithm: "sha1",
      ext: "e",
      app: "a",
      dlg: "d",
      payloadHash: true,
    });
    await choose(user, "Algorithm", "SHA-256");
    expect(latest.current.hawk?.algorithm).toBe("");
    unmount();

    render(<Host initial={{ type: "ntlm" }} />);
    await screen.findByRole("textbox", { name: "Domain" });
    setFieldText("Username", "bob");
    setFieldText("Domain", "CORP");
    setFieldText("Workstation", "WS1");
    await user.type(screen.getByLabelText("Password"), "pw1");
    expect(latest.current.ntlm).toEqual({
      username: "bob",
      password: "pw1",
      domain: "CORP",
      workstation: "WS1",
    });
  });

  it("maps secret fields of every block", () => {
    const a = emptyAuth();
    for (const field of [
      "digestPassword",
      "awsSecretKey",
      "awsSessionToken",
      "jwtSecret",
      "hawkKey",
      "ntlmPassword",
    ] as const) {
      expect(secretFieldValue(a, field)).toBe("");
      expect(secretFieldValue(withSecretField(a, field, "{{x}}"), field)).toBe("{{x}}");
    }
    expect(AUTH_LABELS.awsv4).toBe("AWS Signature v4");
  });

  it("normalizes the blocks Go sends", () => {
    const r = normalizeRequest({
      auth: {
        type: "jwt",
        jwt: { secret: "s", lifetimeSeconds: null },
        digest: { username: "u" },
        awsv4: {},
        hawk: {},
        ntlm: {},
      },
    });
    expect(r.auth.jwt).toEqual({ ...emptyJWT(), secret: "s" });
    expect(r.auth.digest).toEqual({ ...emptyDigest(), username: "u" });
    expect(r.auth.awsv4).toEqual(emptyAWSV4());
    expect(r.auth.hawk).toEqual(emptyHawk());
    expect(r.auth.ntlm).toEqual(emptyNTLM());
    expect(normalizeRequest({}).auth.jwt).toBeUndefined();
  });
});
