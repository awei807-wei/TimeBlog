package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"io"
	"os"
	"strings"
)

const configCipherVersion = "v1"

func configSecretKey() ([]byte, error) {
	raw := strings.TrimSpace(os.Getenv("CONFIG_ENCRYPTION_KEY"))
	key, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil || len(key) != 32 {
		return nil, fmt.Errorf("CONFIG_ENCRYPTION_KEY must be base64url without padding and decode to 32 bytes")
	}
	return key, nil
}

func encryptConfigSecret(scope, value string) (string, error) {
	key, err := configSecretKey()
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err = io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	ciphertext := gcm.Seal(nil, nonce, []byte(value), []byte(scope))
	payload := append(nonce, ciphertext...)
	return configCipherVersion + "." + base64.RawURLEncoding.EncodeToString(payload), nil
}

func decryptConfigSecret(scope, value string) (string, error) {
	parts := strings.SplitN(value, ".", 2)
	if len(parts) != 2 || parts[0] != configCipherVersion {
		return "", fmt.Errorf("unsupported config secret envelope")
	}
	key, err := configSecretKey()
	if err != nil {
		return "", err
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(payload) < gcm.NonceSize() {
		return "", fmt.Errorf("config secret ciphertext too short")
	}
	plain, err := gcm.Open(nil, payload[:gcm.NonceSize()], payload[gcm.NonceSize():], []byte(scope))
	if err != nil {
		return "", err
	}
	return string(plain), nil
}
