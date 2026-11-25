import { DEFAULT_SETTINGS, normalizeSettings } from "@/lib/model";
import {
  emptyCert,
  fromDraft,
  hasPendingSecrets,
  hostList,
  hostPatternError,
  lowersRetention,
  parseWhole,
  proxyUrlError,
  toDraft,
} from "./settingsForm";

describe("settingsForm", () => {
  it("round-trips settings through a draft", () => {
    const s = {
      ...DEFAULT_SETTINGS,
      timeoutMs: 45_000,
      theme: "dark" as const,
      layout: "horizontal" as const,
    };
    const d = toDraft(s);
    expect(d.timeoutSeconds).toBe("45");
    expect(fromDraft(d, s)).toEqual({ settings: s, secrets: { certPassphrases: [] }, errors: null });
  });

  it("round-trips the script timeout in seconds", () => {
    const d = toDraft(DEFAULT_SETTINGS);
    expect(d.scriptTimeoutSeconds).toBe("5");
    expect(fromDraft({ ...d, scriptTimeoutSeconds: "60" }, DEFAULT_SETTINGS).settings?.scriptTimeoutMs).toBe(
      60_000,
    );
  });

  it("shows sub-second timeouts with one decimal", () => {
    expect(toDraft({ ...DEFAULT_SETTINGS, timeoutMs: 1500 }).timeoutSeconds).toBe("1.5");
  });

  it.each([
    ["10", 0, 600, 10],
    [" 0 ", 0, 600, 0],
    ["600", 0, 600, 600],
    ["601", 0, 600, null],
    ["-1", 0, 600, null],
    ["1.5", 0, 600, null],
    ["", 0, 600, null],
    ["abc", 0, 600, null],
  ])("parseWhole(%j) = %s", (text, min, max, want) => {
    expect(parseWhole(text, min, max)).toBe(want);
  });

  it("reports every invalid field", () => {
    const d = {
      ...toDraft(DEFAULT_SETTINGS),
      timeoutSeconds: "x",
      maxRedirects: "0",
      historyRetention: "-5",
      scriptTimeoutSeconds: "0",
    };
    const r = fromDraft(d, DEFAULT_SETTINGS);
    expect(r.settings).toBeNull();
    expect(r.errors).toEqual({
      timeoutSeconds: "Enter whole seconds from 0 to 600.",
      scriptTimeoutSeconds: "Enter whole seconds from 1 to 60.",
      maxRedirects: "Enter a number from 1 to 50.",
      historyRetention: "Enter a number from 0 to 100,000.",
    });
  });

  it("ignores an invalid max redirects while redirects are off", () => {
    const base = { ...DEFAULT_SETTINGS, maxRedirects: 7 };
    const d = { ...toDraft(base), followRedirects: false, maxRedirects: "" };
    const r = fromDraft(d, base);
    expect(r.errors).toBeNull();
    expect(r.settings?.maxRedirects).toBe(7);
    expect(r.settings?.followRedirects).toBe(false);
  });

  it.each([
    [500, "100", true],
    [500, "500", false],
    [500, "900", false],
    [500, "0", false],
    [0, "100", true],
    [500, "oops", false],
  ])("lowersRetention(saved=%i, draft=%j) = %s", (saved, draft, want) => {
    const s = { ...DEFAULT_SETTINGS, historyRetention: saved };
    expect(lowersRetention({ ...toDraft(s), historyRetention: draft }, s)).toBe(want);
  });

  it("normalizeSettings fills zero-value enums and missing fields from defaults", () => {
    expect(
      normalizeSettings({ theme: "" as never, layout: "" as never, timeoutMs: 0 }, DEFAULT_SETTINGS),
    ).toEqual({
      ...DEFAULT_SETTINGS,
      timeoutMs: 0,
    });
    expect(normalizeSettings(null, DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
    const full = {
      theme: "light" as const,
      layout: "horizontal" as const,
      timeoutMs: 1,
      followRedirects: false,
      maxRedirects: 2,
      verifyTls: false,
      historyRetention: 3,
      checkForUpdates: false,
      proxy: { mode: "custom" as const, url: "http://p:1", username: "me", bypass: "localhost" },
      caFile: "/ca.pem",
      clientCerts: [{ id: "c", host: "*", certFile: "", keyFile: "", pfxFile: "/me.p12" }],
      scriptTimeoutMs: 9000,
      scriptRequests: false,
      cloudflaredPath: "/opt/cloudflared",
    };
    expect(normalizeSettings(full, DEFAULT_SETTINGS)).toEqual(full);
    expect(normalizeSettings({ ...full, scriptTimeoutMs: 0 }, DEFAULT_SETTINGS).scriptTimeoutMs).toBe(5000);
    expect(
      normalizeSettings(
        { proxy: { mode: "bogus" } as never, clientCerts: [{ id: "x" }] as never },
        DEFAULT_SETTINGS,
      ),
    ).toMatchObject({
      proxy: { mode: "system", url: "", username: "", bypass: "" },
      clientCerts: [{ id: "x", host: "", certFile: "", keyFile: "", pfxFile: "" }],
    });
  });
});

describe("network settings form", () => {
  it.each([
    ["http://proxy:8080", null],
    ["SOCKS5://p:1080", null],
    ["https://p", null],
    ["", "Enter the proxy URL"],
    ["proxy:8080", "Start the URL"],
    ["ftp://p", "Start the URL"],
    ["http://u:p@proxy", "own fields"],
    ["http://", "host"],
    ["http://:80", "host"],
  ])("proxyUrlError(%j)", (url, want) => {
    const got = proxyUrlError(url);
    if (want === null) expect(got).toBeNull();
    else expect(got).toContain(want);
  });

  it.each([
    ["*", null],
    ["api.example.com", null],
    ["*.local", null],
    [".corp", null],
    ["10.0.0.0/8", null],
    ["::1", null],
    ["", "Enter a host"],
    ["10.0.0.0/x", "IP range"],
    ["a b", "isn't a host"],
    ["host:80", "isn't a host"],
    ["a.*.com", "wildcard"],
    ["foo*", "wildcard"],
  ])("hostPatternError(%j)", (p, want) => {
    const got = hostPatternError(p);
    if (want === null) expect(got).toBeNull();
    else expect(got).toContain(want);
  });

  it("splits host lists like Go", () => {
    expect(hostList(" Localhost, *.Local.\n10.0.0.0/8;; x ")).toEqual([
      "localhost",
      "*.local",
      "10.0.0.0/8",
      "x",
    ]);
    expect(hostList("")).toEqual([]);
  });

  it("reports proxy, bypass and certificate errors", () => {
    const d = toDraft(DEFAULT_SETTINGS);
    const a = { ...emptyCert(), host: "" };
    const b = { ...emptyCert(), host: "x", kind: "pem" as const, certFile: "c" };
    const c = { ...emptyCert(), host: "y", kind: "pfx" as const };
    const r = fromDraft(
      { ...d, proxyMode: "custom", proxyUrl: "ftp://x", proxyBypass: "ok, bad host:1", certs: [a, b, c] },
      DEFAULT_SETTINGS,
    );
    expect(r.errors).toMatchObject({
      proxyUrl: expect.stringContaining("Start the URL"),
      proxyBypass: expect.stringContaining("host:1"),
      certs: {
        [a.id]: expect.stringContaining("Enter a host"),
        [b.id]: "Choose the certificate file and its key file.",
        [c.id]: "Choose the PKCS#12 (.p12 or .pfx) file.",
      },
    });
    expect(emptyCert().id).not.toBe(emptyCert().id);
  });

  it("returns network settings and the passwords to store", () => {
    const d = toDraft({
      ...DEFAULT_SETTINGS,
      clientCerts: [{ id: "p", host: "*", certFile: "", keyFile: "", pfxFile: "/me.p12" }],
    });
    expect(d.certs[0].kind).toBe("pfx");
    const r = fromDraft(
      {
        ...d,
        proxyMode: "custom",
        proxyUrl: " http://p:1 ",
        proxyUsername: " me ",
        proxyPassword: "pw",
        caFile: " /ca.pem ",
        certs: [
          { ...d.certs[0], passphrase: "pass", certFile: "ignored" },
          {
            id: "q",
            host: " API.example.com ",
            kind: "pem",
            certFile: "/c",
            keyFile: "/k",
            pfxFile: "x",
            passphrase: "no",
          },
        ],
      },
      DEFAULT_SETTINGS,
    );
    expect(r.settings).toMatchObject({
      proxy: { mode: "custom", url: "http://p:1", username: "me" },
      caFile: "/ca.pem",
      clientCerts: [
        { id: "p", host: "*", certFile: "", keyFile: "", pfxFile: "/me.p12" },
        { id: "q", host: "api.example.com", certFile: "/c", keyFile: "/k", pfxFile: "" },
      ],
    });
    expect(r.secrets).toEqual({ proxyPassword: "pw", certPassphrases: [{ id: "p", passphrase: "pass" }] });
    expect(hasPendingSecrets(r.secrets!)).toBe(true);

    const cleared = fromDraft({ ...toDraft(DEFAULT_SETTINGS), clearProxyPassword: true }, DEFAULT_SETTINGS);
    expect(cleared.secrets).toEqual({ proxyPassword: "", certPassphrases: [] });
    const none = fromDraft(toDraft(DEFAULT_SETTINGS), DEFAULT_SETTINGS);
    expect(hasPendingSecrets(none.secrets!)).toBe(false);
  });
});
