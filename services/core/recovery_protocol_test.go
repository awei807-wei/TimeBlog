package main

import (
	"encoding/base32"
	"net/url"
	"regexp"
	"testing"
	"time"

	"github.com/pquerna/otp"
	"github.com/pquerna/otp/totp"
)

func TestRecoveryTOTPProvisioningContract(t *testing.T) {
	const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
	if len(secret) != 32 || !regexp.MustCompile(`^[A-Z2-7]{32}$`).MatchString(secret) {
		t.Fatalf("TOTP secret does not use the 32-character unpadded Base32 contract: %q", secret)
	}
	decoded, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(secret)
	if err != nil {
		t.Fatalf("decode TOTP secret: %v", err)
	}
	if len(decoded) != 20 || string(decoded) != "12345678901234567890" {
		t.Fatalf("decoded TOTP secret=%q length=%d want 20 RFC test bytes", decoded, len(decoded))
	}

	result := recoveryResult(accountRecoveryRequest{NewTOTPSecret: secret})
	parsed, err := url.Parse(result.TOTPSetupURI)
	if err != nil {
		t.Fatalf("parse TOTP setup URI: %v", err)
	}
	if parsed.Scheme != "otpauth" || parsed.Host != "totp" {
		t.Fatalf("TOTP setup URI target=%s://%s want otpauth://totp", parsed.Scheme, parsed.Host)
	}
	if parsed.Path != "/"+recoveryIssuer+":"+recoveryAccount {
		t.Fatalf("TOTP setup URI label=%q want=%q", parsed.Path, "/"+recoveryIssuer+":"+recoveryAccount)
	}
	query := parsed.Query()
	if query.Get("issuer") != recoveryIssuer {
		t.Fatalf("TOTP setup URI issuer=%q want=%q", query.Get("issuer"), recoveryIssuer)
	}
	if query.Get("secret") != secret {
		t.Fatalf("TOTP setup URI secret differs from the submitted secret")
	}
	for _, parameter := range []string{"algorithm", "digits", "period"} {
		if query.Has(parameter) {
			t.Fatalf("TOTP setup URI unexpectedly overrides default %s=%q", parameter, query.Get(parameter))
		}
	}

	key, err := otp.NewKeyFromURL(result.TOTPSetupURI)
	if err != nil {
		t.Fatalf("parse TOTP setup URI with OTP client: %v", err)
	}
	if key.Type() != "totp" || key.Issuer() != recoveryIssuer || key.AccountName() != recoveryAccount || key.Secret() != secret {
		t.Fatalf("parsed OTP key type=%q issuer=%q account=%q secretMatches=%t", key.Type(), key.Issuer(), key.AccountName(), key.Secret() == secret)
	}
	if key.Algorithm() != otp.AlgorithmSHA1 || key.Digits() != otp.DigitsSix || key.Period() != 30 {
		t.Fatalf("OTP defaults algorithm=%s digits=%d period=%d want SHA1/6/30", key.Algorithm(), key.Digits(), key.Period())
	}

	code, err := totp.GenerateCodeCustom(secret, time.Now(), totp.ValidateOpts{
		Period:    30,
		Digits:    otp.DigitsSix,
		Algorithm: otp.AlgorithmSHA1,
	})
	if err != nil {
		t.Fatalf("generate SHA1/6/30 TOTP: %v", err)
	}
	if !totp.Validate(code, secret) {
		t.Fatal("backend default TOTP verifier rejected the URI default SHA1/6/30 code")
	}
}
