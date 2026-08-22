package main

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"sort"
	"strings"
	"unicode/utf8"
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
		statements, err := splitMigrationStatements(string(contents))
		if err != nil {
			return fmt.Errorf("migration %s: %w", version, err)
		}
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		for _, statement := range statements {
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

// splitMigrationStatements separates PostgreSQL statements without treating
// semicolons inside comments or quoted values as statement boundaries. The
// database/sql pgx driver uses PostgreSQL's extended protocol by default, so
// executing an entire multi-statement migration as one prepared query is not
// portable. Keeping the splitter here preserves one transaction per migration
// while accepting the SQL constructs used by migrations, including dollar
// quoted function bodies.
func splitMigrationStatements(sqlText string) ([]string, error) {
	const (
		migrationNormal = iota
		migrationSingleQuote
		migrationDoubleQuote
		migrationLineComment
		migrationBlockComment
		migrationDollarQuote
	)
	state := migrationNormal
	blockDepth := 0
	dollarTag := ""
	singleBackslashEscapes := false
	start := 0
	statements := make([]string, 0)

	appendStatement := func(end int) {
		if statement := strings.TrimSpace(sqlText[start:end]); statement != "" {
			statements = append(statements, statement)
		}
	}

	for i := 0; i < len(sqlText); {
		switch state {
		case migrationNormal:
			switch sqlText[i] {
			case '\'':
				singleBackslashEscapes = i > 0 && (sqlText[i-1] == 'e' || sqlText[i-1] == 'E')
				state = migrationSingleQuote
				i++
			case '"':
				state = migrationDoubleQuote
				i++
			case '-':
				if i+1 < len(sqlText) && sqlText[i+1] == '-' {
					state = migrationLineComment
					i += 2
				} else {
					i++
				}
			case '/':
				if i+1 < len(sqlText) && sqlText[i+1] == '*' {
					state = migrationBlockComment
					blockDepth = 1
					i += 2
				} else {
					i++
				}
			case '$':
				if tag, ok := migrationDollarQuoteTag(sqlText, i); ok {
					state = migrationDollarQuote
					dollarTag = tag
					i += len(tag)
				} else {
					i++
				}
			case ';':
				appendStatement(i)
				i++
				start = i
			default:
				i++
			}
		case migrationSingleQuote:
			if sqlText[i] == '\\' && singleBackslashEscapes {
				if i+1 < len(sqlText) {
					i += 2
				} else {
					i++
				}
			} else if sqlText[i] == '\'' {
				if i+1 < len(sqlText) && sqlText[i+1] == '\'' {
					i += 2
				} else {
					state = migrationNormal
					i++
				}
			} else {
				i++
			}
		case migrationDoubleQuote:
			if sqlText[i] == '"' {
				if i+1 < len(sqlText) && sqlText[i+1] == '"' {
					i += 2
				} else {
					state = migrationNormal
					i++
				}
			} else {
				i++
			}
		case migrationLineComment:
			if sqlText[i] == '\n' || sqlText[i] == '\r' {
				state = migrationNormal
			}
			i++
		case migrationBlockComment:
			if i+1 < len(sqlText) && sqlText[i] == '/' && sqlText[i+1] == '*' {
				blockDepth++
				i += 2
			} else if i+1 < len(sqlText) && sqlText[i] == '*' && sqlText[i+1] == '/' {
				blockDepth--
				i += 2
				if blockDepth == 0 {
					state = migrationNormal
				}
			} else {
				i++
			}
		case migrationDollarQuote:
			if strings.HasPrefix(sqlText[i:], dollarTag) {
				i += len(dollarTag)
				state = migrationNormal
			} else {
				i++
			}
		}
	}

	switch state {
	case migrationSingleQuote:
		return nil, fmt.Errorf("unterminated single-quoted string")
	case migrationDoubleQuote:
		return nil, fmt.Errorf("unterminated double-quoted identifier")
	case migrationLineComment:
		// A line comment naturally terminates at EOF.
	case migrationBlockComment:
		return nil, fmt.Errorf("unterminated block comment")
	case migrationDollarQuote:
		return nil, fmt.Errorf("unterminated dollar-quoted string %s", dollarTag)
	}
	appendStatement(len(sqlText))
	return statements, nil
}

func migrationDollarQuoteTag(sqlText string, offset int) (string, bool) {
	if offset < 0 || offset+2 > len(sqlText) || sqlText[offset] != '$' {
		return "", false
	}
	if offset > 0 {
		previous, _ := utf8.DecodeLastRuneInString(sqlText[:offset])
		if migrationIdentifierContinue(previous) {
			return "", false
		}
	}
	if sqlText[offset+1] == '$' {
		return "$$", true
	}
	first, size := utf8.DecodeRuneInString(sqlText[offset+1:])
	if !migrationDollarTagStart(first) {
		return "", false
	}
	i := offset + 1 + size
	for i < len(sqlText) {
		char, size := utf8.DecodeRuneInString(sqlText[i:])
		if !migrationDollarTagContinue(char) {
			break
		}
		i += size
	}
	if i >= len(sqlText) || sqlText[i] != '$' {
		return "", false
	}
	return sqlText[offset : i+1], true
}

func migrationDollarTagStart(char rune) bool {
	return migrationIdentifierStart(char)
}

func migrationDollarTagContinue(char rune) bool {
	return migrationIdentifierStart(char) || (char >= '0' && char <= '9')
}

func migrationIdentifierStart(char rune) bool {
	// PostgreSQL's scanner accepts ASCII letters, underscore, and any
	// high-bit UTF-8 character as the start of an unquoted identifier.
	return char == '_' || (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || char >= utf8.RuneSelf
}

func migrationIdentifierContinue(char rune) bool {
	return migrationIdentifierStart(char) || (char >= '0' && char <= '9') || char == '$'
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
