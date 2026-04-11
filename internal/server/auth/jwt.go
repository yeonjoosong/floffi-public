package auth

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const defaultAccessTokenTTL = 9 * time.Hour

func AccessTokenTTL() time.Duration {
	raw := strings.TrimSpace(os.Getenv("FLOFFI_SESSION_TTL"))
	if raw == "" {
		return defaultAccessTokenTTL
	}
	d, err := time.ParseDuration(raw)
	if err != nil || d <= 0 {
		return defaultAccessTokenTTL
	}
	return d
}

const RefreshTokenTTL = 7 * 24 * time.Hour

type AccessClaims struct {
	SessionID string `json:"sid"`
	MFAAt     int64  `json:"mfa_at,omitempty"`
	jwt.RegisteredClaims
}

var (
	devSigningKeyOnce sync.Once
	devSigningKey     []byte
	devSigningKeyErr  error
)

func loadEphemeralDevSigningKey() ([]byte, error) {
	devSigningKeyOnce.Do(func() {
		buf := make([]byte, 32)
		if _, err := rand.Read(buf); err != nil {
			devSigningKeyErr = fmt.Errorf("auth: dev jwt key random: %w", err)
			return
		}
		devSigningKey = buf
	})
	return devSigningKey, devSigningKeyErr
}

// jwtSigningKey returns the HS256 signing key. Production must provide
// FLOFFI_JWT_SECRET. Local development falls back to an in-memory random key,
// which avoids predictable signing material while still keeping `go run` easy.
func jwtSigningKey() ([]byte, error) {
	raw := os.Getenv("FLOFFI_JWT_SECRET")
	if raw == "" {
		if os.Getenv("FLOFFI_PROD") == "1" {
			return nil, errors.New("auth: FLOFFI_JWT_SECRET is required when FLOFFI_PROD=1")
		}
		return loadEphemeralDevSigningKey()
	}
	if decoded, err := base64.StdEncoding.DecodeString(raw); err == nil && len(decoded) >= 32 {
		return decoded, nil
	}
	if len(raw) >= 32 {
		return []byte(raw), nil
	}
	return nil, errors.New("auth: FLOFFI_JWT_SECRET must be ≥32 bytes (raw or base64)")
}

func IssueAccess(userID, sessionID string) (string, error) {
	return IssueAccessWithMFA(userID, sessionID, time.Now().Unix())
}

func IssueAccessWithMFA(userID, sessionID string, mfaAt int64) (string, error) {
	key, err := jwtSigningKey()
	if err != nil {
		return "", err
	}
	now := time.Now()
	claims := AccessClaims{
		SessionID: sessionID,
		MFAAt:     mfaAt,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   userID,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(AccessTokenTTL())),
			NotBefore: jwt.NewNumericDate(now.Add(-30 * time.Second)),
		},
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, err := tok.SignedString(key)
	if err != nil {
		return "", fmt.Errorf("auth: sign jwt: %w", err)
	}
	return signed, nil
}

func ParseAccess(tokenStr string) (*AccessClaims, error) {
	key, err := jwtSigningKey()
	if err != nil {
		return nil, err
	}
	claims := &AccessClaims{}
	_, err = jwt.ParseWithClaims(tokenStr, claims, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("auth: unexpected signing method: %v", t.Header["alg"])
		}
		return key, nil
	})
	if err != nil {
		return nil, err
	}
	return claims, nil
}
