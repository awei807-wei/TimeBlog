package main

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"sort"
	"strings"
)

//go:embed db/migrations/*.sql
var migrationFiles embed.FS

func applyMigrations(ctx context.Context, db *sql.DB) error {
	if _, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`); err != nil {
		return err
	}
	entries, err := migrationFiles.ReadDir("db/migrations")
	if err != nil {
		return err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}
		version := strings.TrimSuffix(entry.Name(), ".sql")
		var applied bool
		if err := db.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version=$1)`, version).Scan(&applied); err != nil {
			return err
		}
		if applied {
			continue
		}
		contents, err := migrationFiles.ReadFile("db/migrations/" + entry.Name())
		if err != nil {
			return err
		}
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		for _, statement := range strings.Split(string(contents), ";") {
			statement = strings.TrimSpace(statement)
			if statement == "" {
				continue
			}
			if _, err := tx.ExecContext(ctx, statement); err != nil {
				_ = tx.Rollback()
				return fmt.Errorf("migration %s: %w", version, err)
			}
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO schema_migrations(version) VALUES ($1)`, version); err != nil {
			_ = tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

func latestMigrationVersion() string {
	entries, err := migrationFiles.ReadDir("db/migrations")
	if err != nil {
		return ""
	}
	latest := ""
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}
		version := strings.TrimSuffix(entry.Name(), ".sql")
		if version > latest {
			latest = version
		}
	}
	return latest
}
