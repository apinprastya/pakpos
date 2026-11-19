package curl

import (
	"strings"
	"testing"

	"pakpos/internal/core/model"
)

func TestOtherAuthRoundTrip(t *testing.T) {
	tests := []struct {
		name string
		text string
		auth model.Auth
		gen  []string
	}{
		{"digest", `curl --digest -u ann:secret https://a.com`,
			model.Auth{Type: model.AuthDigest, Digest: &model.Digest{Username: "ann", Password: "secret"}}, []string{"--digest", "-u ann:secret"}},
		{"ntlm with domain", `curl --ntlm -u 'CORP\ann:pw' https://a.com`,
			model.Auth{Type: model.AuthNTLM, NTLM: &model.NTLM{Domain: "CORP", Username: "ann", Password: "pw"}}, []string{"--ntlm", `-u 'CORP\ann:pw'`}},
		{"ntlm", `curl -u ann:pw --ntlm https://a.com`,
			model.Auth{Type: model.AuthNTLM, NTLM: &model.NTLM{Username: "ann", Password: "pw"}}, []string{"--ntlm", "-u ann:pw"}},
		{"aws", `curl --aws-sigv4 aws:amz:eu-west-1:s3 -u AK:SK -H 'X-Amz-Security-Token: tok' -H 'x-amz-content-sha256: UNSIGNED-PAYLOAD' https://b.s3.amazonaws.com/k`,
			model.Auth{Type: model.AuthAWSV4, AWSV4: &model.AWSV4{AccessKey: "AK", SecretKey: "SK", SessionToken: "tok", Region: "eu-west-1", Service: "s3", UnsignedPayload: true}},
			[]string{"--aws-sigv4 aws:amz:eu-west-1:s3", "-u AK:SK", "-H 'X-Amz-Security-Token: tok'", "-H 'X-Amz-Content-Sha256: UNSIGNED-PAYLOAD'"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r, warns, err := Parse(tt.text)
			if err != nil || len(warns) != 0 {
				t.Fatalf("%v %v", err, warns)
			}
			if !sameAuth(r.Auth, tt.auth) || len(r.Headers) != 0 {
				t.Errorf("auth %+v headers %+v", r.Auth, r.Headers)
			}
			out := Generate(r)
			for _, g := range tt.gen {
				if !strings.Contains(out, g) {
					t.Errorf("missing %q in\n%s", g, out)
				}
			}
			back, _, err := Parse(out)
			if err != nil || !sameAuth(back.Auth, tt.auth) {
				t.Errorf("round trip: %+v %v", back.Auth, err)
			}
		})
	}
	// Warnings: no -u, and a SigV4 value without region/service.
	if _, warns, _ := Parse("curl --digest https://a.com"); len(warns) != 1 || !strings.Contains(warns[0].Message, "needs credentials") {
		t.Errorf("no -u: %v", warns)
	}
	r, warns, _ := Parse("curl --aws-sigv4 aws:amz -u a:b https://a.com")
	if len(warns) != 1 || !strings.Contains(warns[0].Message, "region") || r.Auth.AWSV4.Region != "" {
		t.Errorf("no region: %v", warns)
	}
	// JWT and Hawk become a computed header.
	r = model.Request{Method: "GET", URL: "https://a.com", Auth: model.Auth{Type: model.AuthJWT, JWT: &model.JWT{Secret: "s"}}}
	if out := Generate(r); !strings.Contains(out, "Authorization: Bearer ey") {
		t.Errorf("jwt: %s", out)
	}
}

func sameAuth(a, b model.Auth) bool {
	if a.Type != b.Type {
		return false
	}
	switch a.Type {
	case model.AuthDigest:
		return *a.Digest == *b.Digest
	case model.AuthNTLM:
		return *a.NTLM == *b.NTLM
	case model.AuthAWSV4:
		return *a.AWSV4 == *b.AWSV4
	}
	return true
}
