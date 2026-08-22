package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"time"
)

type authOperationExecutor interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

func loadOwnerAuthFactors(ctx context.Context, query recoveryOperationQuerier, lock bool) (ownerAuthFactors, error) {
	statement := `SELECT id::text,password_hash,totp_secret_encrypted FROM users WHERE username='owner'`
	if lock {
		statement += ` FOR UPDATE`
	}
	var factors ownerAuthFactors
	err := query.QueryRowContext(ctx, statement).Scan(&factors.ID, &factors.PasswordHash, &factors.TOTPEncrypted)
	return factors, err
}

func loadAndLockTOTPReplayStep(ctx context.Context, exec authOperationExecutor, query recoveryOperationQuerier, userID string) (int64, error) {
	if _, err := exec.ExecContext(ctx, `INSERT INTO totp_replay_guards(user_id,last_used_step) VALUES($1::uuid,-1) ON CONFLICT(user_id) DO NOTHING`, userID); err != nil {
		return 0, fmt.Errorf("initialize TOTP replay guard: %w", err)
	}
	var lastStep int64
	if err := query.QueryRowContext(ctx, `SELECT last_used_step FROM totp_replay_guards WHERE user_id=$1::uuid FOR UPDATE`, userID).Scan(&lastStep); err != nil {
		return 0, fmt.Errorf("load TOTP replay guard: %w", err)
	}
	return lastStep, nil
}

func updateTOTPReplayStep(ctx context.Context, exec authOperationExecutor, userID string, step int64) error {
	result, err := exec.ExecContext(ctx, `UPDATE totp_replay_guards SET last_used_step=$1,updated_at=now() WHERE user_id=$2::uuid`, step, userID)
	if err != nil {
		return fmt.Errorf("update TOTP replay guard: %w", err)
	}
	if rows, err := result.RowsAffected(); err != nil || rows != 1 {
		return fmt.Errorf("update TOTP replay guard affected %d rows", rows)
	}
	return nil
}

func verifyOwnerFactors(factors ownerAuthFactors, password, code string, now time.Time, lastStep int64) (int64, error) {
	if !verifyPassword(password, factors.PasswordHash) {
		return 0, errInvalidSecurityFactors
	}
	return verifyTOTPFactor(factors, code, now, lastStep)
}

func verifyTOTPFactor(factors ownerAuthFactors, code string, now time.Time, lastStep int64) (int64, error) {
	plain, err := decryptSecret(factors.TOTPEncrypted)
	if err != nil {
		return 0, errInvalidSecurityFactors
	}
	step, valid, err := validateTOTPWithStep(code, plain, now)
	if err != nil {
		return 0, errInvalidSecurityFactors
	}
	if !valid {
		return 0, errInvalidSecurityFactors
	}
	if step <= lastStep {
		return 0, errPasswordResetReplay
	}
	return step, nil
}

func insertSecurityAudit(ctx context.Context, exec authOperationExecutor, keyID, ip string, success bool, event string) error {
	_, err := exec.ExecContext(ctx, `INSERT INTO account_recovery_audit(key_id,account_hash,ip_hash,success,event)
		VALUES(NULLIF($1,'')::uuid,$2,$3,$4,$5)`, keyID, hashLoginField("owner"), hashLoginField(ip), success, event)
	return err
}

func (srv *Server) completeTOTPPasswordRecoveryPersistent(r *http.Request, in totpPasswordResetCompleteRequest, operationHash, payloadMAC string) error {
	tx, err := srv.store.database.BeginTx(r.Context(), nil)
	if err != nil {
		return fmt.Errorf("begin TOTP password reset: %w", err)
	}
	defer tx.Rollback()
	if err = pruneAuthOperations(r.Context(), tx); err != nil {
		return err
	}
	if state, found, loadErr := loadAuthOperation(r.Context(), tx, operationHash, totpOperationPurpose); loadErr != nil {
		return fmt.Errorf("load TOTP password reset operation: %w", loadErr)
	} else if found {
		if !recoveryPayloadMACMatches(state.PayloadMAC, payloadMAC) {
			return errAuthOperationConflict
		}
		return nil
	}

	var expiresAt time.Time
	err = tx.QueryRowContext(r.Context(), `SELECT expires_at FROM mfa_challenges
		WHERE token_hash=$1 AND purpose=$2 FOR UPDATE`, tokenHash(in.Challenge), passwordResetChallengePurpose).Scan(&expiresAt)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && !expiresAt.After(time.Now())) {
		// A concurrent request with the same operation token may have committed
		// after this transaction first checked the idempotency table but before
		// the challenge lock became available. Resolve that committed outcome
		// before reporting the one-time challenge as invalid.
		if state, found, loadErr := loadAuthOperation(r.Context(), tx, operationHash, totpOperationPurpose); loadErr != nil {
			return fmt.Errorf("resolve concurrent TOTP password reset: %w", loadErr)
		} else if found {
			if recoveryPayloadMACMatches(state.PayloadMAC, payloadMAC) {
				return nil
			}
			return errAuthOperationConflict
		}
		return errInvalidPasswordReset
	}
	if err != nil {
		return fmt.Errorf("load password reset challenge: %w", err)
	}
	factors, err := loadOwnerAuthFactors(r.Context(), tx, true)
	if err != nil {
		return errInvalidPasswordReset
	}
	lastStep, err := loadAndLockTOTPReplayStep(r.Context(), tx, tx, factors.ID)
	if err != nil {
		return err
	}
	step, err := verifyTOTPFactor(factors, in.Code, time.Now(), lastStep)
	if errors.Is(err, errInvalidSecurityFactors) {
		return errInvalidPasswordReset
	}
	if err != nil {
		return err
	}
	passwordHash, err := hashPassword(in.NewPassword)
	if err != nil {
		return fmt.Errorf("hash reset password: %w", err)
	}
	if _, err = tx.ExecContext(r.Context(), `UPDATE users SET password_hash=$1 WHERE id=$2::uuid`, passwordHash, factors.ID); err != nil {
		return fmt.Errorf("update reset password: %w", err)
	}
	if err = updateTOTPReplayStep(r.Context(), tx, factors.ID, step); err != nil {
		return err
	}
	if _, err = tx.ExecContext(r.Context(), `DELETE FROM mfa_challenges WHERE token_hash=$1 AND purpose=$2`, tokenHash(in.Challenge), passwordResetChallengePurpose); err != nil {
		return fmt.Errorf("consume password reset challenge: %w", err)
	}
	if _, err = tx.ExecContext(r.Context(), `UPDATE sessions SET revoked_at=now() WHERE revoked_at IS NULL`); err != nil {
		return fmt.Errorf("revoke sessions after password reset: %w", err)
	}
	if err = insertSecurityAudit(r.Context(), tx, "", requestRemoteIP(r), true, "totp_password_reset"); err != nil {
		return fmt.Errorf("audit TOTP password reset: %w", err)
	}
	if err = insertAuthOperation(r.Context(), tx, operationHash, totpOperationPurpose, payloadMAC, ""); err != nil {
		return err
	}
	if err = tx.Commit(); err == nil {
		return nil
	}
	verifyContext, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 5*time.Second)
	defer cancel()
	if resolveErr := resolveAuthOperationCommit(verifyContext, srv.store.database, operationHash, totpOperationPurpose, payloadMAC); resolveErr == nil {
		return nil
	}
	return fmt.Errorf("commit TOTP password reset: %w", err)
}

