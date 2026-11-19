import { emptyOAuth2, emptyAuth } from "@/lib/model";
import { secretFieldValue, withSecretField } from "./auth";
import { callbackProblem, fieldsFor, grantOf, relativeTime, tokenSummary } from "./oauth2";

const status = (patch = {}) => ({
  hasToken: true,
  locked: false,
  tokenType: "Bearer",
  scope: "",
  expiresAt: 0,
  obtainedAt: 0,
  hasRefreshToken: false,
  hasIdToken: false,
  ...patch,
});

describe("oauth2 helpers", () => {
  it("defaults the grant and picks fields", () => {
    expect(grantOf({ ...emptyOAuth2(), grant: "" })).toBe("authorization_code");
    expect(fieldsFor("implicit")).toMatchObject({
      tokenUrl: false,
      clientSecret: false,
      callback: true,
      refresh: false,
    });
    expect(fieldsFor("password")).toMatchObject({ credentials: true, authUrl: false, pkce: false });
  });

  it.each([
    ["", null],
    ["http://127.0.0.1:8765/callback", null],
    ["http://localhost:9000", null],
    ["https://127.0.0.1:1/cb", "Use"],
    ["http://127.0.0.1/cb", "Use"],
    ["http://127.0.0.1:70000/cb", "Use"],
  ])("callback %j", (url, want) => {
    const got = callbackProblem(url);
    if (want === null) expect(got).toBeNull();
    else expect(got).toContain(want);
  });

  it("formats relative times", () => {
    expect(relativeTime(10_000, 0)).toBe("in a few seconds");
    expect(relativeTime(0, 10_000)).toBe("just now");
    expect(relativeTime(5 * 60_000, 0)).toBe("in 5 min");
    expect(relativeTime(0, 3 * 3_600_000)).toBe("3 h ago");
    expect(relativeTime(2 * 86_400_000, 0)).toBe("in 2 d");
  });

  it("summarises a token", () => {
    expect(tokenSummary(undefined, 0).text).toMatch(/Checking/);
    expect(tokenSummary(status({ locked: true }), 0).tone).toBe("locked");
    expect(tokenSummary(status({ hasToken: false }), 0).text).toBe("No access token yet.");
    expect(tokenSummary(status(), 0).text).toBe("Access token without an expiry.");
    expect(tokenSummary(status({ expiresAt: 1000 }), 120_000)).toEqual({
      text: "Expired 2 min ago.",
      tone: "expired",
    });
    const valid = tokenSummary(status({ expiresAt: 600_000 }), 0);
    expect(valid.tone).toBe("valid");
    expect(valid.text).toMatch(/^Valid until .* \(in 10 min\)\.$/);
  });

  it("reads and writes secret fields", () => {
    const a = emptyAuth();
    expect(secretFieldValue(a, "oauth2ClientSecret")).toBe("");
    const b = withSecretField(a, "oauth2ClientSecret", "x");
    expect(secretFieldValue(b, "oauth2ClientSecret")).toBe("x");
    const c = withSecretField(b, "oauth2Password", "p");
    expect(c.oauth2).toMatchObject({ clientSecret: "x", password: "p" });
    expect(secretFieldValue(withSecretField(emptyAuth(), "oauth2Password", "q"), "oauth2Password")).toBe("q");
    expect(withSecretField(a, "token", "t").token).toBe("t");
    expect(secretFieldValue({ ...a, password: "pw" }, "password")).toBe("pw");
  });
});
