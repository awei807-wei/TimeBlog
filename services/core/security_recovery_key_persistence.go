package main

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"time"
)

func (srv *Server) rotateRecoveryKeyPersistent(r *http.Request, in recoveryKeyRotationRequest, operationHash, payloadMAC string) error {
	newHash, err := hashPassword(in.NewRecoveryKey)
	if err != nil {
		return err
	}
	tx, err := srv.store.database.BeginTx(r.Context(), nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = lockRecoveryKeyTable(r.Context(), tx); err != nil {
		return err
	}
	if err = pruneAuthOperations(r.Context(), tx); err != nil {
		return err
	}
	if state, found, loadErr := loadAuthOperation(r.Context(), tx, operationHash, recoveryRotationPurpose); loadErr != nil {
		return loadErr
	} else if found {
		if !recoveryPayloadMACMatches(state.PayloadMAC, payloadMAC) {
			return errAuthOperationConflict
		}
		if !state.RecoveryKeyID.Valid || !recoveryKeyStillActive(r.Context(), tx, state.RecoveryKeyID.String) {
			return errAuthOperationConflict
		}
		return nil
	}
	factors, err := loadOwnerAuthFactors(r.Context(), tx, true)
	if err != nil {
		return errInvalidSecurityFactors
	}
	lastStep, err := loadAndLockTOTPReplayStep(r.Context(), tx, tx, factors.ID)
	if err != nil {
		return err
	}
	step, err := verifyOwnerFactors(factors, in.Password, in.Code, time.Now(), lastStep)
	if err != nil {
		return err
	}
	oldKeyID, _, err := activeRecoveryKey(r.Context(), tx)
	if errors.Is(err, sql.ErrNoRows) {
		return errInvalidRecoveryRotate
	}
	if err != nil {
		return err
	}
	if err = consumeRecoveryKey(r.Context(), tx, oldKeyID); err != nil {
		return err
	}
	newKeyID, err := insertRecoveryKey(r.Context(), tx, newHash)
	if err != nil {
		return err
	}
	if err = updateTOTPReplayStep(r.Context(), tx, factors.ID, step); err != nil {
		return err
	}
	currentCookie, cookieErr := r.Cookie("timeline_session")
	if cookieErr != nil || currentCookie.Value == "" {
		return errInvalidSecurityFactors
	}
	if _, err = tx.ExecContext(r.Context(), `UPDATE sessions SET revoked_at=now() WHERE token_hash<>$1 AND revoked_at IS NULL`, tokenHash(currentCookie.Value)); err != nil {
		return err
	}
	if err = insertSecurityAudit(r.Context(), tx, oldKeyID, requestRemoteIP(r), true, "recovery_key_rotated_browser"); err != nil {
		return err
	}
	if err = insertAuthOperation(r.Context(), tx, operationHash, recoveryRotationPurpose, payloadMAC, newKeyID); err != nil {
		return err
	}
	if err = tx.Commit(); err == nil {
		return nil
	}
	verifyContext, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 5*time.Second)
	defer cancel()
	if resolveErr := resolveAuthOperationCommit(verifyContext, srv.store.database, operationHash, recoveryRotationPurpose, payloadMAC); resolveErr == nil {
		return nil
	}
	return err
}

func recoveryKeyStillActive(ctx context.Context, query recoveryOperationQuerier, keyID string) bool {
	var active bool
	if err := query.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM account_recovery_keys WHERE id=$1::uuid AND used_at IS NULL AND expires_at>now())`, keyID).Scan(&active); err != nil {
		return false
	}
	return active
}

func (srv *Server) rotateRecoveryKeyMemory(r *http.Request, in recoveryKeyRotationRequest, operationHash, payloadMAC string) error {
	newHash, err := hashPassword(in.NewRecoveryKey)
	if err != nil {
		return err
	}
	now := time.Now()
	srv.store.mu.Lock()
	defer srv.store.mu.Unlock()
	for hash, operation := range srv.store.authOperations {
		if !operation.ExpiresAt.After(now) {
			delete(srv.store.authOperations, hash)
		}
	}
	if operation, found := srv.store.authOperations[operationHash]; found {
		if operation.Purpose != recoveryRotationPurpose || !recoveryPayloadMACMatches(operation.PayloadMAC, payloadMAC) || operation.RecoveryKeyHash != srv.store.recoveryKeyHash {
			return errAuthOperationConflict
		}
		return nil
	}
	// Memory mode keeps the historical plaintext password representation.
	if in.Password != srv.store.userPassword {
		return errInvalidSecurityFactors
	}
	step, valid, err := validateTOTPWithStep(in.Code, srv.store.userTOTP, now)
	if err != nil || !valid {
		return errInvalidSecurityFactors
	}
	if srv.store.totpLastUsedSet && step <= srv.store.totpLastUsedStep {
		return errPasswordResetReplay
	}
	if srv.store.recoveryKeyHash == "" || srv.store.recoveryKeyUsed {
		return errInvalidRecoveryRotate
	}
	srv.store.recoveryKeyHash = newHash
	srv.store.recoveryKeyUsed = false
	srv.store.totpLastUsedStep = step
	srv.store.totpLastUsedSet = true
	currentToken := ""
	if cookie, cookieErr := r.Cookie("timeline_session"); cookieErr == nil {
		currentToken = tokenHash(cookie.Value)
	}
	for tokenHashValue, session := range srv.store.sessions {
		if tokenHashValue == currentToken {
			continue
		}
		revokedAt := now
		session.RevokedAt = &revokedAt
	}
	srv.store.authOperations[operationHash] = memoryAuthOperation{Purpose: recoveryRotationPurpose, PayloadMAC: payloadMAC, RecoveryKeyHash: newHash, ExpiresAt: now.Add(authOperationTTL)}
	return nil
}
