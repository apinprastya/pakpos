import type { ScriptEvent } from "@/lib/model";

export interface Snippet {
  id: string;
  label: string;
  code: string;
  /** Only works in this script; omitted when it works in both. */
  only?: ScriptEvent;
}

/** Why a snippet is disabled in the other script. */
export const ONLY_REASON: Record<ScriptEvent, string> = {
  test: "Tests only: needs the response",
  prerequest: "Pre-request only: the request is sent by then",
};

/** Common snippets for the Scripts tab's "Snippets" menu. */
export const SNIPPETS: Snippet[] = [
  {
    id: "status-200",
    label: "Status code is 200",
    only: "test",
    code: `pm.test("Status code is 200", () => {\n  pm.response.to.have.status(200);\n});\n`,
  },
  {
    id: "response-time",
    label: "Response time is below 500 ms",
    only: "test",
    code: `pm.test("Response time is below 500 ms", () => {\n  pm.expect(pm.response.responseTime).to.be.below(500);\n});\n`,
  },
  {
    id: "json-property",
    label: "JSON body has a property",
    only: "test",
    code: `pm.test("Body has an id", () => {\n  const body = pm.response.json();\n  pm.expect(body).to.have.property("id");\n});\n`,
  },
  {
    id: "env-from-json",
    label: "Set an environment variable from the JSON response",
    only: "test",
    code: `const body = pm.response.json();\npm.environment.set("token", body.token);\n`,
  },
  {
    id: "set-header",
    label: "Set a request header",
    only: "prerequest",
    code: `pm.request.headers.upsert({ key: "X-Request-Id", value: String(Date.now()) });\n`,
  },
  {
    id: "set-variable",
    label: "Set an environment variable",
    code: `pm.environment.set("name", "value");\n`,
  },
  {
    id: "send-request",
    label: "Get a token with pm.sendRequest",
    code: `const res = await pm.sendRequest({
  url: pm.environment.get("baseUrl") + "/oauth/token",
  method: "POST",
  body: {
    mode: "urlencoded",
    urlencoded: [
      { key: "grant_type", value: "client_credentials" },
      { key: "client_id", value: "{{clientId}}" },
      { key: "client_secret", value: "{{clientSecret}}" },
    ],
  },
});
pm.environment.set("token", res.json().access_token);
`,
  },
  {
    id: "cookie-set",
    label: "Response set a cookie",
    only: "test",
    code: `pm.test("Sets a session cookie", () => {\n  pm.expect(pm.cookies.has("session")).to.be.true;\n});\n`,
  },
  {
    id: "log-response",
    label: "Log the response",
    only: "test",
    code: `console.log(pm.response.code, pm.response.text());\n`,
  },
];

/** Text to insert at `pos` in `doc`: the snippet on a line of its own. */
export function snippetInsert(doc: string, pos: number, code: string): string {
  const lineStart = doc.lastIndexOf("\n", pos - 1) + 1;
  const atLineStart = doc.slice(lineStart, pos).trim() === "";
  return atLineStart ? code : `\n${code}`;
}
