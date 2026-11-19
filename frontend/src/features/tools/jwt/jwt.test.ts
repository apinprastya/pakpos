import {
  analyzeClaims,
  base64UrlDecode,
  claimTimeText,
  cleanToken,
  decodeJwt,
  looksLikeJwt,
  prettyJson,
  timeStatus,
  tokenTimeStatus,
  type ClaimInfo,
} from "./jwt";

/** base64url of a string's UTF-8 bytes, without padding. */
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
const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
const NOW_S = NOW / 1000;

describe("cleanToken and base64UrlDecode", () => {
  it.each([
    ["  abc.def.ghi \n", "abc.def.ghi"],
    ["Bearer abc.def.ghi", "abc.def.ghi"],
    ["bearer   abc.\ndef.\n ghi", "abc.def.ghi"],
    ["", ""],
  ])("cleans %j", (input, want) => {
    expect(cleanToken(input)).toBe(want);
  });

  it.each([
    ["aGk", "hi"],
    ["aGk=", "hi"],
    ["aGVsbG8", "hello"],
    ["-_8", "ûÿ"],
    ["", ""],
  ])("decodes %j", (input, want) => {
    const out = base64UrlDecode(input)!;
    expect(String.fromCharCode(...out)).toBe(want);
  });

  it.each(["a", "aGk==", "aGk*", "a+b/", "aG=k", "aGk==="])("rejects %j", (input) => {
    expect(base64UrlDecode(input)).toBeNull();
  });
});

