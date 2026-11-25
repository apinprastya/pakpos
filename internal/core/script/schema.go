package script

import (
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"golang.org/x/text/language"
	"golang.org/x/text/message"
)

// schemaURL is where a script's schema lives while it compiles. Its $refs
// can point inside it (#/definitions/x) but nowhere else.
const schemaURL = "urn:pakpos:script-schema"

// MaxSchemaErrors caps the errors a failed jsonSchema assertion lists.
const MaxSchemaErrors = 20

// noLoader refuses every $ref outside the schema: scripts must not read
// files or reach the network through a schema.
type noLoader struct{}

func (noLoader) Load(url string) (any, error) {
	return nil, fmt.Errorf("$ref to %s isn't supported: put the definitions in the schema itself", url)
}

// checkSchema validates the JSON value against the JSON schema (both as
// JSON text). invalid explains a schema that doesn't compile; otherwise
// problems lists where and why the value doesn't match ("/id: got string,
// want integer"), empty when it does. Schemas without $schema use draft-07,
// like Postman's Ajv; formats (email, date-time, uuid…) are checked.
func checkSchema(schemaJSON, valueJSON string) (invalid string, problems []string) {
	doc, err := jsonschema.UnmarshalJSON(strings.NewReader(schemaJSON))
	if err != nil {
		return "the schema isn't JSON: " + err.Error(), nil
	}
	c := jsonschema.NewCompiler()
	c.DefaultDraft(jsonschema.Draft7)
	c.AssertFormat()
	c.UseLoader(noLoader{})
	if err := c.AddResource(schemaURL, doc); err != nil {
		return compileMessage(err), nil
	}
	sch, err := c.Compile(schemaURL)
	if err != nil {
		return compileMessage(err), nil
	}
	value, err := jsonschema.UnmarshalJSON(strings.NewReader(valueJSON))
	if err != nil {
		return "the value isn't JSON: " + err.Error(), nil
	}
	err = sch.Validate(value)
	var ve *jsonschema.ValidationError
	if err == nil || !errors.As(err, &ve) {
		return "", nil
	}
	return "", schemaProblems(ve)
}

// compileMessage strips the internal schema URL from a compile error and
// puts it on one line.
func compileMessage(err error) string {
	msg := strings.ReplaceAll(err.Error(), schemaURL, "")
	return strings.Join(strings.Fields(strings.ReplaceAll(msg, "\n", "; ")), " ")
}

// schemaProblems lists the leaf errors (one per failing keyword) by
// location, at most MaxSchemaErrors.
func schemaProblems(ve *jsonschema.ValidationError) []string {
	p := message.NewPrinter(language.English)
	var out []string
	var walk func(e *jsonschema.ValidationError)
	walk = func(e *jsonschema.ValidationError) {
		if len(e.Causes) == 0 {
			out = append(out, "/"+strings.Join(e.InstanceLocation, "/")+": "+e.ErrorKind.LocalizedString(p))
			return
		}
		for _, c := range e.Causes {
			walk(c)
		}
	}
	walk(ve)
	sort.Strings(out)
	out = dedupeStrings(out)
	if len(out) > MaxSchemaErrors {
		n := len(out) - MaxSchemaErrors
		out = append(out[:MaxSchemaErrors], fmt.Sprintf("and %d more", n))
	}
	return out
}

func dedupeStrings(s []string) []string {
	out := s[:0]
	for i, v := range s {
		if i == 0 || v != s[i-1] {
			out = append(out, v)
		}
	}
	return out
}
