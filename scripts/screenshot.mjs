#!/usr/bin/env node
// Screenshots of the frontend with fake Go services, for reviewing UI changes.
//
// The built frontend runs in `vite preview` (a plain browser, no Wails). Every
// Wails call is a POST to /wails/runtime with {object, method, args: {methodID,
// args}}; this script routes **/wails/runtime* in Playwright and answers each
// method ID (read from the generated frontend/bindings) with a fake handler.
//
// Setup, once:
//   wails3 generate bindings -ts                # frontend/bindings (or wails3 build)
//   cd frontend && npx playwright install chromium
//
// Each run:
//   cd frontend && npx vite build && npx vite preview --port 4173 &
//   node scripts/screenshot.mjs --out /tmp/shots --theme both
//
// Options:
//   --url <url>         preview URL (default http://127.0.0.1:4173/)
//   --out <dir>         where PNGs go (default ./screenshots; prefer a temp dir)
//   --theme <t>         light, dark or both (default light)
//   --width/--height    viewport (default 1360x820)
//   --scenario <file>   an ES module that customises the run:
//                         export const handlers = { "EnvService.List": () => [...] } // merged over the defaults
//                         export async function run({ page, shot, theme }) { ... }   // replaces the default steps
//                       shot(name) saves <out>/<name>-<theme>.png.
//   PAKPOS_CHROMIUM     path to a Chromium binary, if not Playwright's own.
//
// Unhandled methods answer null and are printed, so a scenario knows what to add.
// The data here is fake: never point this at a real workspace or data dir.

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frontend = path.join(root, "frontend");
const bindings = path.join(frontend, "bindings", "pakpos", "internal", "service");

function parseArgs(argv) {
  const opts = { url: "http://127.0.0.1:4173/", out: "screenshots", theme: "light", width: 1360, height: 820 };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, "");
    if (!(key in opts) && key !== "scenario") throw new Error(`Unknown option ${argv[i]}`);
    opts[key] = argv[++i];
  }
  opts.width = Number(opts.width);
  opts.height = Number(opts.height);
  return opts;
}

function loadPlaywright() {
  try {
    return createRequire(path.join(frontend, "package.json"))("playwright");
  } catch {
    throw new Error("Playwright isn't installed. Run `npm install` in frontend/ (it's a dev dependency).");
  }
}

