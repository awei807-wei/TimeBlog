package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base32"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"net/url"
	"strings"
	"time"
)

const (
	recoveryOperationTTL = 24 * time.Hour
	recoveryIssuer       = "个人时间线"
	recoveryAccount      = "owner"
)

var (
	errInvalidRecoveryKey        = errors.New("invalid recovery key")
	errRecoveryOperationConflict = errors.New("recovery operation token conflict")
)

type accountRecoveryRequest struct {
	RecoveryKey    string `json:"recoveryKey"`
	NewPassword    string `json:"newPassword"`
	OperationToken string `json:"operationToken"`
	NewRecoveryKey string `json:"newRecoveryKey"`
	NewTOTPSecret  string `json:"newTotpSecret"`
}

type accountRecoveryResult struct {
	RecoveryKey  string `json:"recoveryKey"`
	TOTPSetupURI string `json:"totpSetupURI"`
}

func (in *accountRecoveryRequest) normalizeAndValidate() error {
	// CLI output is newline terminated so the file is safe to inspect with
	// ordinary text tools. Remove only line endings: older bootstrap secrets
	// may legitimately contain leading or trailing spaces.
	in.RecoveryKey = strings.TrimRight(in.RecoveryKey, "\r\n")
	in.OperationToken = strings.TrimSpace(in.OperationToken)
	in.NewRecoveryKey = strings.TrimSpace(in.NewRecoveryKey)
	in.NewTOTPSecret = strings.ToUpper(strings.TrimSpace(in.NewTOTPSecret))
	if strings.TrimSpace(in.RecoveryKey) == "" || len(in.NewPassword) < 12 || len(in.NewPassword) > 1024 {
		return errors.New("invalid account recovery fields")
	}
	if !validRecoveryRandomToken(in.OperationToken) || !validRecoveryRandomToken(in.NewRecoveryKey) {
		return errors.New("invalid account recovery random token")
	}
	decoded, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(in.NewTOTPSecret)
	if err != nil || len(decoded) != 20 {
		return errors.New("invalid TOTP secret")
	}
	return nil
}

func validRecoveryRandomToken(value string) bool {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	return err == nil && len(decoded) == 32
}

func recoveryOperationHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func recoveryOperationMACKey(base []byte) []byte {
	mac := hmac.New(sha256.New, base)
	_, _ = mac.Write([]byte("timeblog/account-recovery-operation/v1"))
	return mac.Sum(nil)
}

func recoveryPayloadMAC(key []byte, in accountRecoveryRequest) string {
	mac := hmac.New(sha256.New, key)
	for _, value := range []string{
		in.RecoveryKey,
		in.NewPassword,
		in.OperationToken,
		in.NewRecoveryKey,
		in.NewTOTPSecret,
	} {
		var size [8]byte
		binary.BigEndian.PutUint64(size[:], uint64(len(value)))
		_, _ = mac.Write(size[:])
		_, _ = mac.Write([]byte(value))
	}
	return hex.EncodeToString(mac.Sum(nil))
}

func recoveryPayloadMACMatches(left, right string) bool {
	return hmac.Equal([]byte(left), []byte(right))
}

func recoveryTOTPSetupURI(secret string) string {
	setup := &url.URL{Scheme: "otpauth", Host: "totp", Path: "/" + recoveryIssuer + ":" + recoveryAccount}
	query := setup.Query()
	query.Set("secret", secret)
	query.Set("issuer", recoveryIssuer)
	setup.RawQuery = query.Encode()
	return setup.String()
}

func recoveryResult(in accountRecoveryRequest) accountRecoveryResult {
	return accountRecoveryResult{RecoveryKey: in.NewRecoveryKey, TOTPSetupURI: recoveryTOTPSetupURI(in.NewTOTPSecret)}
}