describe("decodeJwt", () => {
  it("decodes a signed token with its claims", () => {
    const payload = {
      iss: "https://auth.example",
      sub: "user-1",
      aud: ["api", "web"],
      exp: NOW_S + 600,
      nbf: NOW_S - 60,
      iat: NOW_S - 60,
      jti: "abc",
      name: "Jane",
    };
    const d = decodeJwt(`Bearer ${jwt(HS, payload)}`);
    expect(d.kind).toBe("jws");
    expect(d.errors).toEqual([]);
    expect(d.warnings).toEqual([]);
    expect(d.alg).toBe("HS256");
    expect(d.unsigned).toBe(false);
    expect(d.header).toEqual(HS);
    expect(d.headerText).toBe('{\n  "alg": "HS256",\n  "typ": "JWT"\n}');
    expect(d.payload).toEqual(payload);
    expect(d.signature).toBe("c2lnbmF0dXJl");
    expect(d.claims.map((c) => c.name)).toEqual(["iss", "sub", "aud", "exp", "nbf", "iat", "jti"]);
    expect(d.claims.find((c) => c.name === "aud")!.text).toBe("api, web");
    expect(d.claims.find((c) => c.name === "exp")!.seconds).toBe(NOW_S + 600);
    expect(tokenTimeStatus(d.claims, NOW)).toBe("valid");
  });

  it("decodes unicode claims and padded segments", () => {
    const payload = { name: "Zoë 東京 🚀" };
    const padded = (s: string) => s + "=".repeat((4 - (s.length % 4)) % 4);
    const token = `${padded(seg(HS))}.${padded(seg(payload))}.sig`;
    const d = decodeJwt(token);
    expect(d.errors).toEqual([]);
    expect(d.payload).toEqual(payload);
    expect(d.payloadText).toContain("Zoë 東京 🚀");
  });

  it("keeps every digit of large numbers in the formatted payload", () => {
    const token = `${seg(HS)}.${b64('{"id":12345678901234567890,"f":1.50}')}.sig`;
    expect(decodeJwt(token).payloadText).toBe('{\n  "id": 12345678901234567890,\n  "f": 1.50\n}');
  });

  it.each<[string, string, { segment: string; message: string }[], string]>([
    ["empty input", "   ", [], "empty"],
    [
      "no dots",
      "notajwt",
      [{ segment: "token", message: "This isn't a JWT: a JWT has three parts separated by dots." }],
      "invalid",
    ],
    [
      "two parts",
      `${seg(HS)}.${seg({})}`,
      [{ segment: "token", message: "A JWT has three parts separated by dots; this has 2." }],
      "invalid",
    ],
    [
      "bad header base64",
      `a*b.${seg({})}.sig`,
      [{ segment: "header", message: "The header isn't valid base64url." }],
      "invalid",
    ],
    [
      "header not JSON",
      `${b64("hello")}.${seg({})}.sig`,
      [{ segment: "header", message: "The header isn't JSON." }],
      "invalid",
    ],
    [
      "header not an object",
      `${seg([1])}.${seg({})}.sig`,
      [{ segment: "header", message: "The header isn't a JSON object." }],
      "invalid",
    ],
    [
      "header without alg",
      `${seg({ typ: "JWT" })}.${seg({})}.sig`,
      [{ segment: "header", message: 'The header has no "alg" field.' }],
      "invalid",
    ],
    ["empty header", `.${seg({})}.sig`, [{ segment: "header", message: "The header is empty." }], "invalid"],
    [
      "bad payload base64",
      `${seg(HS)}.%%%.sig`,
      [{ segment: "payload", message: "The payload isn't valid base64url." }],
      "invalid",
    ],
    [
      "payload not UTF-8",
      `${seg(HS)}.${btoa("\xff\xfe").replace(/\//g, "_").replace(/=+$/, "")}.sig`,
      [{ segment: "payload", message: "The payload isn't UTF-8 text." }],
      "invalid",
    ],
    [
      "payload not JSON",
      `${seg(HS)}.${b64("plain text")}.sig`,
      [{ segment: "payload", message: "The payload isn't JSON." }],
      "invalid",
    ],
    [
      "bad signature",
      `${seg(HS)}.${seg({})}.a`,
      [{ segment: "signature", message: "The signature isn't valid base64url." }],
      "invalid",
    ],
  ])("reports %s", (_name, token, errors, kind) => {
    const d = decodeJwt(token);
    expect(d.kind).toBe(kind);
    expect(d.errors).toEqual(errors);
  });

  it("shows the raw payload when it isn't JSON", () => {
    expect(decodeJwt(`${seg(HS)}.${b64("plain text")}.sig`).payloadText).toBe("plain text");
  });

  it("reports alg none as unsigned", () => {
    const d = decodeJwt(`${seg({ alg: "none" })}.${seg({ sub: "x" })}.`);
    expect(d.kind).toBe("jws");
    expect(d.unsigned).toBe(true);
    expect(d.warnings).toEqual([]);
    const signed = decodeJwt(`${seg({ alg: "None" })}.${seg({})}.c2ln`);
    expect(signed.unsigned).toBe(true);
    expect(signed.warnings).toEqual(['The header says "alg": "none", but the token has a signature.']);
  });

  it("warns about a missing signature, a non-object payload and bad time claims", () => {
    expect(decodeJwt(`${seg(HS)}.${seg({})}.`).warnings).toEqual([
      "The header says HS256, but the token has no signature.",
    ]);
    const arr = decodeJwt(jwt(HS, [1, 2]));
    expect(arr.kind).toBe("jws");
    expect(arr.claims).toEqual([]);
    expect(arr.warnings).toEqual(["The payload is JSON but not an object, so it has no claims."]);
    const bad = decodeJwt(jwt(HS, { exp: "tomorrow" }));
    expect(bad.warnings).toEqual(['"exp" should be a number of seconds since 1970, not "tomorrow".']);
    expect(bad.claims[0].seconds).toBeUndefined();
  });

  it("recognises an encrypted token (JWE) and reads only its header", () => {
    const header = { alg: "RSA-OAEP", enc: "A256GCM" };
    const d = decodeJwt(`${seg(header)}.key.iv.cipher.tag`);
    expect(d.kind).toBe("jwe");
    expect(d.header).toEqual(header);
    expect(d.alg).toBe("RSA-OAEP");
    expect(d.payloadText).toBe("");
    expect(d.errors).toEqual([]);
    expect(decodeJwt(`${seg({ enc: "A256GCM" })}.a.b.c.d`).alg).toBe("");
    // Five parts without "enc" isn't a JWE.
    expect(decodeJwt(`${seg(HS)}.a.b.c.d`).kind).toBe("invalid");
  });
});

