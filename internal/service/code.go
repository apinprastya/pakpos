package service

import (
	"errors"

	"pakpos/internal/core/codegen"
	"pakpos/internal/core/curl"
	"pakpos/internal/core/model"
	"pakpos/internal/pipeline"
)

// CurlImport is a request read from a curl command, with what didn't
// import as curl would send it.
type CurlImport struct {
	Request model.Request `json:"request"`
	// Warnings is never nil.
	Warnings []curl.Warning `json:"warnings"`
}

// ImportCurl reads a curl command (bash, cmd or PowerShell) into a request.
// The request has no id; its name is suggested from the method and path
// ("POST /v2/orders"). A command that can't be read returns an
// error with a message for the user.
func (s *RequestService) ImportCurl(text string) (CurlImport, error) {
	req, warnings, err := curl.Parse(text)
	if err != nil {
		return CurlImport{}, errors.New(curl.Message(err))
	}
	if warnings == nil {
		warnings = []curl.Warning{}
	}
	req.Name = curl.SuggestName(req)
	return CurlImport{Request: req, Warnings: warnings}, nil
}

// CodeOptions controls GenerateCode (see pipeline.CodeOptions).
type CodeOptions = pipeline.CodeOptions

// CodeResult is generated code and what the user should know about it.
// Slices are never nil.
type CodeResult struct {
	Code string `json:"code"`
	// Unresolved lists {{names}} with no value; they are in the code as written.
	Unresolved []string `json:"unresolved"`
	// Masked lists secret variables left as {{name}} (secrets not revealed).
	Masked []string `json:"masked"`
	// SecretsLocked is true when a secret the request uses couldn't be read
	// because the secret store is locked.
	SecretsLocked bool `json:"secretsLocked"`
	// Warnings explain what the code leaves out or does differently.
	Warnings    []string         `json:"warnings"`
	Environment *pipeline.EnvRef `json:"environment"`
}

// CodeLanguages lists the languages GenerateCode supports, in display order.
func (s *RequestService) CodeLanguages() []codegen.Language { return codegen.Languages() }

// GenerateCode writes req as code in language (an id from CodeLanguages).
// It inherits like Send (parentID is the collection or folder of an unsaved
// draft) and uses the selected environment. Variables are resolved when
// opts.ResolveVariables; secrets stay {{name}} unless opts.RevealSecrets.
// Copy as cURL is this call with language "curl". Secret values are never
// logged or stored.
func (s *RequestService) GenerateCode(req model.Request, parentID, language string, opts CodeOptions) (CodeResult, error) {
	var (
		p   pipeline.PreparedCode
		err error
	)
	if ws, werr := s.c.workspace(); werr == nil {
		p, err = s.c.session(ws).PrepareCode(req, parentID, s.c.selectedEnvironment(ws.Manifest().ID), opts)
	} else {
		p, err = pipeline.PrepareCodeWithoutWorkspace(req, opts)
	}
	if err != nil {
		return CodeResult{}, errors.New(pipeline.VariableMessage(err))
	}
	gen, err := codegen.Generate(language, p.Request)
	if err != nil {
		return CodeResult{}, err
	}
	return CodeResult{
		Code: gen.Code, Unresolved: p.Unresolved, Masked: p.Masked, SecretsLocked: p.SecretsLocked,
		Warnings: gen.Warnings, Environment: p.Environment,
	}, nil
}
