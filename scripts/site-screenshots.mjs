// Scenario for scripts/screenshot.mjs: the marketing site's screenshots (a Billing API workspace).
//
//   cd frontend && npx vite build && npx vite preview --port 4173 &
//   node scripts/screenshot.mjs --scenario scripts/site-screenshots.mjs --theme both \
//     --width 1280 --height 760 --scale 2 --out /tmp/shots
//   for f in /tmp/shots/*.png; do magick "$f" -quality 82 -define webp:method=6 \
//     "website/public/screenshots/$(basename "${f%.png}").webp"; done
//
// Writes hero-<theme> and tests-<theme>. The data is fake.
const auth = (type) => ({
  type,
  username: "",
  password: "",
  token: "",
  prefix: "",
  apiKey: "",
  apiValue: "",
  apiIn: "header",
});
const kv = (key, value) => ({ key, value, enabled: true });

const reqBody = JSON.stringify(
  {
    customer: "cus_8NQ2KD",
    currency: "EUR",
    lines: [{ description: "Pro plan, November", amount: 1250 }],
    due: "{{dueDate}}",
  },
  null,
  2,
);

const testScript = `pm.test("returns 201", () => {
  pm.response.to.have.status(201);
});

const invoice = pm.response.json();
pm.test("starts open", () => {
  pm.expect(invoice.status).to.equal("open");
});
pm.test("totals the lines", () => {
  pm.expect(invoice.total).to.equal(1250);
});

// Hand the id to the next request in the run
pm.collectionVariables.set("invoiceId", invoice.id);
`;

const request = (id, name, method, url, extra = {}) => ({
  id,
  name,
  seq: 1,
  method,
  url,
  pathParams: [],
  query: [],
  headers: [kv("Accept", "application/json")],
  body: {
    type: "none",
    raw: "",
    language: "json",
    formData: [],
    urlEncoded: [],
    binaryPath: "",
  },
  auth: auth("inherit"),
  scripts: { preRequest: "", test: "" },
  ...extra,
});

const requests = {
  r1: request(
    "r1",
    "List invoices",
    "GET",
    "{{baseUrl}}/v1/invoices?status=open",
    {
      query: [kv("status", "open")],
    },
  ),
  r2: request("r2", "Create invoice", "POST", "{{baseUrl}}/v1/invoices", {
    headers: [
      kv("Accept", "application/json"),
      kv("Idempotency-Key", "{{$guid}}"),
    ],
    body: {
      type: "raw",
      raw: reqBody,
      language: "json",
      formData: [],
      urlEncoded: [],
      binaryPath: "",
    },
    scripts: { preRequest: "", test: testScript },
  }),
  r3: request(
    "r3",
    "Update invoice",
    "PATCH",
    "{{baseUrl}}/v1/invoices/{{invoiceId}}",
  ),
  r4: request(
    "r4",
    "Void invoice",
    "DELETE",
    "{{baseUrl}}/v1/invoices/{{invoiceId}}",
  ),
  r5: request("r5", "Get token", "POST", "{{authUrl}}/oauth/token"),
  r6: request("r6", "List customers", "GET", "{{baseUrl}}/v1/customers"),
};
const leaf = (r, parentId) => ({
  kind: "request",
  id: r.id,
  name: r.name,
  method: r.method,
  url: r.url,
  seq: 1,
  parentId,
  children: [],
});
const folder = (id, name, parentId, children) => ({
  kind: "folder",
  id,
  name,
  seq: 1,
  parentId,
  children,
});
const tree = {
  collections: [
    {
      kind: "collection",
      id: "c1",
      name: "Billing API",
      seq: 1,
      parentId: "",
      children: [
        folder("f1", "Auth", "c1", [leaf(requests.r5, "f1")]),
        folder(
          "f2",
          "Invoices",
          "c1",
          ["r1", "r2", "r3", "r4"].map((id) => leaf(requests[id], "f2")),
        ),
        folder("f3", "Customers", "c1", [leaf(requests.r6, "f3")]),
      ],
    },
    {
      kind: "collection",
      id: "c2",
      name: "Webhooks",
      seq: 2,
      parentId: "",
      children: [],
    },
  ],
  problems: [],
};

const env = { id: "e1", name: "Staging" };
const visible = [
  {
    key: "baseUrl",
    value: "https://api.staging.example.com",
    secret: false,
    scope: "environment",
    scopeId: "e1",
    scopeName: "Staging",
    set: true,
  },
  {
    key: "dueDate",
    value: "2026-12-21",
    secret: false,
    scope: "collection",
    scopeId: "c1",
    scopeName: "Billing API",
    set: true,
  },
];

