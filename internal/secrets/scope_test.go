package secrets

import (
	"errors"
	"reflect"
	"testing"

	"pakpos/internal/core/model"
)

func vr(k, v string, secret bool) model.Variable {
	return model.Variable{Key: k, Value: v, Enabled: true, Secret: secret}
}

func TestSecretKeysAndRemoved(t *testing.T) {
	before := []model.Variable{vr("a", "", true), vr("b", "", true), vr("c", "1", false), vr("a", "", true), vr("", "", true),
		{Key: "off", Secret: true}}
	if got := SecretKeys(before); !reflect.DeepEqual(got, []string{"a", "b", "off"}) {
		t.Fatalf("SecretKeys = %v", got)
	}
	tests := []struct {
		name  string
		after []model.Variable
		want  []string
	}{
		{"unchanged", before, nil},
		{"removed", []model.Variable{vr("a", "", true), {Key: "off", Secret: true}}, []string{"b"}},
		{"renamed", []model.Variable{vr("a2", "", true), vr("b", "", true), {Key: "off", Secret: true}}, []string{"a"}},
		{"made plain", []model.Variable{vr("a", "x", false), vr("b", "", true), {Key: "off", Secret: true}}, []string{"a"}},
		{"all gone", nil, []string{"a", "b", "off"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := RemovedSecrets(before, tt.after); !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("got %v, want %v", got, tt.want)
			}
		})
	}
}

func TestDeleteAndCopyKeys(t *testing.T) {
	f := NewFake()
	_ = f.Set(Key("W", "E1", "a"), "1")
	_ = f.Set(Key("W", "E1", "b"), "2")
	if err := CopyKeys(f, "W", "E1", "E2", []string{"a", "b", "missing"}); err != nil {
		t.Fatal(err)
	}
	if got, _ := f.Get(Key("W", "E2", "b")); got != "2" {
		t.Fatalf("copied = %q", got)
	}
	if err := DeleteKeys(f, "W", "E1", []string{"a", "b", "missing"}); err != nil {
		t.Fatal(err)
	}
	want := []string{Key("W", "E2", "a"), Key("W", "E2", "b")}
	if got := f.Keys(); !reflect.DeepEqual(got, want) {
		t.Fatalf("keys = %v", got)
	}
	f.Err = errors.New("boom")
	if err := DeleteKeys(f, "W", "E2", []string{"a", "b"}); err == nil {
		t.Fatal("expected delete error")
	}
	if err := CopyKeys(f, "W", "E2", "E3", []string{"a"}); err == nil {
		t.Fatal("expected copy error")
	}
}

func TestFill(t *testing.T) {
	f := NewFake()
	_ = f.Set(Key("W", "S", "tok"), "T")
	in := []model.Variable{vr("plain", "p", false), vr("tok", "", true), vr("unset", "", true), {Key: "off", Secret: true}}
	out, missing, locked, err := Fill(f, "W", "S", in)
	if err != nil || len(locked) != 0 || !reflect.DeepEqual(missing, []string{"unset"}) {
		t.Fatalf("missing=%v locked=%v err=%v", missing, locked, err)
	}
	want := []model.Variable{vr("plain", "p", false), vr("tok", "T", true), {Key: "off", Secret: true}}
	if !reflect.DeepEqual(out, want) {
		t.Fatalf("out = %+v", out)
	}
	if in[1].Value != "" {
		t.Fatal("input modified")
	}

	f.Err = ErrLocked
	out, missing, locked, err = Fill(f, "W", "S", in)
	if err != nil || !reflect.DeepEqual(locked, []string{"tok", "unset"}) || !reflect.DeepEqual(missing, locked) || len(out) != 2 {
		t.Fatalf("locked: out=%+v locked=%v err=%v", out, locked, err)
	}
	f.Err = ErrNoPassword
	if out, missing, locked, err = Fill(f, "W", "S", in); err != nil || len(locked) != 0 || len(missing) != 2 || len(out) != 2 {
		t.Fatalf("no password: out=%+v locked=%v err=%v", out, locked, err)
	}
	f.Err = errors.New("boom")
	if out, missing, _, err = Fill(f, "W", "S", in); err == nil || len(out) != 2 || len(missing) != 2 {
		t.Fatalf("store error: out=%+v err=%v", out, err)
	}
}

func TestStatusAndPasswordControl(t *testing.T) {
	if st := StatusOf(NewFake()); st != (Status{Backend: BackendKeychain}) {
		t.Fatalf("keychain status = %+v", st)
	}
	if _, err := AsPasswordStore(NewFake()); !errors.Is(err, ErrNotPasswordStore) {
		t.Fatalf("AsPasswordStore(fake) = %v", err)
	}
	fs := NewFileStore(t.TempDir(), WithKDFParams(KDFParams{Time: 1, Memory: 64, Threads: 1}))
	if st := StatusOf(fs); st != (Status{Backend: BackendFile, Locked: true}) {
		t.Fatalf("new file status = %+v", st)
	}
	p, err := AsPasswordStore(fs)
	if err != nil {
		t.Fatal(err)
	}
	if err := p.SetPassword("one"); err != nil {
		t.Fatal(err)
	}
	_ = p.Set("k", "v")
	if st := StatusOf(fs); st != (Status{Backend: BackendFile, HasPassword: true}) {
		t.Fatalf("unlocked status = %+v", st)
	}
	if err := ChangePassword(p, "wrong", "two"); !errors.Is(err, ErrWrongPassword) {
		t.Fatalf("change with wrong password: %v", err)
	}
	if err := ChangePassword(p, "one", ""); !errors.Is(err, ErrEmptyPassword) {
		t.Fatalf("change to empty: %v", err)
	}
	if err := ChangePassword(p, "one", "two"); err != nil {
		t.Fatal(err)
	}
	p.Lock()
	if err := p.Unlock("two"); err != nil {
		t.Fatal(err)
	}
	if v, _ := p.Get("k"); v != "v" {
		t.Fatalf("value after change = %q", v)
	}
}

func TestExplain(t *testing.T) {
	if Explain(nil) != nil {
		t.Fatal("nil")
	}
	other := errors.New("environment not found")
	if Explain(other) != other {
		t.Fatal("other errors pass through")
	}
	tests := map[error]string{
		ErrWrongPassword:    MsgWrongPassword,
		ErrLocked:           MsgLocked,
		ErrNoPassword:       MsgNoPassword,
		ErrEmptyPassword:    MsgEmptyPassword,
		ErrCorrupt:          MsgCorrupt,
		ErrUnavailable:      MsgUnavailable,
		ErrNotPasswordStore: MsgNotFileStore,
	}
	for sentinel, msg := range tests {
		err := Explain(errors.Join(sentinel))
		if err.Error() != msg || !errors.Is(err, sentinel) {
			t.Errorf("%v -> %q", sentinel, err)
		}
		if again := Explain(err); again != err {
			t.Errorf("explaining twice changed %q", again)
		}
	}
	if MsgWrongPassword != "Wrong password, or the secrets file is damaged." {
		t.Fatal("wrong-password copy was decided by the user; keep it")
	}
}
