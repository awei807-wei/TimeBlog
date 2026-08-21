package main

import (
	"context"
	"database/sql"
)

type sqlRecoveryKeyRotationStore struct {
	db *sql.DB
}

type sqlRecoveryKeyRotationTransaction struct {
	tx *sql.Tx
}

func (s *sqlRecoveryKeyRotationStore) BeginRotation(ctx context.Context) (recoveryKeyRotationTransaction, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return nil, err
	}
	return &sqlRecoveryKeyRotationTransaction{tx: tx}, nil
}

func (s *sqlRecoveryKeyRotationStore) IsRecoveryKeyActive(ctx context.Context, keyID string) (bool, error) {
	var active bool
	err := s.db.QueryRowContext(ctx, `SELECT EXISTS (
		SELECT 1 FROM account_recovery_keys
		WHERE id=$1::uuid AND used_at IS NULL AND expires_at>now()
	)`, keyID).Scan(&active)
	return active, err
}

func (tx *sqlRecoveryKeyRotationTransaction) TryAdvisoryLock(ctx context.Context) (bool, error) {
	var locked bool
	err := tx.tx.QueryRowContext(ctx, `SELECT pg_try_advisory_xact_lock($1)`, recoveryKeyRotationLockID).Scan(&locked)
	return locked, err
}

func (tx *sqlRecoveryKeyRotationTransaction) LockRecoveryKeyTable(ctx context.Context) error {
	_, err := tx.tx.ExecContext(ctx, `LOCK TABLE account_recovery_keys IN EXCLUSIVE MODE NOWAIT`)
	return err
}

func (tx *sqlRecoveryKeyRotationTransaction) InvalidateUnused(ctx context.Context) error {
	_, err := tx.tx.ExecContext(ctx, `UPDATE account_recovery_keys SET used_at=now() WHERE used_at IS NULL`)
	return err
}

func (tx *sqlRecoveryKeyRotationTransaction) InsertRecoveryKey(ctx context.Context, keyHash string) (string, error) {
	var keyID string
	err := tx.tx.QueryRowContext(ctx, `INSERT INTO account_recovery_keys(id,key_hash,expires_at)
		VALUES(gen_random_uuid(),$1,now()+interval '90 days')
		RETURNING id::text`, keyHash).Scan(&keyID)
	return keyID, err
}

func (tx *sqlRecoveryKeyRotationTransaction) WriteAudit(ctx context.Context, keyID string) error {
	_, err := tx.tx.ExecContext(ctx, `INSERT INTO account_recovery_audit(key_id,account_hash,ip_hash,success,event)
		VALUES($1::uuid,$2,$3,true,'recovery_key_rotated')`, keyID, hashLoginField("owner"), hashLoginField("break-glass-cli"))
	return err
}

func (tx *sqlRecoveryKeyRotationTransaction) Commit() error {
	return tx.tx.Commit()
}

func (tx *sqlRecoveryKeyRotationTransaction) Rollback() error {
	return tx.tx.Rollback()
}
