package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"io"
)

func secretKey() ([]byte, error) {
	raw := getenv("TOTP_ENCRYPTION_KEY", "")
	b, err := base64.RawStdEncoding.DecodeString(raw)
	if err != nil || len(b) != 32 {
		return nil, fmt.Errorf("TOTP_ENCRYPTION_KEY must be base64url 32 bytes")
	}
	return b, nil
}
func encryptSecret(v string) (string, error) {
	k, e := secretKey()
	if e != nil {
		return "", e
	}
	b, e := aes.NewCipher(k)
	if e != nil {
		return "", e
	}
	g, e := cipher.NewGCM(b)
	if e != nil {
		return "", e
	}
	nonce := make([]byte, g.NonceSize())
	if _, e = io.ReadFull(rand.Reader, nonce); e != nil {
		return "", e
	}
	out := g.Seal(nonce, nonce, []byte(v), nil)
	return base64.RawStdEncoding.EncodeToString(out), nil
}
func decryptSecret(v string) (string, error) {
	k, e := secretKey()
	if e != nil {
		return "", e
	}
	raw, e := base64.RawStdEncoding.DecodeString(v)
	if e != nil {
		return "", e
	}
	b, e := aes.NewCipher(k)
	if e != nil {
		return "", e
	}
	g, e := cipher.NewGCM(b)
	if e != nil {
		return "", e
	}
	n := g.NonceSize()
	if len(raw) < n {
		return "", fmt.Errorf("secret ciphertext too short")
	}
	out, e := g.Open(nil, raw[:n], raw[n:], nil)
	return string(out), e
}
