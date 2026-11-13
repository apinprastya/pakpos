// Package sqlite stores app-local data (history, settings, recent workspaces)
// in an SQLite database using the pure-Go modernc driver. It has no Wails
// dependency.
package sqlite

import (
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite" // registers the "sqlite" driver
)

// DBFile is the database file name inside the data dir.
const DBFile = "pakpos.db"

// BodiesDir holds response bodies that are too large to keep in the database.
const BodiesDir = "bodies"

// ErrNotFound is returned when a row does not exist.
var ErrNotFound = errors.New("not found")

//go:embed migrations/*.sql
var migrationFS embed.FS

// Store is the app database. It is safe for concurrent use.
type Store struct {
	db        *sql.DB
	dataDir   string
	bodiesDir string
	now       func() time.Time
}

// Open opens (creating if needed) the database in dataDir and applies migrations.
func Open(dataDir string) (*Store, error) {
	bodies := filepath.Join(dataDir, BodiesDir)
	if err := os.MkdirAll(bodies, 0o700); err != nil {
		return nil, fmt.Errorf("create data dir: %w", err)
	}
	dsn := "file:" + filepath.ToSlash(filepath.Join(dataDir, DBFile)) +
		"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	s := &Store{db: db, dataDir: dataDir, bodiesDir: bodies, now: time.Now}
	if err := s.migrate(migrationFS); err != nil {
		_ = db.Close()
		return nil, err
	}
	return s, nil
}

// Close closes the database.
func (s *Store) Close() error { return s.db.Close() }

// DataDir is the directory holding the database.
func (s *Store) DataDir() string { return s.dataDir }

type migration struct {
	version int
	name    string
}

// migrate applies migrations/NNNN_name.sql files newer than schema_version,
// each in its own transaction.
func (s *Store) migrate(fsys fs.FS) error {
	if _, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`); err != nil {
		return fmt.Errorf("create schema_version: %w", err)
	}
	var current int
	if err := s.db.QueryRow(`SELECT COALESCE(MAX(version), 0) FROM schema_version`).Scan(&current); err != nil {
		return fmt.Errorf("read schema_version: %w", err)
	}
	migs, err := listMigrations(fsys)
	if err != nil {
		return err
	}
	for _, m := range migs {
		if m.version <= current {
			continue
		}
		sqlText, err := fs.ReadFile(fsys, "migrations/"+m.name)
		if err != nil {
			return fmt.Errorf("read migration %s: %w", m.name, err)
		}
		if err := s.applyMigration(m, string(sqlText)); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) applyMigration(m migration, sqlText string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(sqlText); err != nil {
		return fmt.Errorf("apply migration %s: %w", m.name, err)
	}
	if _, err := tx.Exec(`INSERT INTO schema_version (version) VALUES (?)`, m.version); err != nil {
		return fmt.Errorf("record migration %s: %w", m.name, err)
	}
	return tx.Commit()
}

func listMigrations(fsys fs.FS) ([]migration, error) {
	entries, err := fs.ReadDir(fsys, "migrations")
	if err != nil {
		return nil, fmt.Errorf("list migrations: %w", err)
	}
	var out []migration
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".sql") {
			continue
		}
		prefix, _, _ := strings.Cut(name, "_")
		v, err := strconv.Atoi(prefix)
		if err != nil || v <= 0 {
			return nil, fmt.Errorf("migration %s: name must start with a positive number", name)
		}
		out = append(out, migration{version: v, name: name})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].version < out[j].version })
	return out, nil
}

// SchemaVersion returns the newest applied migration.
func (s *Store) SchemaVersion() (int, error) {
	var v int
	err := s.db.QueryRow(`SELECT COALESCE(MAX(version), 0) FROM schema_version`).Scan(&v)
	return v, err
}