const resBody = JSON.stringify(
  {
    id: "inv_01J9X4",
    object: "invoice",
    customer: "cus_8NQ2KD",
    currency: "EUR",
    status: "open",
    total: 1250,
    lines: [{ description: "Pro plan, November", amount: 1250 }],
    due: "2026-12-21",
    created: "2026-11-21T09:41:07Z",
  },
  null,
  2,
);
const src = {
  kind: "request",
  id: "r2",
  name: "Create invoice",
  event: "test",
};
const test = (name) => ({
  name,
  passed: true,
  skipped: false,
  error: "",
  source: src,
});

export const handlers = {
  "WorkspaceService.Current": () => ({
    id: "w1",
    name: "Billing",
    path: "/home/me/billing",
  }),
  "WorkspaceService.Tree": () => tree,
  "WorkspaceService.GetCollection": (id) => ({
    id,
    name: id === "c1" ? "Billing API" : "Webhooks",
    auth: auth("bearer"),
    headers: [],
    variables: [],
  }),
  "WorkspaceService.GetFolder": (id) => ({
    id,
    name: "Invoices",
    auth: auth("inherit"),
    headers: [],
  }),
  "RequestService.Get": (id) => requests[id] ?? null,
  "RequestService.Send": () => ({
    response: {
      statusCode: 201,
      statusText: "201 Created",
      proto: "HTTP/2.0",
      url: "https://api.staging.example.com/v1/invoices",
      headers: [
        kv("Content-Type", "application/json"),
        kv("Location", "/v1/invoices/inv_01J9X4"),
        kv("Request-Id", "req_7Hc2"),
      ],
      cookies: [],
      contentType: "application/json",
      kind: "json",
      body: resBody,
      encoding: "utf8",
      size: resBody.length,
      truncated: false,
      bodyPath: "",
      timings: {
        dns: 3,
        connect: 11,
        tls: 24,
        ttfb: 81,
        total: 96,
        reusedConn: false,
      },
    },
    error: null,
    historyId: 1,
    unresolved: [],
    secretsLocked: false,
    environment: env,
    hops: [],
    tests: [test("returns 201"), test("starts open"), test("totals the lines")],
    console: [],
  }),
  "EnvService.List": () => [
    { id: "e0", name: "Development", seq: 1, variables: [] },
    { id: "e1", name: "Staging", seq: 2, variables: [] },
    { id: "e2", name: "Production", seq: 3, variables: [] },
  ],
  "EnvService.Selected": () => env,
  "EnvService.ResolvePreview": () => ({
    headers: [],
    overridden: [],
    auth: auth("bearer"),
    authSource: { kind: "collection", id: "c1", name: "Billing API" },
    variables: visible,
    unresolved: [],
    secretsLocked: false,
    environment: env,
    error: "",
  }),
  "EnvService.VisibleVariables": () => ({
    variables: visible,
    shadowed: [],
    environment: env,
  }),
  "EnvService.OverlayValues": () => [],
};

async function open(page, name) {
  await page.getByRole("treeitem", { name: new RegExp(name) }).click();
  await page.waitForTimeout(400);
}

export async function run({ page, shot }) {
  // Expand the Invoices folder.
  const invoices = page.getByRole("treeitem", { name: /^Invoices/ });
  if ((await invoices.getAttribute("aria-expanded")) !== "true")
    await invoices.click();
  await page.waitForTimeout(300);
  await open(page, "Create invoice");
  // Close the untitled tab if there is one.
  const untitled = page.getByRole("button", { name: /Close Untitled request/ });
  if (await untitled.count()) await untitled.first().click();
  await page.getByRole("tab", { name: /^Body/ }).first().click();
  await page.keyboard.press("Control+Enter");
  await page.waitForTimeout(700);
  await page.mouse.click(5, 5);
  await shot("hero");

  await page
    .getByRole("tab", { name: /^Scripts/ })
    .first()
    .click();
  await page.waitForTimeout(300);
  await page
    .getByRole("tab", { name: /^Tests/ })
    .first()
    .click();
  await page.waitForTimeout(300);
  await page
    .getByRole("tab", { name: /^Tests/ })
    .last()
    .click();
  await page.waitForTimeout(500);
  await page.mouse.click(5, 5);
  await shot("tests");
}
