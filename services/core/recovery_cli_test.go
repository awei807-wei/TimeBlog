package main

import (
	"context"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

type fakeRecoveryKeyRotationStore struct {
	tx         *fakeRecoveryKeyRotationTransaction
	beginErr   error
	active     bool
	activeErr  error
	checkedID  string
	checkedErr error
}

type fakeRecoveryKeyRotationTransaction struct {
	operations    []string
	locked        bool
	lockErr       error
	tableLockErr  error
	invalidateErr error
	insertErr     error
	auditErr      error
	commitErr     error
	commitHook    func()
	rollbackErr   error
	insertedHash  string
	auditedID     string
}

func (s *fakeRecoveryKeyRotationStore) BeginRotation(context.Context) (recoveryKeyRotationTransaction, error) {
	if s.beginErr != nil {
		return nil, s.beginErr
	}
	s.tx.operations = append(s.tx.operations, "begin")
	return s.tx, nil
}

func (s *fakeRecoveryKeyRotationStore) IsRecoveryKeyActive(ctx context.Context, keyID string) (bool, error) {
	s.checkedErr = ctx.Err()
	s.checkedID = keyID
	return s.active, s.activeErr
}

func (tx *fakeRecoveryKeyRotationTransaction) TryAdvisoryLock(context.Context) (bool, error) {
	tx.operations = append(tx.operations, "advisory-lock")
	return tx.locked, tx.lockErr
}

func (tx *fakeRecoveryKeyRotationTransaction) LockRecoveryKeyTable(context.Context) error {
	tx.operations = append(tx.operations, "table-lock")
	return tx.tableLockErr
}

func (tx *fakeRecoveryKeyRotationTransaction) InvalidateUnused(context.Context) error {
	tx.operations = append(tx.operations, "invalidate-unused")
	return tx.invalidateErr
}

func (tx *fakeRecoveryKeyRotationTransaction) InsertRecoveryKey(_ context.Context, keyHash string) (string, error) {
	tx.operations = append(tx.operations, "insert")
	tx.insertedHash = keyHash
	return "11111111-1111-1111-1111-111111111111", tx.insertErr
}

func (tx *fakeRecoveryKeyRotationTransaction) WriteAudit(_ context.Context, keyID string) error {
	tx.operations = append(tx.operations, "audit")
	tx.auditedID = keyID
	return tx.auditErr
}

func (tx *fakeRecoveryKeyRotationTransaction) Commit() error {
	tx.operations = append(tx.operations, "commit")
	if tx.commitHook != nil {
		tx.commitHook()
	}
	return tx.commitErr
}

func (tx *fakeRecoveryKeyRotationTransaction) Rollback() error {
	tx.operations = append(tx.operations, "rollback")
	return tx.rollbackErr
}

func newFakeRecoveryKeyRotationStore() *fakeRecoveryKeyRotationStore {
	return &fakeRecoveryKeyRotationStore{tx: &fakeRecoveryKeyRotationTransaction{locked: true}}
}

func trustedRecoveryOutputDir(t *testing.T) string {
	t.Helper()
	directory := t.TempDir()
	if err := os.Chmod(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	return directory
}

func TestParseRecoveryKeyRotationArgs(t *testing.T) {
	abs := filepath.Join(t.TempDir(), "recovery-key")
	got, err := parseRecoveryKeyRotationArgs([]string{"--output", abs})
	if err != nil {
		t.Fatal(err)
	}
	if got != abs {
		t.Fatalf("output path=%q want=%q", got, abs)
	}

	for name, args := range map[string][]string{
		"missing output":  nil,
		"relative output": {"--output", "recovery-key"},
		"extra argument":  {"--output", abs, "unexpected"},
		"unknown flag":    {"--unknown"},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := parseRecoveryKeyRotationArgs(args); err == nil {
				t.Fatal("expected argument validation error")
			}
		})
	}
}