describe("looksLikeJwt", () => {
  it.each([
    [jwt(HS, { sub: "x" }), true],
    [`Bearer ${jwt(HS, { sub: "x" })}`, true],
    [`${seg({ alg: "none" })}.${seg({})}.`, true],
    [`${seg({ typ: "JWT" })}.${seg({})}.sig`, false],
    [`${seg(HS)}.${seg({})}`, false],
    [`.${seg({})}.sig`, false],
    [`${seg(HS)}..sig`, false],
    [`${seg(HS)}.${seg({})}.si*g`, false],
    [`${b64("x")}.${seg({})}.sig`, false],
    [`${seg({ alg: "RSA-OAEP", enc: "A256GCM" })}.a.b.c.d`, false],
    ["hello.world.again", false],
    ["", false],
  ])("%j → %s", (text, want) => {
    expect(looksLikeJwt(text)).toBe(want);
  });
});

describe("claims and time", () => {
  const claim = (name: ClaimInfo["name"], seconds?: number): ClaimInfo => ({
    name,
    label: name,
    value: seconds,
    text: String(seconds),
    seconds,
  });

  it.each<[ClaimInfo["name"], number | undefined, string]>([
    ["exp", NOW_S + 60, "valid"],
    ["exp", NOW_S, "expired"],
    ["exp", NOW_S - 1, "expired"],
    ["nbf", NOW_S + 1, "notYet"],
    ["nbf", NOW_S, "valid"],
    ["iat", NOW_S, "neutral"],
    ["exp", undefined, "neutral"],
  ])("%s at %s is %s", (name, seconds, want) => {
    expect(timeStatus(claim(name, seconds), NOW)).toBe(want);
  });

  it("sums up the token's time status", () => {
    expect(tokenTimeStatus([], NOW)).toBeNull();
    expect(tokenTimeStatus([claim("iat", NOW_S)], NOW)).toBeNull();
    expect(tokenTimeStatus([claim("exp", NOW_S + 10)], NOW)).toBe("valid");
    expect(tokenTimeStatus([claim("nbf", NOW_S + 10), claim("exp", NOW_S + 60)], NOW)).toBe("notYet");
    expect(tokenTimeStatus([claim("exp", NOW_S - 10)], NOW)).toBe("expired");
  });

  it.each<[ClaimInfo["name"], number, string]>([
    ["exp", NOW_S + 720, "expires in 12 min"],
    ["exp", NOW_S - 3 * 3600, "expired 3 h ago"],
    ["nbf", NOW_S + 300, "valid in 5 min"],
    ["nbf", NOW_S - 7200, "valid from 2 h ago"],
    ["iat", NOW_S - 2 * 86400, "issued 2 d ago"],
  ])("describes %s %s", (name, seconds, want) => {
    expect(claimTimeText(claim(name, seconds), NOW)).toBe(want);
  });

  it("keeps non-string claim values readable", () => {
    const claims = analyzeClaims({ sub: 42, aud: [1, "a"], jti: null });
    expect(claims.map((c) => c.text)).toEqual(["42", '[1,"a"]', "null"]);
  });
});

describe("prettyJson", () => {
  it.each([
    ["{}", "{}"],
    ["[ ]", "[]"],
    [
      '{"a":[1,{"b":"x,y:{z}"}],"c":{}}',
      '{\n  "a": [\n    1,\n    {\n      "b": "x,y:{z}"\n    }\n  ],\n  "c": {}\n}',
    ],
    ['"esc \\" q"', '"esc \\" q"'],
    ["  true ", "true"],
  ])("formats %j", (input, want) => {
    expect(prettyJson(input)).toBe(want);
  });
});
