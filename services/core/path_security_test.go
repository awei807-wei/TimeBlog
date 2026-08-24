package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPathWithinResolvedRoot(t *testing.T) {
	root := t.TempDir()
	inside := filepath.Join(root, "nested", "export.zip")
	if err := os.MkdirAll(filepath.Dir(inside), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(inside, []byte("zip"), 0600); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "outside.zip")
	if err := os.WriteFile(outside, []byte("outside"), 0600); err != nil {
		t.Fatal(err)
	}

	ok, err := pathWithinResolvedRoot(root, inside)
	if err != nil || !ok {
		t.Fatalf("root-contained export rejected: ok=%v err=%v", ok, err)
	}
	ok, err = pathWithinResolvedRoot(root, outside)
	if err != nil || ok {
		t.Fatalf("root-external export accepted: ok=%v err=%v", ok, err)
	}

	symlink := filepath.Join(root, "link.zip")
	if err := os.Symlink(outside, symlink); err != nil {
		t.Skipf("symlink unsupported: %v", err)
	}
	ok, err = pathWithinResolvedRoot(root, symlink)
	if err != nil || ok {
		t.Fatalf("symlink escaping export root accepted: ok=%v err=%v", ok, err)
	}
}

func TestConfiguredExportRootMatchesWorkerDefault(t *testing.T) {
	t.Setenv("EXPORT_ROOT", "")
	t.Setenv("MEDIA_ROOT", "")
	want := filepath.Join(os.TempDir(), "exports")
	if got := configuredExportRoot(); got != want {
		t.Fatalf("default export root=%q want=%q", got, want)
	}
	t.Setenv("MEDIA_ROOT", filepath.Join(t.TempDir(), "media"))
	if got, want := configuredExportRoot(), filepath.Join(os.Getenv("MEDIA_ROOT"), "exports"); got != want {
		t.Fatalf("MEDIA_ROOT-derived export root=%q want=%q", got, want)
	}
}
