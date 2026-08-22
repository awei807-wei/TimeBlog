package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/pquerna/otp"
	"github.com/pquerna/otp/totp"
)

const (
	passwordResetChallengePurpose = "password_reset"
	totpOperationPurpose          = "totp_password_reset"
	recoveryRotationPurpose       = "recovery_key_rotation"
	totpPeriodSeconds             = int64(30)
)

var (
	errInvalidPasswordReset   = errors.New("invalid password reset request")
	errPasswordResetReplay    = errors.New("password reset TOTP replay")
	errInvalidSecurityFactors = errors.New("invalid security factors")
	errInvalidRecoveryRotate  = errors.New("invalid recovery key rotation request")
)

type totpPasswordResetStartRequest struct{}

type totpPasswordResetCompleteRequest struct {
	Challenge      string `json:"challenge"`
	Code           string `json:"code"`
	NewPassword    string `json:"newPassword"`
	OperationToken string `json:"operationToken"`
}

type passwordChangeRequest struct {
	CurrentPassword string `json:"currentPassword"`
	Code            string `json:"code"`
	NewPassword     string `json:"newPassword"`
}

type recoveryKeyRotationRequest struct {
	Password       string `json:"password"`
	Code           string `json:"code"`
	OperationToken string `json:"operationToken"`
	NewRecoveryKey string `json:"newRecoveryKey"`
}

type ownerAuthFactors struct {
	ID            string
	PasswordHash  string
	TOTPEncrypted string
}

func (in *totpPasswordResetCompleteRequest) normalizeAndValidate() error {
	in.Challenge = strings.TrimSpace(in.Challenge)
	in.Code = strings.TrimSpace(in.Code)
	in.OperationToken = strings.TrimSpace(in.OperationToken)
	if !validOpaqueRecoveryToken(in.Challenge) || !validOpaqueRecoveryToken(in.OperationToken) {
		return errInvalidPasswordReset
	}
	if err := validateNewPassword(in.NewPassword); err != nil {
		return errInvalidPasswordReset
	}
	if !validTOTPCode(in.Code) {
		return errInvalidPasswordReset
	}
	return nil
}

func (in *passwordChangeRequest) normalizeAndValidate() error {
	in.Code = strings.TrimSpace(in.Code)
	if err := validateNewPassword(in.NewPassword); err != nil || strings.TrimSpace(in.CurrentPassword) == "" {
		return errInvalidSecurityFactors
	}
	if !validTOTPCode(in.Code) {
		return errInvalidSecurityFactors
	}
	return nil
}

func (in *recoveryKeyRotationRequest) normalizeAndValidate() error {
	in.Code = strings.TrimSpace(in.Code)
	in.OperationToken = strings.TrimSpace(in.OperationToken)
	in.NewRecoveryKey = strings.TrimSpace(in.NewRecoveryKey)
	if strings.TrimSpace(in.Password) == "" || !validTOTPCode(in.Code) ||
		!validOpaqueRecoveryToken(in.OperationToken) || !validOpaqueRecoveryToken(in.NewRecoveryKey) {
		return errInvalidRecoveryRotate
	}
	return nil
}

func validateNewPassword(value string) error {
	if len(value) < 12 || len(value) > 1024 {
		return errors.New("invalid password length")
	}
	return nil
}

func validTOTPCode(value string) bool {
	if len(value) != 6 {
		return false
	}
	for _, digit := range value {
		if digit < '0' || digit > '9' {
			return false
		}
	}
	return true
}

func validOpaqueRecoveryToken(value string) bool {
	decoded, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(value))
	return err == nil && len(decoded) == 32
}

func generatePasswordResetChallenge() (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

func operationPayloadMAC(key []byte, domain string, values ...string) string {
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte("timeblog/operation/" + domain))
	for _, value := range values {
		var size [8]byte
		binary.BigEndian.PutUint64(size[:], uint64(len(value)))
		_, _ = mac.Write(size[:])
		_, _ = mac.Write([]byte(value))
	}
	return fmt.Sprintf("%x", mac.Sum(nil))
}

func totpStepForTime(now time.Time) int64 {
	return now.UTC().Unix() / totpPeriodSeconds
}

func validateTOTPWithStep(code, secret string, now time.Time) (int64, bool, error) {
	code = strings.TrimSpace(code)
	if !validTOTPCode(code) {
		return 0, false, nil
	}
	current := totpStepForTime(now)
	for _, offset := range []int64{0, -1, 1} {
		step := current + offset
		if step < 0 {
			continue
		}
		expected, err := totp.GenerateCodeCustom(secret, time.Unix(step*totpPeriodSeconds, 0).UTC(), totp.ValidateOpts{
			Period:    uint(totpPeriodSeconds),
			Skew:      0,
			Digits:    otp.DigitsSix,
			Algorithm: otp.AlgorithmSHA1,
		})
		if err != nil {
			return 0, false, err
		}
		if subtle.ConstantTimeCompare([]byte(expected), []byte(code)) == 1 {
			// Persist the step that actually produced the accepted code.  This
			// is important when the one-step clock skew accepts the next code:
			// recording current would allow that same code to be replayed once
			// the server clock reaches its step.
			return step, true, nil
		}
	}
	return 0, false, nil
}

func namespacedOperationHash(purpose, token string) string {
	sum := sha256.Sum256([]byte(purpose + ":" + token))
	return fmt.Sprintf("%x", sum[:])
}
