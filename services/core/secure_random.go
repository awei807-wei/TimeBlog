package main

import crand "crypto/rand"

// secureRandomRead is injectable so failure handling can be tested without
// weakening the production source of randomness.
var secureRandomRead = func(dst []byte) error {
	_, err := crand.Read(dst)
	return err
}

// mustRandomBytes returns cryptographically secure random bytes or stops the
// operation. Callers use the result for identifiers, tokens, and signing
// material, so a predictable fallback is never safe.
func mustRandomBytes(size int) []byte {
	if size < 0 {
		panic("random byte length must not be negative")
	}
	data := make([]byte, size)
	if err := secureRandomRead(data); err != nil {
		panic("cryptographic randomness unavailable")
	}
	return data
}
