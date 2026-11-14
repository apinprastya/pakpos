package pipeline

import (
	"sort"

	"pakpos/internal/core/inherit"
	"pakpos/internal/core/model"
	"pakpos/internal/core/vars"
)

// CodeOptions controls how a request is prepared for code generation and
// Copy as cURL.
type CodeOptions struct {
	// ResolveVariables replaces {{variables}} with their values. When false
	// the request is used as written: inheritance (auth and headers) is
	// still applied, but every {{reference}} stays as it is.
	ResolveVariables bool `json:"resolveVariables"`
	// RevealSecrets puts secret values in the code. When false (the
	// default) references to secret variables stay {{name}}. It has no
	// effect when ResolveVariables is false.
	RevealSecrets bool `json:"revealSecrets"`
}

// PreparedCode is a request prepared for code generation.
type PreparedCode struct {
	Prepared
	// Masked lists the secret variables left as {{name}} because secrets
	// weren't revealed, sorted. Never nil.
	Masked []string
}

// PrepareCode is Prepare for showing a request as code: the chain and
// inheritance are applied the same way, then variables are resolved or not
// as opts says. Secrets are kept as {{name}} unless opts.RevealSecrets; an
// unset secret stays unresolved either way (it still shadows lower scopes).
// The returned request may hold secret values only when they were revealed.
func (s *Session) PrepareCode(req model.Request, parentID, envID string, opts CodeOptions) (PreparedCode, error) {
	chain := s.Chain(req, parentID)
	env := s.Environment(envID)
	eff := inherit.Effective(chain, req)
	var (
		p   PreparedCode
		err error
	)
	if opts.ResolveVariables {
		p, err = prepareCode(eff, s.BuildScopes(collectionOf(chain), env), opts.RevealSecrets, s.opts)
	} else {
		p = asWritten(eff)
	}
	if env != nil {
		p.Environment = &EnvRef{ID: env.ID, Name: env.Name}
	}
	return p, err
}

// PrepareCodeWithoutWorkspace is PrepareCode with no workspace open: nothing
// is inherited and only dynamic variables resolve.
func PrepareCodeWithoutWorkspace(req model.Request, opts CodeOptions, vopts ...vars.Option) (PreparedCode, error) {
	eff := inherit.Effective(nil, req)
	if !opts.ResolveVariables {
		return asWritten(eff), nil
	}
	return prepareCode(eff, Scopes{Locked: map[string]bool{}}, opts.RevealSecrets, vopts)
}

func asWritten(eff inherit.Result) PreparedCode {
	return PreparedCode{Prepared: Prepared{Effective: eff, Request: eff.Request, Unresolved: []string{}}, Masked: []string{}}
}

func prepareCode(eff inherit.Result, scopes Scopes, reveal bool, opts []vars.Option) (PreparedCode, error) {
	masked := map[string]bool{}
	o := append([]vars.Option{}, opts...)
	if !reveal {
		o = append(o, vars.KeepSecrets(func(name string) { masked[name] = true }))
	}
	p, err := prepare(eff, scopes, o)
	out := PreparedCode{Prepared: p, Masked: make([]string, 0, len(masked))}
	for n := range masked {
		out.Masked = append(out.Masked, n)
	}
	sort.Strings(out.Masked)
	return out, err
}
