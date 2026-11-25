package script

import (
	"strings"
	"testing"
)

func TestCheckSchema(t *testing.T) {
	cases := []struct {
		name, schema, value, invalid string
		problems                     []string
	}{
		{"passes", `{"type":"object","required":["id"]}`, `{"id":1}`, "", nil},
		{"lists every problem by location", `{"type":"object","required":["id","name"],"properties":{
			"id":{"type":"integer"},"email":{"format":"email"},"tags":{"type":"array","items":{"type":"string"}}}}`,
			`{"id":"x","email":"nope","tags":[1,"a",2]}`, "",
			[]string{"/: missing property 'name'", "/email: 'nope' is not valid email: missing @", "/id: got string, want integer",
				"/tags/0: got number, want string", "/tags/2: got number, want string"}},
		{"local refs", `{"$ref":"#/definitions/a","definitions":{"a":{"minimum":3}}}`, `1`, "", []string{"/: minimum: got 1, want 3"}},
		{"false schema", `false`, `1`, "", []string{"/: false schema"}},
		{"draft from $schema", `{"$schema":"https://json-schema.org/draft/2020-12/schema","prefixItems":[{"type":"string"}]}`, `[1]`, "",
			[]string{"/0: got number, want string"}},
		{"draft-07 by default", `{"items":[{"type":"string"}]}`, `[1]`, "", []string{"/0: got number, want string"}},
		{"no files", `{"$ref":"file:///etc/passwd"}`, `1`, "isn't supported: put the definitions in the schema itself", nil},
		{"no network", `{"$ref":"https://example.com/s.json"}`, `1`, "isn't supported", nil},
		{"bad schema", `{"type":"nope"}`, `1`, "not valid against metaschema", nil},
		{"schema not JSON", `{`, `1`, "the schema isn't JSON", nil},
		{"value not JSON", `true`, `{`, "the value isn't JSON", nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			invalid, problems := checkSchema(c.schema, c.value)
			if c.invalid != "" {
				if !strings.Contains(invalid, c.invalid) || strings.Contains(invalid, schemaURL) || strings.Contains(invalid, "\n") {
					t.Fatalf("invalid = %q", invalid)
				}
				return
			}
			if invalid != "" || strings.Join(problems, "|") != strings.Join(c.problems, "|") {
				t.Fatalf("invalid %q, problems %q", invalid, problems)
			}
		})
	}
}

func TestCheckSchemaCapsProblems(t *testing.T) {
	_, problems := checkSchema(`{"items":{"type":"string"}}`, "["+strings.Repeat("1,", 30)+"1]")
	if len(problems) != MaxSchemaErrors+1 || problems[MaxSchemaErrors] != "and 11 more" {
		t.Fatalf("problems = %q", problems)
	}
}

func TestJSONSchemaAssertion(t *testing.T) {
	resp := jsonResponse(200, `{"id": "x", "name": "Ann"}`)
	out := mustRun(t, Input{Response: resp, Script: `
const schema = {type: "object", required: ["id", "name"], properties: {id: {type: "integer"}}};
pm.test("response", () => pm.response.to.have.jsonSchema(schema));
pm.test("response passes", () => pm.response.to.have.jsonSchema({required: ["name"]}));
pm.test("not", () => pm.response.to.not.have.jsonSchema({required: ["name"]}));
pm.test("value", () => pm.expect({id: 1}).to.have.jsonSchema(schema));
pm.test("value passes", () => pm.expect([1, 2]).to.have.jsonSchema({type: "array", items: {type: "number"}}));
pm.test("bad schema", () => pm.expect(1).to.have.jsonSchema({type: "nope"}));
pm.test("no schema", () => pm.expect(1).to.have.jsonSchema("x"));
pm.test("undefined", () => pm.expect(undefined).to.have.jsonSchema({}));
`})
	got := testsText(out.Tests)
	for _, want := range []string{
		"fail response: AssertionError: expected data to satisfy schema but found following errors: \n/id: got string, want integer\n",
		"pass response passes\n",
		"fail not: AssertionError: expected data to not satisfy schema\n",
		"fail value: AssertionError: expected data to satisfy schema but found following errors: \n/: missing property 'name'\n",
		"pass value passes\n",
		"fail bad schema: TypeError: The JSON schema isn't valid:",
		"fail no schema: TypeError: jsonSchema needs a JSON schema object",
		"fail undefined: AssertionError: expected a value to check against the schema but got undefined\n",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in\n%s", want, got)
		}
	}
	out = mustRun(t, Input{Response: jsonResponse(200, "not json"), Script: `pm.test("t", () => pm.response.to.have.jsonSchema({}))`})
	if got := testsText(out.Tests); got != "fail t: AssertionError: expected response body to be a valid json\n" {
		t.Errorf("tests = %q", got)
	}
}
