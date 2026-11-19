package auth

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"pakpos/internal/core/auth/awsv4"
	"pakpos/internal/core/auth/hawk"
	"pakpos/internal/core/jwtx"
	"pakpos/internal/core/model"
)

// Now is the clock for signatures and JWT claims (tests replace it).
var Now = time.Now

// Random is the source of JWT ids (tests replace it).
var Random io.Reader = rand.Reader

// Defaults of the JWT placement.
const (
	DefaultJWTPrefix = "Bearer"
	DefaultJWTParam  = "token"
)

// Errors for incomplete settings of the signed auth types.
var (
	ErrNoSettings = errors.New("the auth has no settings; open the Auth tab and fill them in")
	ErrJWTKey     = errors.New("JWT auth needs a signing key")
)

// Signed reports whether t is computed per send from the final request
// (AWS Signature v4, JWT, Hawk), so generated code holds a value that
// expires.
func Signed(t model.AuthType) bool {
	return t == model.AuthAWSV4 || t == model.AuthJWT || t == model.AuthHawk
}

// Handshake reports whether t needs a challenge from the server (Digest,
// NTLM), which httpexec answers; Apply leaves the request alone for them.
func Handshake(t model.AuthType) bool { return t == model.AuthDigest || t == model.AuthNTLM }

// readBody reads r's body into memory and puts it back, replayable.
func readBody(r *http.Request) ([]byte, error) {
	if r.Body == nil || r.Body == http.NoBody {
		return nil, nil
	}
	b, err := io.ReadAll(r.Body)
	_ = r.Body.Close()
	if err != nil {
		return nil, fmt.Errorf("read the body to sign it: %w", err)
	}
	SetBody(r, b)
	return b, nil
}

// SetBody makes b r's (replayable) body.
func SetBody(r *http.Request, b []byte) {
	r.Body = io.NopCloser(bytes.NewReader(b))
	r.ContentLength = int64(len(b))
	r.GetBody = func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(b)), nil }
}

func applyAWS(r *http.Request, w *model.AWSV4) error {
	if w == nil {
		return ErrNoSettings
	}
	if r.Header.Get("Authorization") != "" {
		return nil
	}
	hash := awsv4.UnsignedPayload
	if !w.UnsignedPayload {
		body, err := readBody(r)
		if err != nil {
			return err
		}
		hash = awsv4.HashPayload(body)
	}
	return awsv4.Sign(r, awsv4.Credentials{AccessKey: strings.TrimSpace(w.AccessKey), SecretKey: w.SecretKey, SessionToken: w.SessionToken},
		awsv4.Options{Region: strings.TrimSpace(w.Region), Service: strings.TrimSpace(w.Service), Time: Now(), PayloadHash: hash})
}

func applyHawk(r *http.Request, h *model.Hawk) error {
	if h == nil {
		return ErrNoSettings
	}
	if r.Header.Get("Authorization") != "" {
		return nil
	}
	var hash string
	if h.PayloadHash {
		body, err := readBody(r)
		if err != nil {
			return err
		}
		if hash, err = hawk.PayloadHash(h.Algorithm, r.Header.Get("Content-Type"), body); err != nil {
			return err
		}
	}
	v, err := hawk.Header(hawk.Credentials{ID: strings.TrimSpace(h.ID), Key: h.Key, Algorithm: h.Algorithm},
		hawk.Options{Method: r.Method, URL: r.URL, Host: r.Host, Time: Now(), Ext: h.Ext, App: h.App, Dlg: h.Dlg, Hash: hash})
	if err != nil {
		return err
	}
	r.Header.Set("Authorization", v)
	return nil
}

func applyJWT(r *http.Request, j *model.JWT) error {
	if j == nil {
		return ErrNoSettings
	}
	tok, err := JWTToken(*j, Now())
	if err != nil {
		return err
	}
	return Apply(r, JWTAuth(*j, tok))
}