func TestRunRecoveryKeyRotationCLIRequiresDatabaseURL(t *testing.T) {
	output := filepath.Join(trustedRecoveryOutputDir(t), "recovery-key")
	err := runRecoveryKeyRotationCLI(context.Background(), []string{"--output", output}, "")
	if err == nil || !strings.Contains(err.Error(), "DATABASE_URL") {
		t.Fatalf("error=%v", err)
	}
	if _, statErr := os.Stat(output); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("unexpected output file: %v", statErr)
	}
}

func TestGenerateRecoveryKeyUses256Bits(t *testing.T) {
	first, err := generateRecoveryKey()
	if err != nil {
		t.Fatal(err)
	}
	second, err := generateRecoveryKey()
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatal("generated duplicate recovery keys")
	}
	decoded, err := base64.RawURLEncoding.DecodeString(first)
	if err != nil {
		t.Fatal(err)
	}
	if len(decoded) != 32 {
		t.Fatalf("recovery key entropy bytes=%d want=32", len(decoded))
	}
}

func TestRotateRecoveryKeyWritesSecureOutputAndCommits(t *testing.T) {
	store := newFakeRecoveryKeyRotationStore()
	output := filepath.Join(trustedRecoveryOutputDir(t), "recovery-key")
	err := rotateRecoveryKeyWith(
		context.Background(),
		store,
		output,
		func() (string, error) { return "plain-break-glass-secret", nil },
		func(secret string) (string, error) {
			if secret != "plain-break-glass-secret" {
				t.Fatalf("hashed unexpected secret %q", secret)
			}
			return "argon2-hash", nil
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "plain-break-glass-secret\n" {
		t.Fatalf("output content=%q", content)
	}
	info, err := os.Stat(output)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("output permissions=%04o want=0600", info.Mode().Perm())
	}
	wantOperations := []string{"begin", "advisory-lock", "table-lock", "invalidate-unused", "insert", "audit", "commit"}
	if !slices.Equal(store.tx.operations, wantOperations) {
		t.Fatalf("operations=%v want=%v", store.tx.operations, wantOperations)
	}
	if store.tx.insertedHash != "argon2-hash" || store.tx.auditedID != "11111111-1111-1111-1111-111111111111" {
		t.Fatalf("inserted hash=%q audited id=%q", store.tx.insertedHash, store.tx.auditedID)
	}
}

func TestRotateRecoveryKeyDoesNotOverwriteExistingOutput(t *testing.T) {
	store := newFakeRecoveryKeyRotationStore()
	output := filepath.Join(trustedRecoveryOutputDir(t), "recovery-key")
	if err := os.WriteFile(output, []byte("keep-me\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	err := rotateRecoveryKeyWith(
		context.Background(), store, output,
		func() (string, error) { return "new-secret", nil },
		func(string) (string, error) { return "new-hash", nil },
	)
	if err == nil {
		t.Fatal("expected exclusive-create error")
	}
	content, readErr := os.ReadFile(output)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if string(content) != "keep-me\n" {
		t.Fatalf("existing output was changed: %q", content)
	}
	wantOperations := []string{"begin", "advisory-lock", "table-lock", "rollback"}
	if !slices.Equal(store.tx.operations, wantOperations) {
		t.Fatalf("operations=%v want=%v", store.tx.operations, wantOperations)
	}
}

func TestRotateRecoveryKeyRequiresTrustedOutputDirectory(t *testing.T) {
	parent := trustedRecoveryOutputDir(t)
	if err := os.Chmod(parent, 0o755); err != nil {
		t.Fatal(err)
	}
	store := newFakeRecoveryKeyRotationStore()
	err := rotateRecoveryKeyWith(
		context.Background(), store, filepath.Join(parent, "recovery-key"),
		func() (string, error) { return "new-secret", nil },
		func(string) (string, error) { return "new-hash", nil },
	)
	if err == nil || !strings.Contains(err.Error(), "0700") {
		t.Fatalf("error=%v", err)
	}
	wantOperations := []string{"begin", "advisory-lock", "table-lock", "rollback"}
	if !slices.Equal(store.tx.operations, wantOperations) {
		t.Fatalf("operations=%v want=%v", store.tx.operations, wantOperations)
	}
}

func TestRotateRecoveryKeyRejectsSymlinkedOutputDirectory(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "target")
	if err := os.Mkdir(target, 0o700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "linked")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	store := newFakeRecoveryKeyRotationStore()
	err := rotateRecoveryKeyWith(
		context.Background(), store, filepath.Join(link, "recovery-key"),
		func() (string, error) { return "new-secret", nil },
		func(string) (string, error) { return "new-hash", nil },
	)
	if err == nil || !strings.Contains(err.Error(), "symbolic links") {
		t.Fatalf("error=%v", err)
	}
}

func TestRotateRecoveryKeyDetectsOutputPathReplacementAfterCommit(t *testing.T) {
	parent := trustedRecoveryOutputDir(t)
	output := filepath.Join(parent, "recovery-key")
	moved := filepath.Join(parent, "moved-recovery-key")
	store := newFakeRecoveryKeyRotationStore()
	store.tx.commitHook = func() {
		if err := os.Rename(output, moved); err != nil {
			t.Errorf("rename output during commit: %v", err)
		}
	}
	err := rotateRecoveryKeyWith(
		context.Background(), store, output,
		func() (string, error) { return "commit-secret", nil },
		func(string) (string, error) { return "commit-hash", nil },
	)
	if err == nil || !strings.Contains(err.Error(), "after commit") {
		t.Fatalf("error=%v", err)
	}
	content, readErr := os.ReadFile(moved)
	if readErr != nil || string(content) != "commit-secret\n" {
		t.Fatalf("preserved moved output content=%q error=%v", content, readErr)
	}
}

func TestRotateRecoveryKeyFailureRollsBackAndRemovesInactiveOutput(t *testing.T) {
	store := newFakeRecoveryKeyRotationStore()
	store.tx.auditErr = errors.New("audit unavailable")
	output := filepath.Join(trustedRecoveryOutputDir(t), "recovery-key")
	err := rotateRecoveryKeyWith(
		context.Background(), store, output,
		func() (string, error) { return "never-log-this-secret", nil },
		func(string) (string, error) { return "new-hash", nil },
	)
	if err == nil || !strings.Contains(err.Error(), "write recovery key audit") {
		t.Fatalf("error=%v", err)
	}
	if strings.Contains(err.Error(), "never-log-this-secret") {
		t.Fatalf("error leaked plaintext secret: %v", err)
	}
	if _, statErr := os.Stat(output); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("inactive output remains: %v", statErr)
	}
	wantOperations := []string{"begin", "advisory-lock", "table-lock", "invalidate-unused", "insert", "audit", "rollback"}
	if !slices.Equal(store.tx.operations, wantOperations) {
		t.Fatalf("operations=%v want=%v", store.tx.operations, wantOperations)
	}
}