func (srv *Server) completeTOTPPasswordRecoveryMemory(r *http.Request, in totpPasswordResetCompleteRequest, operationHash, payloadMAC string) error {
	now := time.Now()
	srv.store.mu.Lock()
	defer srv.store.mu.Unlock()
	for hash, operation := range srv.store.authOperations {
		if !operation.ExpiresAt.After(now) {
			delete(srv.store.authOperations, hash)
		}
	}
	if operation, found := srv.store.authOperations[operationHash]; found {
		if operation.Purpose != totpOperationPurpose || !recoveryPayloadMACMatches(operation.PayloadMAC, payloadMAC) {
			return errAuthOperationConflict
		}
		return nil
	}
	challengeHash := tokenHash(in.Challenge)
	challenge, found := srv.store.mfaChallenges[challengeHash]
	if !found || challenge.ChallengeHash != challengeHash || challenge.Purpose != passwordResetChallengePurpose || !challenge.ExpiresAt.After(now) {
		return errInvalidPasswordReset
	}
	step, valid, err := validateTOTPWithStep(in.Code, srv.store.userTOTP, now)
	if err != nil || !valid {
		return errInvalidPasswordReset
	}
	if srv.store.totpLastUsedSet && step <= srv.store.totpLastUsedStep {
		return errPasswordResetReplay
	}
	srv.store.userPassword = in.NewPassword
	srv.store.totpLastUsedStep = step
	srv.store.totpLastUsedSet = true
	delete(srv.store.mfaChallenges, challengeHash)
	for _, session := range srv.store.sessions {
		revokedAt := now
		session.RevokedAt = &revokedAt
	}
	srv.store.authOperations[operationHash] = memoryAuthOperation{Purpose: totpOperationPurpose, PayloadMAC: payloadMAC, ExpiresAt: now.Add(authOperationTTL)}
	return nil
}

func (srv *Server) changePasswordPersistent(r *http.Request, in passwordChangeRequest) error {
	tx, err := srv.store.database.BeginTx(r.Context(), nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	factors, err := loadOwnerAuthFactors(r.Context(), tx, true)
	if err != nil {
		return errInvalidSecurityFactors
	}
	lastStep, err := loadAndLockTOTPReplayStep(r.Context(), tx, tx, factors.ID)
	if err != nil {
		return err
	}
	step, err := verifyOwnerFactors(factors, in.CurrentPassword, in.Code, time.Now(), lastStep)
	if err != nil {
		return err
	}
	passwordHash, err := hashPassword(in.NewPassword)
	if err != nil {
		return err
	}
	if _, err = tx.ExecContext(r.Context(), `UPDATE users SET password_hash=$1 WHERE id=$2::uuid`, passwordHash, factors.ID); err != nil {
		return err
	}
	if err = updateTOTPReplayStep(r.Context(), tx, factors.ID, step); err != nil {
		return err
	}
	if _, err = tx.ExecContext(r.Context(), `UPDATE sessions SET revoked_at=now() WHERE revoked_at IS NULL`); err != nil {
		return err
	}
	if err = insertSecurityAudit(r.Context(), tx, "", requestRemoteIP(r), true, "password_changed"); err != nil {
		return err
	}
	return tx.Commit()
}

func (srv *Server) changePasswordMemory(r *http.Request, in passwordChangeRequest) error {
	now := time.Now()
	srv.store.mu.Lock()
	defer srv.store.mu.Unlock()
	if in.CurrentPassword != srv.store.userPassword {
		return errInvalidSecurityFactors
	}
	step, valid, err := validateTOTPWithStep(in.Code, srv.store.userTOTP, now)
	if err != nil || !valid {
		return errInvalidSecurityFactors
	}
	if srv.store.totpLastUsedSet && step <= srv.store.totpLastUsedStep {
		return errPasswordResetReplay
	}
	srv.store.userPassword = in.NewPassword
	srv.store.totpLastUsedStep = step
	srv.store.totpLastUsedSet = true
	for _, session := range srv.store.sessions {
		revokedAt := now
		session.RevokedAt = &revokedAt
	}
	return nil
}