/** Method ID → "Service.Method", from the generated bindings. */
function methodIds() {
  if (!fs.existsSync(bindings)) {
    throw new Error("frontend/bindings is missing. Run `wails3 generate bindings -ts` first.");
  }
  const ids = {};
  // index.ts names each service module: import * as UIStateService from "./uistateservice.js".
  const index = fs.readFileSync(path.join(bindings, "index.ts"), "utf8");
  for (const [, service, file] of index.matchAll(/import \* as (\w+) from "\.\/(\w+)\.js"/g)) {
    const src = fs.readFileSync(path.join(bindings, `${file}.ts`), "utf8");
    const re = /export function (\w+)\([^)]*\)[^{]*\{\s*return \$Call\.ByID\((\d+)/g;
    for (const m of src.matchAll(re)) ids[m[2]] = `${service}.${m[1]}`;
  }
  return ids;
}

const auth = (patch = {}) => ({
  type: "none",
  username: "",
  password: "",
  token: "",
  prefix: "",
  apiKey: "",
  apiValue: "",
  apiIn: "header",
  ...patch,
});
const emptyBody = { type: "none", raw: "", language: "json", formData: [], urlEncoded: [], binaryPath: "" };
const request = (id, name, method, url) => ({
  id,
  name,
  seq: 1,
  method,
  url,
  pathParams: [],
  query: [],
  headers: [{ key: "Accept", value: "application/json", enabled: true }],
  body: emptyBody,
  auth: auth({ type: "inherit" }),
});
const requests = {
  r1: request("r1", "List users", "GET", "{{baseUrl}}/users?page=1"),
  r2: request("r2", "Create user", "POST", "{{baseUrl}}/users"),
};
const node = (r, parentId) => ({
  kind: "request",
  id: r.id,
  name: r.name,
  method: r.method,
  url: r.url,
  seq: 1,
  parentId,
  children: [],
});
const tree = {
  collections: [
    {
      kind: "collection",
      id: "c1",
      name: "Users API",
      seq: 1,
      parentId: "",
      children: [node(requests.r1, "c1"), node(requests.r2, "c1")],
    },
  ],
  problems: [],
};
const environments = [{ id: "e1", name: "Development", seq: 1, variables: [] }];
const visible = [
  {
    key: "baseUrl",
    value: "https://dev.api.example.com",
    secret: false,
    scope: "environment",
    scopeId: "e1",
    scopeName: "Development",
    set: true,
  },
];
const body = JSON.stringify({ users: [{ id: 42, name: "Ada Lovelace" }], page: 1 }, null, 2);

/** Default fake services: a workspace with one collection and environment. */
function defaultHandlers(theme) {
  return {
    "AppService.BuildInfo": () => ({ version: "26.11.1", commit: "screenshot", os: "linux", arch: "amd64" }),
    "SettingsService.Get": () => ({
      theme,
      timeoutMs: 30000,
      followRedirects: true,
      maxRedirects: 10,
      verifyTls: true,
      historyRetention: 500,
      layout: "vertical",
      checkForUpdates: false,
    }),
    "UIStateService.Get": () => ({}),
    "UIStateService.Set": () => null,
    "WorkspaceService.Current": () => ({ id: "w1", name: "Shop workspace", path: "/home/me/shop" }),
    "WorkspaceService.Recent": () => [],
    "WorkspaceService.Tree": () => tree,
    "RequestService.Get": (id) => requests[id] ?? null,
    "RequestService.Send": () => ({
      response: {
        statusCode: 200,
        statusText: "200 OK",
        proto: "HTTP/1.1",
        url: "https://dev.api.example.com/users?page=1",
        headers: [{ key: "Content-Type", value: "application/json", enabled: true }],
        cookies: [],
        contentType: "application/json",
        kind: "json",
        body,
        encoding: "utf8",
        size: body.length,
        truncated: false,
        bodyPath: "",
        timings: { dns: 2, connect: 8, tls: 20, ttfb: 74, total: 112, reusedConn: false },
      },
      error: null,
      historyId: 1,
      unresolved: [],
      secretsLocked: false,
      environment: { id: "e1", name: "Development" },
      hops: [],
    }),
    "HistoryService.List": () => ({ items: [], total: 0 }),
    "EnvService.List": () => environments,
    "EnvService.Globals": () => ({ id: "g", variables: [] }),
    "EnvService.Selected": () => ({ id: "e1", name: "Development" }),
    "EnvService.SecretsStatus": () => ({ backend: "keychain", hasPassword: false, locked: false }),
    "EnvService.ResolvePreview": () => ({
      headers: [],
      overridden: [],
      auth: auth(),
      authSource: null,
      variables: visible,
      unresolved: [],
      secretsLocked: false,
      environment: { id: "e1", name: "Development" },
      error: "",
    }),
    "EnvService.VisibleVariables": () => ({
      variables: visible,
      shadowed: [],
      environment: { id: "e1", name: "Development" },
    }),
    "ExampleService.ListAll": () => [],
  };
}

/** Default steps: the start screen, then a request after sending it. */
async function defaultRun({ page, shot }) {
  await shot("00-start");
  await page.getByRole("treeitem", { name: /List users/ }).click();
  await page.waitForTimeout(400);
  await page.keyboard.press("Control+Enter");
  await page.waitForTimeout(500);
  await shot("01-request-sent");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { chromium } = loadPlaywright();
  const ids = methodIds();
  const scenario = opts.scenario ? await import(pathToFileURL(path.resolve(opts.scenario)).href) : {};
  const themes = opts.theme === "both" ? ["light", "dark"] : [opts.theme];
  fs.mkdirSync(opts.out, { recursive: true });

  const browser = await chromium.launch(
    process.env.PAKPOS_CHROMIUM ? { executablePath: process.env.PAKPOS_CHROMIUM } : {},
  );
  try {
    for (const theme of themes) {
      const handlers = { ...defaultHandlers(theme), ...(scenario.handlers ?? {}) };
      const page = await browser.newPage({ viewport: { width: opts.width, height: opts.height } });
      page.on("pageerror", (e) => console.log("page error:", e.message));
      page.on("console", (m) => m.type() === "error" && console.log("console error:", m.text()));
      await page.route("**/wails/runtime*", async (route) => {
        let call = {};
        try {
          call = JSON.parse(route.request().postData() || "{}");
        } catch {
          // Not a method call (e.g. an event); answered with null below.
        }
        const name = ids[String(call?.args?.methodID ?? "")];
        const handler = handlers[name];
        if (name && !handler) console.log("unhandled:", name);
        try {
          const result = handler ? await handler(...(call?.args?.args ?? [])) : null;
          await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(result ?? null) });
        } catch (e) {
          await route.fulfill({ status: 500, contentType: "text/plain", body: String(e?.message ?? e) });
        }
      });
      await page.addInitScript((t) => {
        localStorage.setItem("pakpos-theme", JSON.stringify({ state: { mode: t }, version: 0 }));
      }, theme);
      await page.goto(opts.url);
      await page.waitForTimeout(800);
      const shot = async (name) => {
        await page.waitForTimeout(300);
        const file = path.join(opts.out, `${name}-${theme}.png`);
        await page.screenshot({ path: file });
        console.log("saved", file);
      };
      await (scenario.run ?? defaultRun)({ page, shot, theme });
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
