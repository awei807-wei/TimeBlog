package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

const authOperationTTL = 24 * time.Hour

type authOperationState struct {
	PayloadMAC    string
	RecoveryKeyID sql.NullString
}

var (
	errAuthOperationConflict = errors.New("auth operation token conflict")
	errAuthOperationMissing  = errors.New("auth operation not found")
)

func loadAuthOperation(ctx context.Context, query recoveryOperationQuerier, operationHash, purpose string) (authOperationState, bool, error) {
	var state authOperationState
	err := query.QueryRowContext(ctx, `SELECT payload_mac,recovery_key_id::text
		FROM auth_operation_idempotency
		WHERE operation_hash=$1 AND purpose=$2 AND expires_at>now()`, operationHash, purpose).
		Scan(&state.PayloadMAC, &state.RecoveryKeyID)
	if errors.Is(err, sql.ErrNoRows) {
		return authOperationState{}, false, nil
	}
	return state, err == nil, err
}

func pruneAuthOperations(ctx context.Context, exec interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}) error {
	if _, err := exec.ExecContext(ctx, `DELETE FROM auth_operation_idempotency WHERE expires_at<=now()`); err != nil {
		return fmt.Errorf("prune auth operation records: %w", err)
	}
	return nil
}

func insertAuthOperation(ctx context.Context, exec interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}, operationHash, purpose, payloadMAC, recoveryKeyID string) error {
	var err error
	if recoveryKeyID == "" {
		_, err = exec.ExecContext(ctx, `INSERT INTO auth_operation_idempotency(operation_hash,purpose,payload_mac,expires_at)
			VALUES($1,$2,$3,now()+interval '24 hours')`, operationHash, purpose, payloadMAC)
	} else {
		_, err = exec.ExecContext(ctx, `INSERT INTO auth_operation_idempotency(operation_hash,purpose,payload_mac,recovery_key_id,expires_at)
			VALUES($1,$2,$3,$4::uuid,now()+interval '24 hours')`, operationHash, purpose, payloadMAC, recoveryKeyID)
	}
	if err != nil {
		return fmt.Errorf("insert auth operation record: %w", err)
	}
	return nil
}

func resolveAuthOperationCommit(ctx context.Context, db *sql.DB, operationHash, purpose, payloadMAC string) error {
	state, found, err := loadAuthOperation(ctx, db, operationHash, purpose)
	if err != nil {
		return err
	}
	keyActive := true
	if purpose == recoveryRotationPurpose {
		if !state.RecoveryKeyID.Valid || state.RecoveryKeyID.String == "" {
			return errAuthOperationMissing
		}
		keyActive = recoveryKeyStillActive(ctx, db, state.RecoveryKeyID.String)
	}
	if authOperationCommitMatches(state, found, purpose, payloadMAC, keyActive) {
		return nil
	}
	return errAuthOperationMissing
}

// authOperationCommitMatches is deliberately stricter for recovery-key
// rotation than for TOTP password reset.  A commit is only recoverable when
// its payload, bound recovery key id, and current key state still agree.
func authOperationCommitMatches(state authOperationState, found bool, purpose, payloadMAC string, keyActive bool) bool {
	if !found || !recoveryPayloadMACMatches(state.PayloadMAC, payloadMAC) {
		return false
	}
	if purpose == recoveryRotationPurpose {
		return state.RecoveryKeyID.Valid && state.RecoveryKeyID.String != "" && keyActive
	}
	return true
}