func TestRotateRecoveryKeyRejectsConcurrentRotationBeforeWritingOutput(t *testing.T) {
	store := newFakeRecoveryKeyRotationStore()
	store.tx.locked = false
	output := filepath.Join(trustedRecoveryOutputDir(t), "recovery-key")
	err := rotateRecoveryKeyWith(
		context.Background(), store, output,
		func() (string, error) { return "unused-secret", nil },
		func(string) (string, error) { return "unused-hash", nil },
	)
	if err == nil || !strings.Contains(err.Error(), "already in progress") {
		t.Fatalf("error=%v", err)
	}
	if _, statErr := os.Stat(output); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("output created during lock contention: %v", statErr)
	}
	wantOperations := []string{"begin", "advisory-lock", "rollback"}
	if !slices.Equal(store.tx.operations, wantOperations) {
		t.Fatalf("operations=%v want=%v", store.tx.operations, wantOperations)
	}
}

func TestRotateRecoveryKeyRejectsOnlineRecoveryBeforeWritingOutput(t *testing.T) {
	store := newFakeRecoveryKeyRotationStore()
	store.tx.tableLockErr = errors.New("lock not available")
	output := filepath.Join(trustedRecoveryOutputDir(t), "recovery-key")
	err := rotateRecoveryKeyWith(
		context.Background(), store, output,
		func() (string, error) { return "unused-secret", nil },
		func(string) (string, error) { return "unused-hash", nil },
	)
	if err == nil || !strings.Contains(err.Error(), "lock recovery key table") {
		t.Fatalf("error=%v", err)
	}
	if _, statErr := os.Stat(output); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("output created during online recovery: %v", statErr)
	}
	wantOperations := []string{"begin", "advisory-lock", "table-lock", "rollback"}
	if !slices.Equal(store.tx.operations, wantOperations) {
		t.Fatalf("operations=%v want=%v", store.tx.operations, wantOperations)
	}
}

