package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

var (
	errLoginChallengeInvalid = errors.New("invalid or expired login MFA challenge")
	errLoginTOTPInvalid      = errors.New("invalid login TOTP")
	errLoginTOTPReplay       = errors.New("login TOTP replay")
)

type loginSessionResult struct {
	Token string
	CSRF  string
}

// constantTimePasswordEqual compares fixed-size password digests. Hashing
// both inputs first avoids the length-dependent early return of comparing the
// memory-mode plaintext strings directly.
func constantTimePasswordEqual(candidate, expected string) bool {
	candidateDigest := sha256.Sum256([]byte(candidate))
	expectedDigest := sha256.Sum256([]byte(expected))
	return subtle.ConstantTimeCompare(candidateDigest[:], expectedDigest[:]) == 1
}

func (srv *Server) completeLoginTOTPPersistent(ctx context.Context, challenge, code string) (result loginSessionResult, err error) {
	tx, err := srv.store.database.BeginTx(ctx, nil)
	if err != nil {
		return result, fmt.Errorf("begin login TOTP transaction: %w", err)
	}
	defer tx.Rollback()

	var expiresAt time.Time
	err = tx.QueryRowContext(ctx, `SELECT expires_at FROM mfa_challenges
		WHERE token_hash=$1 AND purpose='login' FOR UPDATE`, tokenHash(challenge)).Scan(&expiresAt)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && !expiresAt.After(time.Now())) {
		return result, errLoginChallengeInvalid
	}
	if err != nil {
		return result, fmt.Errorf("load login MFA challenge: %w", err)
	}

	factors, err := loadOwnerAuthFactors(ctx, tx, true)
	if err != nil {
		return result, fmt.Errorf("load owner TOTP factor: %w", err)
	}
	lastStep, err := loadAndLockTOTPReplayStep(ctx, tx, tx, factors.ID)
	if err != nil {
		return result, err
	}
	plain, err := decryptSecret(factors.TOTPEncrypted)
	if err != nil {
		return result, errLoginTOTPInvalid
	}
	step, valid, err := validateTOTPWithStep(code, plain, time.Now())
	if err != nil {
		return result, errLoginTOTPInvalid
	}
	if !valid {
		return result, errLoginTOTPInvalid
	}
	if step <= lastStep {
		return result, errLoginTOTPReplay
	}
	if err = updateTOTPReplayStep(ctx, tx, factors.ID, step); err != nil {
		return result, err
	}

	var consumed bool
	err = tx.QueryRowContext(ctx, `DELETE FROM mfa_challenges
		WHERE token_hash=$1 AND purpose='login' AND expires_at>clock_timestamp() RETURNING true`, tokenHash(challenge)).Scan(&consumed)
	if errors.Is(err, sql.ErrNoRows) {
		return result, errLoginChallengeInvalid
	}
	if err != nil {
		return result, fmt.Errorf("consume login MFA challenge: %w", err)
	}
	if !consumed {
		return result, errLoginChallengeInvalid
	}

	result.Token = randomToken()
	result.CSRF = csrfToken(srv.store.csrfKey, result.Token)
	now := time.Now()
	if _, err = tx.ExecContext(ctx, `INSERT INTO sessions(id,user_id,token_hash,csrf_token_hash,last_seen,idle_expires,absolute_expires)
		VALUES(gen_random_uuid(),$1::uuid,$2,$3,$4,$5,$6)`, factors.ID, tokenHash(result.Token), tokenHash(result.CSRF), now, now.Add(30*24*time.Hour), now.Add(90*24*time.Hour)); err != nil {
		return loginSessionResult{}, fmt.Errorf("create login session: %w", err)
	}
	if err = tx.Commit(); err != nil {
		return loginSessionResult{}, fmt.Errorf("commit login TOTP transaction: %w", err)
	}
	return result, nil
}

func (srv *Server) completeLoginTOTPMemory(challenge, code string, now time.Time) (result loginSessionResult, err error) {
	srv.store.mu.Lock()
	defer srv.store.mu.Unlock()

	challengeHash := tokenHash(challenge)
	mfaChallenge, exists := srv.store.mfaChallenges[challengeHash]
	if !exists || mfaChallenge.ChallengeHash != challengeHash || mfaChallenge.Purpose != "login" || !mfaChallenge.ExpiresAt.After(now) {
		return result, errLoginChallengeInvalid
	}
	step, valid, err := validateTOTPWithStep(code, srv.store.userTOTP, now)
	if err != nil || !valid {
		return result, errLoginTOTPInvalid
	}
	if srv.store.totpLastUsedSet && step <= srv.store.totpLastUsedStep {
		return result, errLoginTOTPReplay
	}

	// Prepare every random value before mutating the guard or consuming the
	// challenge, so a fail-closed random source cannot leave a partial state.
	result.Token = randomToken()
	result.CSRF = csrfToken(srv.store.csrfKey, result.Token)
	sessionID := newID()
	srv.store.totpLastUsedStep = step
	srv.store.totpLastUsedSet = true
	delete(srv.store.mfaChallenges, challengeHash)
	srv.store.sessions[tokenHash(result.Token)] = &Session{
		ID:              sessionID,
		TokenHash:       tokenHash(result.Token),
		CreatedAt:       now,
		LastSeen:        now,
		IdleExpires:     now.Add(30 * 24 * time.Hour),
		AbsoluteExpires: now.Add(90 * 24 * time.Hour),
		CSRFToken:       result.CSRF,
	}
	return result, nil
}
