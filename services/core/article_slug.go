package main

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

// articleSlugBase returns a stable, non-empty slug seed.  An empty title uses
// the entry ID so legacy/title-less articles never depend on a changing
// display value.
func articleSlugBase(desired, title, id string) string {
	source := strings.TrimSpace(desired)
	if source == "" {
		source = strings.TrimSpace(title)
	}
	base := slugify(source)
	if base != "" {
		return base
	}
	idPart := slugify(id)
	if idPart == "" {
		idPart = "entry"
	}
	return "article-" + idPart
}

func uniqueArticleSlug(base, id string, taken func(string) (bool, error)) (string, error) {
	used, err := taken(base)
	if err != nil {
		return "", err
	}
	if !used {
		return base, nil
	}
	suffix := slugify(id)
	if suffix == "" {
		suffix = "entry"
	}
	candidate := base + "-" + suffix
	used, err = taken(candidate)
	if err != nil {
		return "", err
	}
	if !used {
		return candidate, nil
	}
	for n := 2; ; n++ {
		candidate = fmt.Sprintf("%s-%s-%d", base, suffix, n)
		used, err = taken(candidate)
		if err != nil {
			return "", err
		}
		if !used {
			return candidate, nil
		}
	}
}

func uniqueMemoryArticleSlug(entries map[string]*Entry, desired, title, id string) string {
	base := articleSlugBase(desired, title, id)
	result, _ := uniqueArticleSlug(base, id, func(candidate string) (bool, error) {
		for key, entry := range entries {
			if entry == nil || entry.Kind != "article" || entry.Status == "trashed" {
				continue
			}
			entryID := entry.ID
			if entryID == "" {
				entryID = key
			}
			if entryID == id {
				continue
			}
			if strings.EqualFold(strings.TrimSpace(entry.Slug), candidate) {
				return true, nil
			}
		}
		return false, nil
	})
	return result
}

func uniqueDatabaseArticleSlug(ctx context.Context, tx *sql.Tx, desired, title, id string) (string, error) {
	base := articleSlugBase(desired, title, id)
	// Serialize concurrent writers choosing the same base.  The candidate
	// suffix is ID-derived, so an explicit conflicting slug remains stable.
	if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtext(lower($1)))`, base); err != nil {
		return "", err
	}
	return uniqueArticleSlug(base, id, func(candidate string) (bool, error) {
		var exists bool
		err := tx.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM entries WHERE kind='article' AND status <> 'trashed' AND lower(COALESCE(slug,''))=lower($1) AND id<>$2::uuid)`, candidate, id).Scan(&exists)
		return exists, err
	})
}
