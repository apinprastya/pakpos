# Response tools: JSONPath filter, JSON Schema, history diff

Three Tier 4 items (ROADMAP) that help read and check responses.

## Decisions

| Topic | Decision |
|---|---|
| JSONPath dialect | RFC 9535, written in TS (`features/response/jsonpath.ts`, no dependency): `$`, `.name`, `['name']`, `*`, `..`, indexes (negative), slices `start:end:step`, filters `?expr` with `== != < <= > >=`, `&& || !`, parentheses, existence tests and `length`/`count`/`match`/`search`/`value`. The Goessner/Postman form `[?(@.x > 1)]` works because parentheses are allowed. JMESPath isn't supported. |
| Exact values | It walks the JSON tool's tree (`parseJson`), so numbers and strings keep their text (`12345678901234567890` stays whole) and the result is printed with `stringifyJson`. |
| Filter UI | Pretty view of a JSON body: the toolbar's filter button opens a monospace input under it with the match count or the error (`role=status`). Matches show as a JSON array in the body editor. Escape or the close button hides it. A query that doesn't parse shows the unfiltered body. The open state and query are kept per tab in memory (`stores/jsonFilter.ts`), so a resend keeps the filter; never persisted. A truncated or invalid body says it can't be filtered. |
| JSON Schema | Assertions `pm.response.to.have.jsonSchema(schema)` and `pm.expect(value).to.have.jsonSchema(schema)` (Postman's names). Validation runs in Go with `github.com/santhosh-tekuri/jsonschema/v6` (Apache-2.0, pure Go): drafts 4 to 2020-12, draft-07 when the schema has no `$schema` (like Postman's Ajv), formats checked. `$ref` only inside the schema: the library's default loader reads `file://` URLs, so a loader that refuses everything replaces it (no files, no network). Failures list up to 20 problems as `/path: message` under chai-style wording ("expected data to satisfy schema but found following errors:"); a bad schema throws a TypeError naming the problem. |
| Compare entries | History rows get "Compare with another entry"; the list then asks for a second entry (banner with Cancel; clicking the first again stops). The lazy `CompareDialog` loads both (`api.historyGet`) and shows line diffs (Myers, `features/history/diff.ts`, common prefix/suffix trimmed, gives up past 4000 changed lines) of the response (status line, headers, formatted body) and the request (method and URL as written, enabled headers, auth type only, body). The earlier entry is the "−" side whatever the pick order. Unchanged runs more than 3 lines from a change fold into "Show N unchanged lines". "Ignore JSON key order" sorts keys of JSON bodies before comparing. |

## Progress

- [x] `jsonpath.ts` + tests (RFC examples, slices, comparisons, functions, errors).
- [x] Filter UI in `ResponseBody`, `stores/jsonFilter.ts`, tests in `ResponsePane.test.tsx`.
- [x] `script/schema.go` (`checkSchema`), the `jsonSchema` assertion in `expect.js`, `schema_test.go`; completions and the "Response matches a JSON schema" snippet.
- [x] `features/history/` (`diff.ts`, `entryText.ts`, `CompareDialog.tsx`), `stores/historyCompare.ts`, history row actions, tests.

## Left for later

- Comparing two runner runs (per request: status, tests, timings).
- JMESPath; saving filters per request; validating against an OpenAPI document.
- A schema editor/validator outside scripts (e.g. in the JSON tool).
