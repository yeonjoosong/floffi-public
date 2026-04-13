package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"
)

// argon2id parameters. OWASP "second-recommended" baseline (m=64MB, t=3,
// p=4). Bumping these is a backwards-compatible upgrade: the hash string
// records its own parameters, so verify() works against older hashes.
const (
	argonMemoryKiB uint32 = 64 * 1024 // 64 MB
	argonTime      uint32 = 3
	argonThreads   uint8  = 4
	argonSaltLen   uint32 = 16
	argonKeyLen    uint32 = 32
)

// ErrInvalidHash is returned when an encoded hash string can't be parsed.
var ErrInvalidHash = errors.New("invalid argon2id hash")

// Hash derives an argon2id key from password and returns the
// `$argon2id$v=19$m=...,t=...,p=...$<b64salt>$<b64hash>` encoded string.
func Hash(password string) (string, error) {
	salt := make([]byte, argonSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("auth: read salt: %w", err)
	}
	key := argon2.IDKey([]byte(password), salt, argonTime, argonMemoryKiB, argonThreads, argonKeyLen)
	encoded := fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version,
		argonMemoryKiB, argonTime, argonThreads,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key),
	)
	return encoded, nil
}

// Verify constant-time compares password against the parsed hash. Returns
// (true, nil) on match; (false, nil) on mismatch; (false, err) only on
// malformed encoded strings (so handlers don't leak "user exists" by status).
func Verify(encoded, password string) (bool, error) {
	parts := strings.Split(encoded, "$")
	// expected layout: ["", "argon2id", "v=19", "m=...,t=...,p=...", b64salt, b64hash]
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false, ErrInvalidHash
	}
	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil {
		return false, ErrInvalidHash
	}
	if version != argon2.Version {
		return false, ErrInvalidHash
	}
	var m, t uint32
	var p uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &m, &t, &p); err != nil {
		return false, ErrInvalidHash
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false, ErrInvalidHash
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return false, ErrInvalidHash
	}
	got := argon2.IDKey([]byte(password), salt, t, m, p, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1, nil
}
