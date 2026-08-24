package main

import (
	"mime"
	"os"
	"path/filepath"
	"strings"
	"unicode"
)

func normalizeMediaName(name, fallback string) string {
	clean := normalizeMediaBasename(name)
	if clean != "" && clean != "." && clean != ".." {
		return clean
	}
	clean = normalizeMediaBasename(fallback)
	if clean != "" && clean != "." && clean != ".." {
		return clean
	}
	return "media"
}

func normalizeMediaBasename(name string) string {
	name = strings.ReplaceAll(name, "\\", "/")
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, name)
	name = filepath.Base(name)
	if name == "." || name == string(filepath.Separator) {
		return ""
	}
	if strings.TrimSpace(name) == "" {
		return ""
	}
	return name
}

func safeMediaContentDisposition(name string) string {
	value := mime.FormatMediaType("inline", map[string]string{
		"filename": normalizeMediaName(name, "media"),
	})
	if value == "" {
		return "inline"
	}
	return value
}

func configuredExportRoot() string {
	if root := os.Getenv("EXPORT_ROOT"); root != "" {
		return root
	}
	mediaRoot := os.Getenv("MEDIA_ROOT")
	if mediaRoot == "" {
		mediaRoot = os.TempDir()
	}
	return filepath.Join(mediaRoot, "exports")
}

func pathWithinResolvedRoot(root, target string) (bool, error) {
	if strings.TrimSpace(root) == "" || strings.TrimSpace(target) == "" {
		return false, nil
	}
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return false, err
	}
	targetAbs, err := filepath.Abs(target)
	if err != nil {
		return false, err
	}
	if !strictPathWithin(rootAbs, targetAbs) {
		return false, nil
	}
	resolvedRoot, err := filepath.EvalSymlinks(rootAbs)
	if err != nil {
		return false, err
	}
	resolvedTarget, err := filepath.EvalSymlinks(targetAbs)
	if err != nil {
		return false, err
	}
	return strictPathWithin(resolvedRoot, resolvedTarget), nil
}

func strictPathWithin(root, target string) bool {
	relative, err := filepath.Rel(filepath.Clean(root), filepath.Clean(target))
	if err != nil || relative == "." || relative == ".." || filepath.IsAbs(relative) {
		return false
	}
	return !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}
