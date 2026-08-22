package main

import (
	"strings"
	"testing"
)

func TestSplitMigrationStatementsKeepsSemicolonsInCommentsAndQuotes(t *testing.T) {
	sqlText := `-- a comment; this is not a statement boundary
CREATE TABLE "semi;identifier" (
    value text NOT NULL DEFAULT 'it''s valid SQL; use doubled quotes: ''ok;'''
);
/* block comment; nested /* comment; */ still in the outer comment */
INSERT INTO "semi;identifier"(value) VALUES ($tag$body; -- still a dollar string
$tag$);
DO $$
BEGIN
    RAISE NOTICE 'function body; still one statement';
END;
$$;`

	statements, err := splitMigrationStatements(sqlText)
	if err != nil {
		t.Fatal(err)
	}
	if len(statements) != 3 {
		t.Fatalf("statement count=%d, statements=%q", len(statements), statements)
	}
	for i, want := range []string{"CREATE TABLE", "INSERT INTO", "DO $$"} {
		if !strings.Contains(statements[i], want) {
			t.Fatalf("statement %d=%q, want %q", i, statements[i], want)
		}
	}
	if !strings.Contains(statements[0], "semi;identifier") || !strings.Contains(statements[0], "ok;") {
		t.Fatalf("quoted semicolons were not preserved: %q", statements[0])
	}
	if !strings.Contains(statements[1], "body; -- still a dollar string") {
		t.Fatalf("dollar-quoted semicolons were not preserved: %q", statements[1])
	}
}

func TestSplitMigrationStatementsRejectsUnterminatedQuotedConstructs(t *testing.T) {
	for name, sqlText := range map[string]string{
		"single quote":         "SELECT 'unterminated;",
		"double quote":         `SELECT "unterminated;`,
		"block comment":        "/* unterminated;",
		"dollar quote":         "SELECT $tag$unterminated;",
		"unicode dollar quote": "SELECT $标签$unterminated;",
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := splitMigrationStatements(sqlText); err == nil {
				t.Fatalf("splitMigrationStatements(%q) unexpectedly succeeded", sqlText)
			}
		})
	}
}

func TestSplitMigrationStatementsHonorsDollarQuoteIdentifierBoundaries(t *testing.T) {
	tests := []struct {
		name       string
		sqlText    string
		wantCount  int
		wantInside string
	}{
		{
			name:      "identifier adjacent delimiter is not a quote",
			sqlText:   "SELECT foo$tag$body;still$tag$;",
			wantCount: 2,
		},
		{
			name:      "keyword adjacent delimiter is not a quote",
			sqlText:   "SELECT$tag$body;still$tag$;",
			wantCount: 2,
		},
		{
			name:       "punctuation adjacent delimiter is a quote",
			sqlText:    "SELECT($tag$body;still$tag$);",
			wantCount:  1,
			wantInside: "body;still",
		},
		{
			name:       "empty tag",
			sqlText:    "SELECT $$body;still$$;",
			wantCount:  1,
			wantInside: "body;still",
		},
		{
			name:       "unicode tag",
			sqlText:    "SELECT $标签2$body;still$标签2$;",
			wantCount:  1,
			wantInside: "body;still",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			statements, err := splitMigrationStatements(test.sqlText)
			if err != nil {
				t.Fatal(err)
			}
			if len(statements) != test.wantCount {
				t.Fatalf("statement count=%d, statements=%q", len(statements), statements)
			}
			if test.wantInside != "" && !strings.Contains(statements[0], test.wantInside) {
				t.Fatalf("statement=%q, want content %q", statements[0], test.wantInside)
			}
		})
	}
}

func TestMigrationFilesCanBeSplitIntoPostgreSQLStatements(t *testing.T) {
	entries, err := migrationFiles.ReadDir("db/migrations")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}
		t.Run(entry.Name(), func(t *testing.T) {
			contents, err := migrationFiles.ReadFile("db/migrations/" + entry.Name())
			if err != nil {
				t.Fatal(err)
			}
			statements, err := splitMigrationStatements(string(contents))
			if err != nil {
				t.Fatal(err)
			}
			if len(statements) == 0 {
				t.Fatal("migration contains no SQL statements")
			}
		})
	}
}
