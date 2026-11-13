import { emptyAuth, emptyBody, emptyRequest } from "@/lib/model";
import { autoHeaders } from "./autoHeaders";

const names = (r: ReturnType<typeof autoHeaders>) => r.map((h) => `${h.name}: ${h.value}`);

describe("autoHeaders", () => {
  it("lists the headers added per body and auth type", () => {
    const base = { ...emptyRequest(), url: "https://a.dev/x" };
    expect(names(autoHeaders(base, "UA"))).toEqual([
      "Host: a.dev",
      "User-Agent: UA",
      "Accept-Encoding: gzip",
    ]);
    const ct = (type: "raw" | "urlencoded" | "form-data" | "binary") =>
      autoHeaders({ ...base, body: { ...emptyBody(), type, language: "xml" } }, "UA").find(
        (h) => h.name === "Content-Type",
      )?.value;
    expect(ct("raw")).toBe("application/xml");
    expect(ct("urlencoded")).toBe("application/x-www-form-urlencoded");
    expect(ct("form-data")).toMatch(/^multipart\/form-data/);
    expect(ct("binary")).toBe("application/octet-stream");

    const auth = (patch: Partial<ReturnType<typeof emptyAuth>>) =>
      names(autoHeaders({ ...base, url: "", auth: { ...emptyAuth(), ...patch } }, "UA")).slice(2);
    expect(auth({ type: "basic" })).toEqual(["Authorization: Basic …"]);
    expect(auth({ type: "bearer", token: "t" })).toEqual(["Authorization: Bearer …"]);
    expect(auth({ type: "bearer", token: "t", prefix: "Token" })).toEqual(["Authorization: Token …"]);
    expect(auth({ type: "bearer" })).toEqual([]);
    expect(auth({ type: "apikey", apiKey: "X-Key" })).toEqual(["X-Key: …"]);
    expect(auth({ type: "apikey", apiKey: "k", apiIn: "query" })).toEqual([]);
  });

  it("marks headers the user overrides", () => {
    const req = {
      ...emptyRequest(),
      headers: [
        { key: "user-agent", value: "me", enabled: true },
        { key: "Host", value: "x", enabled: false },
      ],
      url: "h.dev",
    };
    const out = autoHeaders(req, "UA");
    expect(out.find((h) => h.name === "User-Agent")?.overridden).toBe(true);
    expect(out.find((h) => h.name === "Host")?.overridden).toBe(false);
  });
});
