package main

import (
	"crypto/rand"
	"encoding/base64"
	"testing"
)

func TestConfigSecretEnvelopeUsesIndependentKeyAndAAD(t *testing.T) {
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CONFIG_ENCRYPTION_KEY", base64.RawURLEncoding.EncodeToString(key))
	ciphertext, err := encryptConfigSecret("integration:external_image_host:token", "secret-token")
	if err != nil {
		t.Fatal(err)
	}
	if ciphertext == "secret-token" {
		t.Fatal("secret stored as plaintext")
	}
	plain, err := decryptConfigSecret("integration:external_image_host:token", ciphertext)
	if err != nil || plain != "secret-token" {
		t.Fatalf("round trip failed: %q %v", plain, err)
	}
	if _, err := decryptConfigSecret("integration:other:token", ciphertext); err == nil {
		t.Fatal("ciphertext decrypted under the wrong scope")
	}
}

func TestConfigSecretKeyRejectsMissingOrWrongLength(t *testing.T) {
	t.Setenv("CONFIG_ENCRYPTION_KEY", "")
	if _, err := encryptConfigSecret("scope", "value"); err == nil {
		t.Fatal("missing key accepted")
	}
	t.Setenv("CONFIG_ENCRYPTION_KEY", base64.RawURLEncoding.EncodeToString([]byte("short")))
	if _, err := encryptConfigSecret("scope", "value"); err == nil {
		t.Fatal("short key accepted")
	}
}