func TestRotateRecoveryKeyResolvesAmbiguousCommit(t *testing.T) {
	for name, active := range map[string]bool{"active": true, "inactive": false} {
		t.Run(name, func(t *testing.T) {
			store := newFakeRecoveryKeyRotationStore()
			store.tx.commitErr = errors.New("connection lost during commit")
			store.active = active
			output := filepath.Join(trustedRecoveryOutputDir(t), "recovery-key")
			err := rotateRecoveryKeyWith(
				context.Background(), store, output,
				func() (string, error) { return "commit-secret", nil },
				func(string) (string, error) { return "commit-hash", nil },
			)
			if active && err != nil {
				t.Fatalf("verified active commit returned error: %v", err)
			}
			if !active && err == nil {
				t.Fatal("verified inactive commit returned success")
			}
			_, statErr := os.Stat(output)
			if active && statErr != nil {
				t.Fatalf("active output missing: %v", statErr)
			}
			if !active && !errors.Is(statErr, os.ErrNotExist) {
				t.Fatalf("inactive output remains: %v", statErr)
			}
			if store.checkedID != "11111111-1111-1111-1111-111111111111" {
				t.Fatalf("checked id=%q", store.checkedID)
			}
		})
	}
}

func TestRotateRecoveryKeyVerifiesCommitAfterCallerCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	store := newFakeRecoveryKeyRotationStore()
	store.tx.commitErr = errors.New("connection lost during commit")
	store.tx.commitHook = cancel
	store.active = true
	output := filepath.Join(trustedRecoveryOutputDir(t), "recovery-key")
	err := rotateRecoveryKeyWith(
		ctx, store, output,
		func() (string, error) { return "commit-secret", nil },
		func(string) (string, error) { return "commit-hash", nil },
	)
	if err != nil {
		t.Fatalf("verified committed rotation returned error: %v", err)
	}
	if store.checkedErr != nil {
		t.Fatalf("commit verification inherited canceled context: %v", store.checkedErr)
	}
}

func TestRotateRecoveryKeyPreservesOutputWhenCommitCannotBeVerified(t *testing.T) {
	store := newFakeRecoveryKeyRotationStore()
	store.tx.commitErr = errors.New("connection lost during commit")
	store.activeErr = errors.New("database unavailable")
	output := filepath.Join(trustedRecoveryOutputDir(t), "recovery-key")
	err := rotateRecoveryKeyWith(
		context.Background(), store, output,
		func() (string, error) { return "uncertain-secret", nil },
		func(string) (string, error) { return "uncertain-hash", nil },
	)
	if err == nil || !strings.Contains(err.Error(), "activation status is unknown") {
		t.Fatalf("error=%v", err)
	}
	if _, statErr := os.Stat(output); statErr != nil {
		t.Fatalf("uncertain output should be preserved: %v", statErr)
	}
}
