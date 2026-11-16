import { makeHop } from "@/test/fixtures";
import { debugSummary, debugText } from "./debugText";

describe("debugText", () => {
  it("writes one exchange as an HTTP transcript", () => {
    const hop = makeHop({
      method: "POST",
      requestHeaders: [
        { key: "Host", value: "api.example", enabled: true },
        { key: "Authorization", value: "Bearer [secret:token]", enabled: true },
      ],
      requestBody: '{"a":1}',
      requestBodySize: 7,
    });
    expect(debugText([hop])).toBe(
      [
        "### Request · 10.0.0.1:443, TLS 1.3, new connection",
        "POST https://api.example/users HTTP/1.1",
        "Host: api.example",
        "Authorization: Bearer [secret:token]",
        "",
        '{"a":1}',
        "",
        "HTTP/1.1 200 OK",
        "Content-Type: application/json",
      ].join("\n"),
    );
  });

  it("numbers redirects and notes failures, bodies and connections", () => {
    const text = debugText([
      makeHop({
        statusCode: 302,
        statusText: "",
        requestBody: "AAE=",
        requestBodyEncoding: "base64",
        requestBodySize: 2,
      }),
      makeHop({
        reusedConn: true,
        tls: "",
        requestBody: "abc",
        requestBodySize: 2048,
        requestBodyTruncated: true,
      }),
      makeHop({
        remoteAddr: "",
        tls: "",
        proto: "",
        error: "Connection refused",
        requestBodyNote: "Not shown: secret",
        requestBodySize: 4,
      }),
    ]);
    expect(text).toContain("### Request (1 of 3) · 10.0.0.1:443, TLS 1.3, new connection");
    expect(text).toContain("[Binary body, 2 B]");
    expect(text).toContain("\nHTTP/1.1 302\n");
    expect(text).toContain("### Redirect 1 (2 of 3) · 10.0.0.1:443, reused connection");
    expect(text).toContain("abc\n[Showing the first 3 B of 2.0 KB]");
    expect(text).toContain("### Redirect 2 (3 of 3)\nGET https://api.example/users\n");
    expect(text).toContain("[Not shown: secret]");
    expect(text).toContain("[Failed: Connection refused]");
  });

  it("summarises the hops", () => {
    expect(debugSummary([makeHop()])).toBe("1 request");
    expect(debugSummary([makeHop(), makeHop()])).toBe("2 requests, 1 redirect");
    expect(debugSummary([makeHop(), makeHop(), makeHop()])).toBe("3 requests, 2 redirects");
  });
});
