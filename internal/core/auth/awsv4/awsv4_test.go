package awsv4

import (
	"errors"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

// Cases from the AWS Signature Version 4 test suite (aws-sig-v4-test-suite,
// Apache-2.0): credentials AKIDEXAMPLE, region us-east-1, service
// "service", 2015-08-30T12:36:00Z, host example.amazonaws.com. Only the
// expected signatures are reproduced; the suite signs every header given,
// so the cases picked carry only headers this signer signs.
var (
	suiteCreds = Credentials{AccessKey: "AKIDEXAMPLE", SecretKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY"}
	suiteTime  = time.Date(2015, 8, 30, 12, 36, 0, 0, time.UTC)
)

const stsToken = "AQoDYXdzEPT//////////wEXAMPLEtc764bNrC9SAPBSM22wDOk4x4HIZ8j4FZTwdQWLWsKWHGBuFqwAeMicRXmxfpSPfIeoIYRqTflfKD8YUuwthAx7mSEI/qkPpKPi/kMcGdQrmGdeehM4IC1NtBmUpp2wUE8phUZampKsburEDy0KPkyQDYwT7WZ0wq5VSXDvp75YU9HFvlRd8Tx6q6fE8YQcHNVXAkiY9q6d+xo0rKwT38xVqr7ZD0u0iPPkUL64lIZbqBAz+scqKmlzm8FDrypNC9Yjc8fPOLn9FX9KSYvKTr4rvx3iSIlTJabIQwj2ICCR/oLxBA=="

func TestSuite(t *testing.T) {
	tests := []struct {
		name, method, target, contentType, body, token, signed, sig string
	}{
		{"get-vanilla", "GET", "/", "", "", "", "host;x-amz-date", "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"},
		{"post-vanilla", "POST", "/", "", "", "", "host;x-amz-date", "5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b"},
		{"get-vanilla-query-order-key-case", "GET", "/?Param2=value2&Param1=value1", "", "", "", "host;x-amz-date", "b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500"},
		{"get-vanilla-empty-query-key", "GET", "/?Param1=value1", "", "", "", "host;x-amz-date", "a67d582fa61cc504c4bae71f336f98b97f1ea3c7a6bfe1b6e45aec72011b9aeb"},
		{"get-relative-relative", "GET", "/example1/example2/../..", "", "", "", "host;x-amz-date", "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"},
		{"get-slash-dot-slash", "GET", "/./", "", "", "", "host;x-amz-date", "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"},
		{"get-slash-pointless-dot", "GET", "/./example", "", "", "", "host;x-amz-date", "ef75d96142cf21edca26f06005da7988e4f8dc83a165a80865db7089db637ec5"},
		{"post-x-www-form-urlencoded", "POST", "/", "application/x-www-form-urlencoded", "Param1=value1", "", "content-type;host;x-amz-date", "ff11897932ad3f4e8b18135d722051e5ac45fc38421b1da7b9d196a0fe09473a"},
		{"post-sts-header-before", "POST", "/", "", "", stsToken, "host;x-amz-date;x-amz-security-token", "85d96828115b5dc0cfc3bd16ad9e210dd772bbebba041836c64533a82be05ead"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := &http.Request{Method: tt.method, URL: &url.URL{Scheme: "https", Host: "example.amazonaws.com", Opaque: "", Path: ""}, Header: http.Header{}}
			u, err := url.Parse("https://example.amazonaws.com" + tt.target)
			if err != nil {
				t.Fatal(err)
			}
			r.URL = u
			if tt.contentType != "" {
				r.Header.Set("Content-Type", tt.contentType)
			}
			c := suiteCreds
			c.SessionToken = tt.token
			if err := Sign(r, c, Options{Region: "us-east-1", Service: "service", Time: suiteTime, PayloadHash: HashPayload([]byte(tt.body))}); err != nil {
				t.Fatal(err)
			}
			want := "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=" + tt.signed + ", Signature=" + tt.sig
			if got := r.Header.Get("Authorization"); got != want {
				t.Errorf("got  %s\nwant %s", got, want)
			}
			if r.Header.Get(HeaderDate) != "20150830T123600Z" {
				t.Error("date header")
			}
		})
	}
}

// The IAM ListUsers example from the AWS documentation.
func TestDocumentationExample(t *testing.T) {
	u, _ := url.Parse("https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08")
	r := &http.Request{Method: "GET", URL: u, Header: http.Header{"Content-Type": {"application/x-www-form-urlencoded; charset=utf-8"}}}
	if err := Sign(r, suiteCreds, Options{Region: "us-east-1", Service: "iam", Time: suiteTime}); err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(r.Header.Get("Authorization"), "Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7") {
		t.Errorf("got %s", r.Header.Get("Authorization"))
	}
}

func TestS3AndUnsigned(t *testing.T) {
	u, _ := url.Parse("https://bucket.s3.amazonaws.com/a%20b/./c")
	r := &http.Request{Method: "PUT", URL: u, Header: http.Header{"X-Amz-Meta-Note": {"  a   b "}, "User-Agent": {"x"}}}
	if err := Sign(r, suiteCreds, Options{Region: "eu-west-1", Service: "s3", Time: suiteTime, PayloadHash: UnsignedPayload}); err != nil {
		t.Fatal(err)
	}
	if r.Header.Get(HeaderContent) != UnsignedPayload {
		t.Error("content header")
	}
	if a := r.Header.Get("Authorization"); !strings.Contains(a, "SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-meta-note,") {
		t.Errorf("signed headers: %s", a)
	}
	if got := CanonicalURI(u, true); got != "/a%20b/./c" {
		t.Errorf("s3 uri = %s", got)
	}
	if got := CanonicalURI(u, false); got != "/a%2520b/c" {
		t.Errorf("double-encoded uri = %s", got)
	}
	for in, want := range map[string]string{"": "/", "/a/..": "/", "/a/b/.": "/a/b/", "/..": "/", "/a//b": "/a//b"} {
		if got := CanonicalURI(&url.URL{Path: in}, false); got != want {
			t.Errorf("CanonicalURI(%q) = %q, want %q", in, got, want)
		}
	}
	if got := CanonicalQuery("b=2&a=2&a=1&&c&d=%2B+x&e=%zz"); got != "a=1&a=2&b=2&c=&d=%2B%20x&e=%25zz" {
		t.Errorf("query = %s", got)
	}
	r2 := &http.Request{Method: "GET", URL: u, Host: "other", Header: http.Header{}}
	_ = Sign(r2, suiteCreds, Options{Region: "r", Service: "x", Time: suiteTime, ContentHeader: true})
	if r2.Header.Get(HeaderContent) != HashPayload(nil) {
		t.Error("content header on request")
	}
}

func TestErrors(t *testing.T) {
	r := &http.Request{URL: &url.URL{}, Header: http.Header{}}
	if err := Sign(r, Credentials{AccessKey: "a"}, Options{}); !errors.Is(err, ErrNoKeys) {
		t.Errorf("err = %v", err)
	}
	if err := Sign(r, suiteCreds, Options{Region: "r"}); !errors.Is(err, ErrNoRegion) {
		t.Errorf("err = %v", err)
	}
}
