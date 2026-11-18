package curl

import (
	"errors"
	"reflect"
	"strings"
	"testing"

	"pakpos/internal/core/model"
)

func TestSplitWords(t *testing.T) {
	tests := []struct {
		name  string
		text  string
		words []string
		warns int
	}{
		{"plain", "curl -s https://a.com", []string{"curl", "-s", "https://a.com"}, 0},
		{"single quotes", `curl 'a b' 'it'\''s'`, []string{"curl", "a b", "it's"}, 0},
		{"double quotes", `curl "a \"b\" \$HOME \\ \x \` + "\n" + `c"`, []string{"curl", `a "b" $HOME \ \x c`}, 0},
		{"adjacent", `curl a'b'"c"d`, []string{"curl", "abcd"}, 0},
		{"backslash escapes", `curl a\ b \'x`, []string{"curl", "a b", "'x"}, 0},
		{"trailing backslash", `curl a\`, []string{"curl", "a"}, 0},
		{"continuation", "curl \\\n  -s \\\r\n  url", []string{"curl", "-s", "url"}, 0},
		{"wrapped lines", "curl\n-s\nurl", []string{"curl", "-s", "url"}, 0},
		{"ansi-c", `curl $'a\nb\t\'\\\x41\u00e9\U0001F600\101\cA\e\a\b\f\v\r\"\?\z\x\u'`,
			[]string{"curl", "a\nb\t'\\Aé😀A\x01\x1b\a\b\f\v\r\"?\\z\\x\\u"}, 0},
		{"comment", "curl a # comment 'unclosed\n b", []string{"curl", "a", "b"}, 0},
		{"hash inside a word", "curl a#b", []string{"curl", "a#b"}, 0},
		{"pipe", "curl a | jq .", []string{"curl", "a"}, 1},
		{"pipe in word", "curl a|jq", []string{"curl", "a"}, 1},
		{"semicolon", "curl a; echo done", []string{"curl", "a"}, 1},
		{"semicolon in word", "curl -F a=@x;type=y", []string{"curl", "-F", "a=@x;type=y"}, 0},
		{"and", "curl a && echo ok", []string{"curl", "a"}, 1},
		{"ampersand in url", "curl http://a?x=1&y=2", []string{"curl", "http://a?x=1&y=2"}, 0},
		{"redirect", "curl a > out.json", []string{"curl", "a"}, 1},
		{"trailing separator only", "curl a ;", []string{"curl", "a"}, 0},
		{"second curl", "curl a\ncurl b", []string{"curl", "a"}, 1},
		{"powershell", "curl `\n  -s `  \r\n url`", []string{"curl", "-s", "url"}, 1},
		{"cmd", "curl ^\"a b^\" ^\n  -H ^\"x: ^\\^\"y^\\^\"^\" ^\r\n -d ^\"1^%^20^\"", []string{"curl", "a b", "-H", `x: "y"`, "-d", "1%20"}, 1},
		{"cmd old style", "curl \"a\\\"b\\\"\" ^\n -s \"c\"\"d\" & echo", []string{"curl", `a"b"`, "-s", `c"d`}, 2},
		{"cmd backslashes", `curl ^"C:\dir\\^" "x\\\"y"`, []string{"curl", `C:\dir\`, `x\"y`}, 1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res, err := splitWords(tt.text)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(res.words, tt.words) {
				t.Errorf("words = %q, want %q", res.words, tt.words)
			}
			if len(res.warnings) != tt.warns {
				t.Errorf("warnings = %v, want %d", res.warnings, tt.warns)
			}
		})
	}
}

func TestSplitWordsErrors(t *testing.T) {
	for _, text := range []string{`curl 'a`, `curl "a`, `curl $'a`, `curl "a\"`} {
		if _, err := splitWords(text); !errors.Is(err, ErrUnclosedQuote) {
			t.Errorf("%q: err = %v", text, err)
		}
	}
}

func hasWarning(ws []Warning, sub string) bool {
	for _, w := range ws {
		if strings.Contains(w.Message, sub) {
			return true
		}
	}
	return false
}

func TestParseErrors(t *testing.T) {
	tests := []struct {
		text string
		want error
	}{
		{"", ErrNotCurl},
		{"wget https://a.com", ErrNotCurl},
		{"curl -s", ErrMissingURL},
		{"curl https://a.com -H", ErrMissingArgument},
		{"curl https://a.com --header", ErrMissingArgument},
		{"curl 'https://a.com", ErrUnclosedQuote},
	}
	for _, tt := range tests {
		if _, _, err := Parse(tt.text); !errors.Is(err, tt.want) {
			t.Errorf("%q: err = %v, want %v", tt.text, err, tt.want)
		}
	}
}

func kv(k, v string) model.KeyValue { return model.KeyValue{Key: k, Value: v, Enabled: true} }

func TestParse(t *testing.T) {
	tests := []struct {
		name  string
		text  string
		check func(t *testing.T, r model.Request)
		warn  []string
	}{
		{name: "defaults", text: "CURL.EXE example.com/x", check: func(t *testing.T, r model.Request) {
			if r.Method != "GET" || r.URL != "example.com/x" || r.Body.Type != model.BodyNone || r.Auth.Type != model.AuthNone {
				t.Errorf("%+v", r)
			}
		}},
		{name: "prompt and --url", text: "$ curl --url https://a.com -XDELETE", check: func(t *testing.T, r model.Request) {
			if r.Method != "DELETE" || r.URL != "https://a.com" {
				t.Errorf("%+v", r)
			}
		}},
		{name: "--flag=value and combined short flags", text: "curl -sSL --request=put --header=X-A:1 https://a.com", check: func(t *testing.T, r model.Request) {
			if r.Method != "PUT" || !reflect.DeepEqual(r.Headers, []model.KeyValue{kv("X-A", "1")}) ||
				r.Settings.FollowRedirects == nil || !*r.Settings.FollowRedirects {
				t.Errorf("%+v", r)
			}
		}},
		{name: "-- ends options", text: "curl -- -weird", check: func(t *testing.T, r model.Request) {
			if r.URL != "-weird" {
				t.Errorf("%q", r.URL)
			}
		}},
		{name: "--no- flags are quiet", text: "curl --no-progress-meter --no-buffer https://a.com", check: func(t *testing.T, r model.Request) {}},
		{name: "unknown short", text: "curl -Z https://a.com", warn: []string{"Unknown option -Z"}},
		{name: "headers", text: `curl https://a.com -H 'Empty;' -H 'X-Remove:' -H 'nocolon' -H @headers.txt -H 'A:  b c '`, check: func(t *testing.T, r model.Request) {
			want := []model.KeyValue{kv("Empty", ""), kv("A", "b c")}
			if !reflect.DeepEqual(r.Headers, want) {
				t.Errorf("headers = %+v", r.Headers)
			}
		}, warn: []string{"removes a header", "has no colon", "from a file"}},
		{name: "cookies, agent, referer", text: `curl https://a.com -b 'a=1' -b cookies.txt -A 'Agent/1' -e 'https://r.com;auto'`, check: func(t *testing.T, r model.Request) {
			want := []model.KeyValue{kv("Cookie", "a=1"), kv("User-Agent", "Agent/1"), kv("Referer", "https://r.com")}
			if !reflect.DeepEqual(r.Headers, want) {
				t.Errorf("headers = %+v", r.Headers)
			}
		}, warn: []string{"cookies from a file"}},
		{name: "user without password", text: "curl -u bob https://a.com", check: func(t *testing.T, r model.Request) {
			if r.Auth.Type != model.AuthBasic || r.Auth.Username != "bob" || r.Auth.Password != "" {
				t.Errorf("%+v", r.Auth)
			}
		}, warn: []string{"No password"}},
		{name: "oauth2 bearer", text: "curl --oauth2-bearer tok https://a.com", check: func(t *testing.T, r model.Request) {
			if r.Auth.Type != model.AuthBearer || r.Auth.Token != "tok" {
				t.Errorf("%+v", r.Auth)
			}
		}},
		{name: "authorization header wins over -u", text: "curl -u a:b -H 'Authorization: Token x' --digest https://a.com", check: func(t *testing.T, r model.Request) {
			if r.Auth.Type != model.AuthNone || len(r.Headers) != 1 {
				t.Errorf("%+v %+v", r.Auth, r.Headers)
			}
		}, warn: []string{"Only basic auth"}},
		{name: "basic header not decodable stays", text: "curl -H 'Authorization: Basic !!' -H 'X: y' https://a.com", check: func(t *testing.T, r model.Request) {
			if r.Auth.Type != model.AuthNone || r.Headers[0].Value != "Basic !!" {
				t.Errorf("%+v %+v", r.Auth, r.Headers)
			}
		}},
		{name: "basic header without colon stays", text: "curl -H 'Authorization: Basic YWJj' https://a.com", check: func(t *testing.T, r model.Request) {
			if r.Auth.Type != model.AuthNone || len(r.Headers) != 1 {
				t.Errorf("%+v", r)
			}
		}},
		{name: "two authorization headers stay", text: "curl -H 'Authorization: Bearer a' -H 'Authorization: Bearer b' https://a.com", check: func(t *testing.T, r model.Request) {
			if r.Auth.Type != model.AuthNone || len(r.Headers) != 2 {
				t.Errorf("%+v", r)
			}
		}},
		{name: "head", text: "curl -I https://a.com", check: func(t *testing.T, r model.Request) {
			if r.Method != "HEAD" {
				t.Error(r.Method)
			}
		}},
		{name: "explicit method with data", text: "curl -X get -d a=1 https://a.com", check: func(t *testing.T, r model.Request) {
			if r.Method != "GET" || r.Body.Type != model.BodyURLEncoded {
				t.Errorf("%+v", r)
			}
		}},
		{name: "data joined with &", text: "curl -d a=1 --data-ascii b=2 --data-urlencode 'c=x y' --data-urlencode '=z&' --data-urlencode plain https://a.com", check: func(t *testing.T, r model.Request) {
			want := []model.KeyValue{kv("a", "1"), kv("b", "2"), kv("c", "x y"), kv("z&", ""), kv("plain", "")}
			if !reflect.DeepEqual(r.Body.URLEncoded, want) {
				t.Errorf("%+v", r.Body.URLEncoded)
			}
		}},
		{name: "data-urlencode file", text: "curl --data-urlencode name@file.txt --data-urlencode @f https://a.com", warn: []string{"with a file", "with a file"}},
		{name: "data stdin", text: "curl -d @- https://a.com", check: func(t *testing.T, r model.Request) {
			if r.Body.Type != model.BodyNone || r.Method != "GET" {
				t.Errorf("%+v", r)
			}
		}, warn: []string{"standard input"}},
		{name: "data file", text: "curl -d @body.json -H 'Content-Type: application/octet-stream' https://a.com", check: func(t *testing.T, r model.Request) {
			if r.Body.Type != model.BodyBinary || r.Body.BinaryPath != "body.json" || len(r.Headers) != 0 || r.Method != "POST" {
				t.Errorf("%+v", r)
			}
		}, warn: []string{"strip line breaks"}},
		{name: "file with other data", text: "curl --data-binary @a.bin -d x=1 https://a.com", check: func(t *testing.T, r model.Request) {
			if r.Body.Type != model.BodyBinary {
				t.Errorf("%+v", r.Body)
			}
		}, warn: []string{"combines a file"}},
		{name: "json file", text: "curl --json @data.json https://a.com", check: func(t *testing.T, r model.Request) {
			if r.Body.Type != model.BodyBinary || r.Body.BinaryPath != "data.json" ||
				!reflect.DeepEqual(r.Headers, []model.KeyValue{kv("Content-Type", "application/json"), kv("Accept", "application/json")}) {
				t.Errorf("%+v", r)
			}
		}},
		{name: "json concatenated, accept kept", text: `curl --json '{"a":' --json '1}' -H 'Accept: text/csv' https://a.com`, check: func(t *testing.T, r model.Request) {
			if r.Body.Raw != `{"a":1}` || r.Body.Language != model.LangJSON || !reflect.DeepEqual(r.Headers, []model.KeyValue{kv("Accept", "text/csv")}) {
				t.Errorf("%+v", r)
			}
		}},
		{name: "get with json", text: `curl -G --json 'a=1' --data-binary @f https://a.com`, check: func(t *testing.T, r model.Request) {
			if r.Method != "GET" || r.Body.Type != model.BodyNone || !reflect.DeepEqual(r.Query, []model.KeyValue{kv("a", "1")}) {
				t.Errorf("%+v", r)
			}
		}, warn: []string{"can't be added to the query"}},
		{name: "url-query", text: `curl --url-query 'a=b c' --url-query '+x=1&y=%20' 'https://a.com/p?z=0'`, check: func(t *testing.T, r model.Request) {
			want := []model.KeyValue{kv("z", "0"), kv("a", "b c"), kv("x", "1"), kv("y", " ")}
			if !reflect.DeepEqual(r.Query, want) || r.URL != "https://a.com/p?z=0&a=b%20c&x=1&y=%20" {
				t.Errorf("%q %+v", r.URL, r.Query)
			}
		}},
		{name: "path params", text: `curl 'https://a.com/users/:id'`, check: func(t *testing.T, r model.Request) {
			if !reflect.DeepEqual(r.PathParams, []model.KeyValue{kv("id", "")}) {
				t.Errorf("%+v", r.PathParams)
			}
		}},
		{name: "content types", text: `curl -H 'Content-Type: application/vnd.api+json' -d '{}' https://a.com`, check: func(t *testing.T, r model.Request) {
			if r.Body.Language != model.LangJSON || len(r.Headers) != 1 {
				t.Errorf("%+v", r)
			}
		}},
		{name: "xml", text: `curl -H 'Content-Type: text/xml' -d '<a/>' https://a.com`, check: func(t *testing.T, r model.Request) {
			if r.Body.Language != model.LangXML || len(r.Headers) != 1 {
				t.Errorf("%+v", r)
			}
		}},
		{name: "xml default dropped", text: `curl -H 'Content-Type: Application/XML' -d '<a/>' https://a.com`, check: func(t *testing.T, r model.Request) {
			if r.Body.Language != model.LangXML || len(r.Headers) != 0 {
				t.Errorf("%+v", r)
			}
		}},
		{name: "html", text: `curl -H 'Content-Type: text/html' -d '<p>' https://a.com`, check: func(t *testing.T, r model.Request) {
			if r.Body.Language != model.LangHTML {
				t.Errorf("%+v", r.Body)
			}
		}},
		{name: "javascript", text: `curl -H 'Content-Type: text/javascript' -d 'x()' https://a.com`, check: func(t *testing.T, r model.Request) {
			if r.Body.Language != model.LangJavaScript {
				t.Errorf("%+v", r.Body)
			}
		}},
		{name: "text default dropped", text: `curl -H 'Content-Type: text/plain; charset=utf-8' -d 'hi there' https://a.com`, check: func(t *testing.T, r model.Request) {
			if r.Body.Language != model.LangText || len(r.Headers) != 0 {
				t.Errorf("%+v", r)
			}
		}},
		{name: "other type is text with header", text: `curl -H 'Content-Type: text/csv' -d 'a,b' https://a.com`, check: func(t *testing.T, r model.Request) {
			if r.Body.Language != model.LangText || len(r.Headers) != 1 {
				t.Errorf("%+v", r)
			}
		}},
		{name: "urlencoded default dropped", text: `curl -H 'content-type: application/x-www-form-urlencoded' -d 'a=1' https://a.com`, check: func(t *testing.T, r model.Request) {
			if r.Body.Type != model.BodyURLEncoded || len(r.Headers) != 0 {
				t.Errorf("%+v", r)
			}
		}},
		{name: "not a form", text: `curl -d 'hello world' https://a.com`, check: func(t *testing.T, r model.Request) {
			if r.Body.Language != model.LangText || r.Body.Raw != "hello world" {
				t.Errorf("%+v", r.Body)
			}
		}, warn: []string{"isn't in name=value form"}},
		{name: "empty data", text: `curl -d '' https://a.com`, check: func(t *testing.T, r model.Request) {
			if r.Method != "POST" || r.Body.Type != model.BodyURLEncoded {
				t.Errorf("%+v", r)
			}
		}},
		{name: "bad multipart", text: `curl -H 'Content-Type: multipart/form-data' -d 'x' https://a.com`, check: func(t *testing.T, r model.Request) {
			if r.Body.Language != model.LangText {
				t.Errorf("%+v", r.Body)
			}
		}, warn: []string{"couldn't be read"}},
		{name: "broken multipart", text: `curl -H 'Content-Type: multipart/form-data; boundary=b' -d $'--b\r\nbad' https://a.com`, warn: []string{"couldn't be read"}},
		{name: "multipart text part type", text: `curl -H 'Content-Type: multipart/form-data; boundary=b' --data-raw $'--b\r\nContent-Disposition: form-data; name="a"\r\nContent-Type: text/plain\r\n\r\nv\r\n--b\r\nContent-Disposition: form-data; name="f"; filename="x.bin"\r\nContent-Type: application/octet-stream\r\n\r\n\r\n--b--\r\n' https://a.com`, check: func(t *testing.T, r model.Request) {
			f := r.Body.FormData
			if len(f) != 2 || f[0].ContentType != "text/plain" || f[0].Value != "v" || f[1].ContentType != "" || f[1].FilePath != "x.bin" {
				t.Errorf("%+v", f)
			}
		}, warn: []string{"choose x.bin again"}},
		{name: "form wins over data", text: `curl -F 'a=1' -F 'bad' -d x=1 -H 'Content-Type: multipart/form-data' https://a.com`, check: func(t *testing.T, r model.Request) {
			if r.Body.Type != model.BodyFormData || len(r.Body.FormData) != 1 || len(r.Headers) != 0 {
				t.Errorf("%+v", r)
			}
		}, warn: []string{"has no '='", "both data and form"}},
		{name: "form quoting and options", text: `curl -F 'f=@"my;file.txt";filename=x.txt;headers=X: 1' -F 'g=@a.png;type=image/png' https://a.com`, check: func(t *testing.T, r model.Request) {
			f := r.Body.FormData
			if f[0].FilePath != "my;file.txt" || f[1].ContentType != "image/png" || f[1].FilePath != "a.png" {
				t.Errorf("%+v", f)
			}
		}, warn: []string{"file name", "isn't supported"}},
		{name: "settings options", text: "curl -k -L --compressed -x http://p:1 --connect-timeout 2 -T f --cert c --max-redirs 3 -m 2.5 https://a.com", check: func(t *testing.T, r model.Request) {
			s := r.Settings
			if s.VerifyTLS == nil || *s.VerifyTLS || s.FollowRedirects == nil || !*s.FollowRedirects ||
				s.MaxRedirects == nil || *s.MaxRedirects != 3 || s.TimeoutMs == nil || *s.TimeoutMs != 2500 {
				t.Errorf("%+v", s)
			}
		}, warn: []string{"compressed", "Proxies", "one timeout", "-T", "Certificates"}},
		{name: "unlimited and zero redirects", text: "curl --location-trusted --max-redirs -1 --max-time 0 https://a.com", check: func(t *testing.T, r model.Request) {
			if *r.Settings.MaxRedirects != 50 || !*r.Settings.FollowRedirects || *r.Settings.TimeoutMs != 0 {
				t.Errorf("%+v", r.Settings)
			}
		}, warn: []string{"credentials", "at most 50"}},
		{name: "max-redirs 0 stops following", text: "curl -L --max-redirs 0 https://a.com", check: func(t *testing.T, r model.Request) {
			if *r.Settings.FollowRedirects || r.Settings.MaxRedirects != nil {
				t.Errorf("%+v", r.Settings)
			}
		}},
		{name: "bad settings values", text: "curl --max-redirs x --max-time soon -m 99999 https://a.com", check: func(t *testing.T, r model.Request) {
			if r.Settings.MaxRedirects != nil || *r.Settings.TimeoutMs != 600000 {
				t.Errorf("%+v", r.Settings)
			}
		}, warn: []string{"number of redirects", "number of seconds", "at most 10 minutes"}},
		{name: "two urls", text: "curl https://a.com https://b.com", check: func(t *testing.T, r model.Request) {
			if r.URL != "https://a.com" {
				t.Error(r.URL)
			}
		}, warn: []string{"2 URLs"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r, warnings, err := Parse(tt.text)
			if err != nil {
				t.Fatal(err)
			}
			if tt.check != nil {
				tt.check(t, r)
			}
			if len(warnings) != len(tt.warn) {
				t.Errorf("warnings = %+v, want %d", warnings, len(tt.warn))
			}
			for _, w := range tt.warn {
				if !hasWarning(warnings, w) {
					t.Errorf("no warning containing %q in %+v", w, warnings)
				}
			}
		})
	}
}

func TestMessage(t *testing.T) {
	for _, text := range []string{"ls", "curl 'a", "curl -s", "curl a -H"} {
		_, _, err := Parse(text)
		if msg := Message(err); msg == "" || strings.Contains(msg, "Couldn't read") {
			t.Errorf("%q: %q", text, msg)
		}
	}
	if !strings.Contains(Message(ErrMissingArgument), "missing its value") || !strings.Contains(Message(errors.New("x")), "Couldn't read") {
		t.Error("fallbacks")
	}
	_, _, err := Parse("curl a -H")
	if !strings.Contains(Message(err), "(-H)") {
		t.Error(Message(err))
	}
}

func TestSuggestName(t *testing.T) {
	long := "/v1/organizations/{{orgId}}/projects/{{projectId}}/environments/production/deployments"
	tests := []struct{ method, url, want string }{
		{"post", "https://api.example.com/v2/orders?x=1#f", "POST /v2/orders"},
		{"", "https://api.example.com", "GET /"},
		{"GET", "example.com/", "GET /"},
		{"GET", "{{baseUrl}}/users/{{id}}", "GET /users/{{id}}"},
		{"DELETE", "https://a.com" + long, "DELETE /v1/…/environments/production/deployments"},
		{"GET", "https://a.com/" + strings.Repeat("x", 80), "GET /" + strings.Repeat("x", 46) + "…"},
		{"GET", "https://a.com/" + strings.Repeat("y", 40) + "/" + strings.Repeat("z", 40), "GET /" + strings.Repeat("y", 40) + "/zzzzz…"},
	}
	for _, tt := range tests {
		if got := SuggestName(model.Request{Method: tt.method, URL: tt.url}); got != tt.want {
			t.Errorf("%s %s: got %q, want %q", tt.method, tt.url, got, tt.want)
		}
	}
}