// JWTAuth returns the auth that sends a JWT the way j places it: a bearer
// header with j's prefix (default Bearer) or a query parameter (default
// token).
func JWTAuth(j model.JWT, token string) model.Auth {
	if j.Placement == model.PlaceQuery {
		name := strings.TrimSpace(j.QueryParam)
		if name == "" {
			name = DefaultJWTParam
		}
		return model.Auth{Type: model.AuthAPIKey, APIKey: name, APIValue: token, APIIn: model.APIKeyInQuery}
	}
	prefix := strings.TrimSpace(j.HeaderPrefix)
	if prefix == "" {
		prefix = DefaultJWTPrefix
	}
	return model.Auth{Type: model.AuthBearer, Token: token, Prefix: prefix}
}

// JWTAlgorithm is j's algorithm (HS256 when unset).
func JWTAlgorithm(j model.JWT) jwtx.Algorithm {
	if a := strings.TrimSpace(j.Algorithm); a != "" {
		return jwtx.Algorithm(a)
	}
	return jwtx.HS256
}

// JWTToken signs j's header and payload (both resolved) at now: iat (unless
// disabled), exp (now plus the lifetime, when set) and jti (when asked) are added unless
// the payload sets them itself.
func JWTToken(j model.JWT, now time.Time) (string, error) {
	alg := JWTAlgorithm(j)
	if alg.Family() == "" {
		return "", fmt.Errorf("the JWT algorithm %q isn't supported", j.Algorithm)
	}
	if strings.TrimSpace(j.Secret) == "" {
		return "", ErrJWTKey
	}
	var key jwtx.Key
	if alg.Family() == jwtx.FamilyHMAC {
		k, err := jwtx.SecretKey(j.Secret, j.SecretBase64)
		if err != nil {
			return "", fmt.Errorf("the JWT secret: %w", err)
		}
		key = k
	} else {
		key = jwtx.Key{Kind: jwtx.KeyPEM, Data: []byte(NormalizePEM(j.Secret))}
	}
	claims, err := jwtx.Object([]byte(j.Payload))
	if err != nil {
		return "", fmt.Errorf("the JWT payload isn't a JSON object")
	}
	iat := now.Unix()
	if _, ok := claims["iat"]; !ok && !j.DisableIssuedAt {
		claims["iat"] = json.Number(strconv.FormatInt(iat, 10))
	}
	if _, ok := claims["exp"]; !ok && j.LifetimeSeconds > 0 {
		claims["exp"] = json.Number(strconv.FormatInt(iat+int64(j.LifetimeSeconds), 10))
	}
	if _, ok := claims["jti"]; !ok && j.AddJTI {
		b := make([]byte, 16)
		if _, err := io.ReadFull(Random, b); err != nil {
			return "", fmt.Errorf("make a JWT id: %w", err)
		}
		claims["jti"] = base64.RawURLEncoding.EncodeToString(b)
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	tok, err := jwtx.Sign(alg, []byte(j.Header), payload, key)
	if errors.Is(err, jwtx.ErrJSON) {
		return "", errors.New("the JWT header isn't a JSON object")
	}
	return tok, err
}

var pemRe = regexp.MustCompile(`(-----BEGIN [A-Z0-9 ]+-----)\s*(.*?)\s*(-----END [A-Z0-9 ]+-----)`)

// NormalizePEM puts back the line breaks of a PEM block pasted into a
// single-line field (where they were dropped or written as \n).
func NormalizePEM(s string) string {
	s = strings.TrimSpace(strings.ReplaceAll(s, `\n`, "\n"))
	if strings.Contains(s, "\n") {
		return s
	}
	return pemRe.ReplaceAllStringFunc(s, func(block string) string {
		m := pemRe.FindStringSubmatch(block)
		return m[1] + "\n" + strings.Join(strings.Fields(m[2]), "") + "\n" + m[3]
	})
}
