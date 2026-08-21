package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"time"
)

type recoveryOperationQuerier interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

type recoveryOperationState struct {
	PayloadMAC string
	KeyActive  bool
}

func (srv *Server) recoverPersistentAccount(r *http.Request, in accountRecoveryRequest, payloadMAC string) error {
	passwordHash, newRecoveryHash, encryptedTOTP, err := preparePersistentRecovery(in)
	if err != nil {
		return err
	}
	operationHash := recoveryOperationHash(in.OperationToken)
	tx, err := srv.store.database.BeginTx(r.Context(), nil)
	if err != nil {
		return fmt.Errorf("begin account recovery: %w", err)
	}
	defer tx.Rollback()
	if err = lockRecoveryKeyTable(r.Context(), tx); err != nil {
		return fmt.Errorf("lock recovery key table: %w", err)
	}
	if _, err = tx.ExecContext(r.Context(), `DELETE FROM account_recovery_operations WHERE expires_at<=now()`); err != nil {
		return fmt.Errorf("prune account recovery operations: %w", err)
	}
	if state, found, loadErr := loadRecoveryOperation(r.Context(), tx, operationHash); loadErr != nil {
		return fmt.Errorf("load account recovery operation: %w", loadErr)
	} else if found {
		if !recoveryPayloadMACMatches(state.PayloadMAC, payloadMAC) || !state.KeyActive {
			return errRecoveryOperationConflict
		}
		return nil
	}

	keyID, keyHash, err := activeRecoveryKey(r.Context(), tx)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("load active recovery key: %w", err)
	}
	if errors.Is(err, sql.ErrNoRows) || !verifyPassword(in.RecoveryKey, keyHash) {
		_ = tx.Rollback()
		srv.recordRecoveryAudit(r, keyID, false, "invalid_key")
		return errInvalidRecoveryKey
	}
	if err = updateRecoveredOwner(r.Context(), tx, passwordHash, encryptedTOTP); err != nil {
		return err
	}
	if _, err = tx.ExecContext(r.Context(), `UPDATE sessions SET revoked_at=now() WHERE revoked_at IS NULL`); err != nil {
		return fmt.Errorf("revoke account sessions: %w", err)
	}
	if err = consumeRecoveryKey(r.Context(), tx, keyID); err != nil {
		return err
	}
	newKeyID, err := insertRecoveryKey(r.Context(), tx, newRecoveryHash)
	if err != nil {
		return err
	}
	if _, err = tx.ExecContext(r.Context(), `INSERT INTO account_recovery_operations(operation_hash,payload_mac,recovery_key_id,expires_at)
		VALUES($1,$2,$3::uuid,now()+interval '24 hours')`, operationHash, payloadMAC, newKeyID); err != nil {
		return fmt.Errorf("record account recovery operation: %w", err)
	}
	if _, err = tx.ExecContext(r.Context(), `INSERT INTO account_recovery_audit(key_id,account_hash,ip_hash,success,event)
		VALUES($1::uuid,$2,$3,true,'account_recovered')`, keyID, hashLoginField("owner"), hashLoginField(requestRemoteIP(r))); err != nil {
		return fmt.Errorf("write account recovery audit: %w", err)
	}
	if err = tx.Commit(); err == nil {
		return nil
	}
	return srv.resolveRecoveryCommit(r.Context(), operationHash, payloadMAC, err)
}

func preparePersistentRecovery(in accountRecoveryRequest) (string, string, string, error) {
	passwordHash, err := hashPassword(in.NewPassword)
	if err != nil {
		return "", "", "", fmt.Errorf("hash recovered password: %w", err)
	}
	newRecoveryHash, err := hashPassword(in.NewRecoveryKey)
	if err != nil {
		return "", "", "", fmt.Errorf("hash new recovery key: %w", err)
	}
	encryptedTOTP, err := encryptSecret(in.NewTOTPSecret)
	if err != nil {
		return "", "", "", fmt.Errorf("encrypt recovered TOTP: %w", err)
	}
	return passwordHash, newRecoveryHash, encryptedTOTP, nil
}

func activeRecoveryKey(ctx context.Context, tx *sql.Tx) (string, string, error) {
	var keyID, keyHash string
	err := tx.QueryRowContext(ctx, `SELECT id::text,key_hash FROM account_recovery_keys
		WHERE used_at IS NULL AND expires_at>now() ORDER BY created_at DESC LIMIT 1 FOR UPDATE`).Scan(&keyID, &keyHash)
	return keyID, keyHash, err
}

func updateRecoveredOwner(ctx context.Context, tx *sql.Tx, passwordHash, encryptedTOTP string) error {
	result, err := tx.ExecContext(ctx, `UPDATE users SET password_hash=$1,totp_secret_encrypted=$2 WHERE username='owner'`, passwordHash, encryptedTOTP)
	if err != nil {
		return fmt.Errorf("update recovered owner: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("read recovered owner update count: %w", err)
	}
	if rows != 1 {
		return fmt.Errorf("update recovered owner affected %d rows", rows)
	}
	return nil
}

func consumeRecoveryKey(ctx context.Context, tx *sql.Tx, keyID string) error {
	result, err := tx.ExecContext(ctx, `UPDATE account_recovery_keys SET used_at=now()
		WHERE id=$1::uuid AND used_at IS NULL`, keyID)
	if err != nil {
		return fmt.Errorf("consume recovery key: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("read consumed recovery key count: %w", err)
	}
	if rows != 1 {
		return fmt.Errorf("consume recovery key affected %d rows", rows)
	}
	return nil
}

func insertRecoveryKey(ctx context.Context, tx *sql.Tx, keyHash string) (string, error) {
	var keyID string
	err := tx.QueryRowContext(ctx, `INSERT INTO account_recovery_keys(id,key_hash,expires_at)
		VALUES(gen_random_uuid(),$1,now()+interval '90 days') RETURNING id::text`, keyHash).Scan(&keyID)
	if err != nil {
		return "", fmt.Errorf("insert new recovery key: %w", err)
	}
	return keyID, nil
}

func loadRecoveryOperation(ctx context.Context, query recoveryOperationQuerier, operationHash string) (recoveryOperationState, bool, error) {
	var state recoveryOperationState
	err := query.QueryRowContext(ctx, `SELECT recovery_operation.payload_mac,
		(recovery_key.used_at IS NULL AND recovery_key.expires_at>now())
		FROM account_recovery_operations recovery_operation
		JOIN account_recovery_keys recovery_key ON recovery_key.id=recovery_operation.recovery_key_id
		WHERE recovery_operation.operation_hash=$1 AND recovery_operation.expires_at>now()`, operationHash).Scan(&state.PayloadMAC, &state.KeyActive)
	if errors.Is(err, sql.ErrNoRows) {
		return recoveryOperationState{}, false, nil
	}
	return state, err == nil, err
}

func (srv *Server) resolveRecoveryCommit(requestContext context.Context, operationHash, payloadMAC string, commitErr error) error {
	verifyContext, cancel := context.WithTimeout(context.WithoutCancel(requestContext), 5*time.Second)
	defer cancel()
	state, found, verifyErr := loadRecoveryOperation(verifyContext, srv.store.database, operationHash)
	if verifyErr == nil && found && state.KeyActive && recoveryPayloadMACMatches(state.PayloadMAC, payloadMAC) {
		return nil
	}
	if verifyErr != nil {
		return errors.Join(fmt.Errorf("commit account recovery: %w", commitErr), fmt.Errorf("verify account recovery commit: %w", verifyErr))
	}
	return fmt.Errorf("commit account recovery: %w", commitErr)
}
