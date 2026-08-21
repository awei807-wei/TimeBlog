package main

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"errors"
	"flag"
	"fmt"
	"io"
	"path/filepath"
	"strings"
	"time"
)

const recoveryKeyRotationLockID int64 = 0x54424c4f47524b

type recoveryKeyRotationStore interface {
	BeginRotation(context.Context) (recoveryKeyRotationTransaction, error)
	IsRecoveryKeyActive(context.Context, string) (bool, error)
}

type recoveryKeyRotationTransaction interface {
	TryAdvisoryLock(context.Context) (bool, error)
	LockRecoveryKeyTable(context.Context) error
	InvalidateUnused(context.Context) error
	InsertRecoveryKey(context.Context, string) (string, error)
	WriteAudit(context.Context, string) error
	Commit() error
	Rollback() error
}

// runRecoveryKeyRotationCLI handles the explicit break-glass operator command.
// It deliberately opens the database without running normal API bootstrap so a
// missing recovery key cannot prevent the repair operation itself.
func runRecoveryKeyRotationCLI(ctx context.Context, args []string, databaseURL string) error {
	outputPath, err := parseRecoveryKeyRotationArgs(args)
	if err != nil {
		return err
	}
	if strings.TrimSpace(databaseURL) == "" {
		return errors.New("DATABASE_URL is required for recovery key rotation")
	}

	db, err := sql.Open("pgx", databaseURL)
	if err != nil {
		return fmt.Errorf("open recovery database: %w", err)
	}
	defer db.Close()
	db.SetMaxOpenConns(2)
	db.SetMaxIdleConns(0)
	if err := db.PingContext(ctx); err != nil {
		return fmt.Errorf("connect to recovery database: %w", err)
	}

	return rotateRecoveryKey(ctx, &sqlRecoveryKeyRotationStore{db: db}, outputPath)
}

func parseRecoveryKeyRotationArgs(args []string) (string, error) {
	flags := flag.NewFlagSet("--rotate-recovery-key", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	var outputPath string
	flags.StringVar(&outputPath, "output", "", "absolute path for the new recovery key")
	if err := flags.Parse(args); err != nil {
		return "", fmt.Errorf("invalid recovery key rotation arguments: %w", err)
	}
	if flags.NArg() != 0 {
		return "", errors.New("recovery key rotation accepts only --output <absolute path>")
	}
	if strings.TrimSpace(outputPath) == "" {
		return "", errors.New("--output <absolute path> is required")
	}
	if !filepath.IsAbs(outputPath) {
		return "", errors.New("--output must be an absolute path")
	}
	return filepath.Clean(outputPath), nil
}

func rotateRecoveryKey(ctx context.Context, store recoveryKeyRotationStore, outputPath string) error {
	return rotateRecoveryKeyWith(ctx, store, outputPath, generateRecoveryKey, hashPassword)
}

func rotateRecoveryKeyWith(
	ctx context.Context,
	store recoveryKeyRotationStore,
	outputPath string,
	generate func() (string, error),
	hash func(string) (string, error),
) (resultErr error) {
	secret, keyHash, err := prepareRecoveryKeyMaterial(generate, hash)
	if err != nil {
		return err
	}

	tx, err := store.BeginRotation(ctx)
	if err != nil {
		return fmt.Errorf("begin recovery key rotation: %w", err)
	}
	committed := false
	defer func() {
		if committed {
			return
		}
		if rollbackErr := tx.Rollback(); rollbackErr != nil && !errors.Is(rollbackErr, sql.ErrTxDone) {
			resultErr = errors.Join(resultErr, fmt.Errorf("rollback recovery key rotation: %w", rollbackErr))
		}
	}()

	locked, err := tx.TryAdvisoryLock(ctx)
	if err != nil {
		return fmt.Errorf("lock recovery key rotation: %w", err)
	}
	if !locked {
		return errors.New("another recovery key rotation is already in progress")
	}
	if err := tx.LockRecoveryKeyTable(ctx); err != nil {
		return fmt.Errorf("lock recovery key table: %w", err)
	}

	output, err := createRecoveryKeyOutput(outputPath, secret)
	if err != nil {
		return err
	}
	keepOutput := false
	defer func() {
		if !keepOutput {
			if removeErr := output.Remove(); removeErr != nil {
				resultErr = errors.Join(resultErr, fmt.Errorf("remove inactive recovery key output: %w", removeErr))
			}
		}
		if closeErr := output.Close(); closeErr != nil {
			resultErr = errors.Join(resultErr, fmt.Errorf("close recovery key output handles: %w", closeErr))
		}
	}()

	keyID, err := stageRecoveryKey(ctx, tx, keyHash)
	if err != nil {
		return err
	}
	if err = output.Verify(); err != nil {
		return fmt.Errorf("verify recovery key output before commit: %w", err)
	}
	keepOutput, err = commitRecoveryKeyRotation(ctx, store, tx, keyID)
	if err != nil {
		if keepOutput {
			err = errors.Join(err, output.Verify())
		}
		return err
	}

	committed = true
	if err = output.Verify(); err != nil {
		return fmt.Errorf("verify recovery key output after commit: %w", err)
	}
	return nil
}

func prepareRecoveryKeyMaterial(
	generate func() (string, error),
	hash func(string) (string, error),
) (string, string, error) {
	secret, err := generate()
	if err != nil {
		return "", "", fmt.Errorf("generate recovery key: %w", err)
	}
	if secret == "" {
		return "", "", errors.New("generate recovery key: empty secret")
	}
	keyHash, err := hash(secret)
	if err != nil {
		return "", "", fmt.Errorf("hash recovery key: %w", err)
	}
	return secret, keyHash, nil
}

func stageRecoveryKey(ctx context.Context, tx recoveryKeyRotationTransaction, keyHash string) (string, error) {
	// The partial unique index treats expired-but-unused rows as active. Mark
	// every unused row before inserting so rotation also repairs that state.
	if err := tx.InvalidateUnused(ctx); err != nil {
		return "", fmt.Errorf("invalidate old recovery keys: %w", err)
	}
	keyID, err := tx.InsertRecoveryKey(ctx, keyHash)
	if err != nil {
		return "", fmt.Errorf("insert recovery key: %w", err)
	}
	if err := tx.WriteAudit(ctx, keyID); err != nil {
		return "", fmt.Errorf("write recovery key audit: %w", err)
	}
	return keyID, nil
}

func commitRecoveryKeyRotation(
	ctx context.Context,
	store recoveryKeyRotationStore,
	tx recoveryKeyRotationTransaction,
	keyID string,
) (bool, error) {
	commitErr := tx.Commit()
	if commitErr == nil {
		return true, nil
	}
	// Commit errors can be ambiguous after a network interruption. Verify the
	// inserted key before deciding whether deleting the only plaintext copy is
	// safe. An unverifiable outcome keeps the 0600 file for manual recovery.
	verifyContext, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	active, verifyErr := store.IsRecoveryKeyActive(verifyContext, keyID)
	if verifyErr != nil {
		return true, errors.Join(
			fmt.Errorf("commit recovery key rotation: %w", commitErr),
			fmt.Errorf("activation status is unknown; preserve the output file and verify key id %s: %w", keyID, verifyErr),
		)
	}
	if !active {
		return false, fmt.Errorf("commit recovery key rotation: %w", commitErr)
	}
	return true, nil
}

func generateRecoveryKey() (string, error) {
	raw := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}
