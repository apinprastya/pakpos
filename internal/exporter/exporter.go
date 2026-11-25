// Package exporter reads collections, environments and the globals from a
// workspace and writes them as Postman exports (core/postman.Export). It
// reads workspace files only: secret values stay in the secret store and
// are never exported. It has no Wails code.
package exporter

import (
	"fmt"
	"strings"

	"pakpos/internal/core/postman"
	"pakpos/internal/store/fsstore"
)

// Export is a finished export: the file's bytes, a suggested file name and
// what won't work in Postman as it does in Pakpos.
type Export struct {
	Name     string
	FileName string
	Data     []byte
	Warnings []postman.Warning
}

// Collection exports a collection with its folders, requests and examples.
func Collection(ws *fsstore.Workspace, id string) (Export, error) {
	col, err := ws.GetCollection(id)
	if err != nil {
		return Export{}, fmt.Errorf("export collection: %w", err)
	}
	var node *fsstore.Node
	for _, n := range ws.Tree().Collections {
		if n.ID == id {
			node = &n
			break
		}
	}
	if node == nil {
		return Export{}, fmt.Errorf("export collection %s: %w", id, fsstore.ErrNotFound)
	}
	items, err := readItems(ws, node.Children)
	if err != nil {
		return Export{}, fmt.Errorf("export collection %q: %w", col.Name, err)
	}
	f := postman.File{Kind: postman.KindCollection, Name: col.Name, Collection: &postman.Collection{
		Auth: col.Auth, Headers: col.Headers, Variables: col.Variables, Scripts: col.Scripts, Items: items,
	}}
	return write(f, fileName(col.Name, "collection")+".postman_collection.json")
}

// Environment exports an environment's variables.
func Environment(ws *fsstore.Workspace, id string) (Export, error) {
	env, err := ws.GetEnvironment(id)
	if err != nil {
		return Export{}, fmt.Errorf("export environment: %w", err)
	}
	f := postman.File{Kind: postman.KindEnvironment, Name: env.Name, Variables: env.Variables}
	return write(f, fileName(env.Name, "environment")+".postman_environment.json")
}

// Globals exports the workspace's globals.
func Globals(ws *fsstore.Workspace) (Export, error) {
	f := postman.File{Kind: postman.KindGlobals, Name: "Globals", Variables: ws.GetGlobals().Variables}
	return write(f, "workspace.postman_globals.json")
}

func write(f postman.File, fileName string) (Export, error) {
	data, warnings, err := postman.Export(f)
	if err != nil {
		return Export{}, err
	}
	return Export{Name: f.Name, FileName: fileName, Data: data, Warnings: warnings}, nil
}

func readItems(ws *fsstore.Workspace, nodes []fsstore.Node) ([]postman.Item, error) {
	out := make([]postman.Item, 0, len(nodes))
	for _, n := range nodes {
		switch n.Kind {
		case fsstore.NodeFolder:
			f, err := ws.GetFolder(n.ID)
			if err != nil {
				return nil, err
			}
			children, err := readItems(ws, n.Children)
			if err != nil {
				return nil, err
			}
			out = append(out, postman.Item{Folder: &postman.Folder{
				Name: f.Name, Auth: f.Auth, Headers: f.Headers, Scripts: f.Scripts, Items: children,
			}})
		case fsstore.NodeRequest:
			r, err := readRequest(ws, n.ID)
			if err != nil {
				return nil, err
			}
			out = append(out, postman.Item{Request: r})
		}
	}
	return out, nil
}

func readRequest(ws *fsstore.Workspace, id string) (*postman.Request, error) {
	req, err := ws.GetRequest(id)
	if err != nil {
		return nil, err
	}
	out := &postman.Request{Request: req}
	list, err := ws.ListExamples(id)
	if err != nil {
		return nil, err
	}
	for _, s := range list {
		ex, err := ws.GetExample(id, s.ID)
		if err != nil {
			return nil, err
		}
		out.Examples = append(out.Examples, example(ex))
	}
	return out, nil
}

func example(ex fsstore.Example) postman.Example {
	r := ex.Response
	return postman.Example{
		Name: ex.Name, Request: ex.Request, StatusCode: r.StatusCode, StatusText: r.StatusText,
		Headers: r.Headers, ContentType: r.ContentType, Kind: r.Kind, Body: r.Body, Encoding: r.Encoding,
	}
}

// fileName makes name safe as a file name on every OS: characters Windows
// refuses are dropped and runs of spaces become one dash.
func fileName(name, fallback string) string {
	out := strings.Map(func(r rune) rune {
		if strings.ContainsRune(`/\:*?"<>|`, r) || r < 32 {
			return -1
		}
		return r
	}, name)
	out = strings.Trim(strings.Join(strings.Fields(out), "-"), ".")
	if out == "" {
		return fallback
	}
	return out
}
