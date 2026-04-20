package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base32"
	"encoding/binary"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"
)

// TOTP (RFC 6238) helpers. Implemented against the standard library so we
// don't take a new external dependency. SHA-1 / 6-digit / 30-second period
// — the parameters Google Authenticator, Authy, 1Password, etc. default to.
const (
	totpDigits  = 6
	totpPeriod  = 30 // seconds
	totpSkew    = 1  // ±1 step tolerance for clock drift
	totpSecretL = 20 // 20 random bytes = 160 bits, matches HOTP recommendation
)

// NewTOTPSecret returns a fresh base32-encoded secret suitable for
// embedding in an otpauth URI. Base32 (no padding) is the format
// authenticator apps expect when the user types the secret manually.
func NewTOTPSecret() (string, error) {
	buf := make([]byte, totpSecretL)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("auth: read totp secret: %w", err)
	}
	return strings.TrimRight(base32.StdEncoding.EncodeToString(buf), "="), nil
}

// OtpauthURI builds the otpauth://totp/<issuer>:<account>?secret=… URI
// that authenticator apps render as a QR code.
func OtpauthURI(issuer, account, secret string) string {
	label := url.PathEscape(issuer + ":" + account)
	q := url.Values{}
	q.Set("secret", secret)
	q.Set("issuer", issuer)
	q.Set("algorithm", "SHA1")
	q.Set("digits", fmt.Sprintf("%d", totpDigits))
	q.Set("period", fmt.Sprintf("%d", totpPeriod))
	return "otpauth://totp/" + label + "?" + q.Encode()
}

// VerifyTOTP checks code against the secret, accepting ±totpSkew periods to
// tolerate small clock drift between the server and the authenticator app.
func VerifyTOTP(secret, code string) (bool, error) {
	code = strings.TrimSpace(code)
	if len(code) != totpDigits {
		return false, nil
	}
	key, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(strings.ToUpper(secret))
	if err != nil {
		return false, errors.New("auth: invalid totp secret encoding")
	}
	step := time.Now().Unix() / totpPeriod
	for d := -int64(totpSkew); d <= int64(totpSkew); d++ {
		want := generateCode(key, step+d)
		if hmac.Equal([]byte(want), []byte(code)) {
			return true, nil
		}
	}
	return false, nil
}

func generateCode(key []byte, counter int64) string {
	var buf [8]byte
	binary.BigEndian.PutUint64(buf[:], uint64(counter))
	mac := hmac.New(sha1.New, key)
	mac.Write(buf[:])
	sum := mac.Sum(nil)
	// Dynamic truncation per RFC 4226 section 5.3.
	off := sum[len(sum)-1] & 0x0f
	val := (uint32(sum[off]&0x7f) << 24) |
		(uint32(sum[off+1]) << 16) |
		(uint32(sum[off+2]) << 8) |
		uint32(sum[off+3])
	mod := uint32(1)
	for i := 0; i < totpDigits; i++ {
		mod *= 10
	}
	return fmt.Sprintf("%0*d", totpDigits, val%mod)
}

// GenerateTOTPCodeForSecret returns the current code for secret. Test-only
// helper; production never derives codes server-side outside of VerifyTOTP.
func GenerateTOTPCodeForSecret(secret string) (string, error) {
	key, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(strings.ToUpper(secret))
	if err != nil {
		return "", err
	}
	return generateCode(key, time.Now().Unix()/totpPeriod), nil
}

// ── Recovery codes ────────────────────────────────────────────────────

const recoveryCodeCount = 10

// recoveryAlphabet excludes ambiguous glyphs (0/O, 1/I) so a printed code
// is hard to misread.
const recoveryAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

// NewRecoveryCodes returns recoveryCodeCount fresh codes formatted as
// XXXX-XXXX (8 alphanumeric uppercase chars + a hyphen).
func NewRecoveryCodes() ([]string, error) {
	out := make([]string, 0, recoveryCodeCount)
	for i := 0; i < recoveryCodeCount; i++ {
		c, err := newOneCode()
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, nil
}

func newOneCode() (string, error) {
	var raw [8]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", fmt.Errorf("auth: read recovery code: %w", err)
	}
	chars := make([]byte, 8)
	for i, b := range raw {
		chars[i] = recoveryAlphabet[int(b)%len(recoveryAlphabet)]
	}
	return string(chars[:4]) + "-" + string(chars[4:]), nil
}

// NormalizeRecoveryCode strips spaces and uppercases. Hyphen is optional on
// input — the user might omit it.
func NormalizeRecoveryCode(s string) string {
	s = strings.ToUpper(strings.TrimSpace(s))
	s = strings.ReplaceAll(s, " ", "")
	if len(s) == 8 {
		s = s[:4] + "-" + s[4:]
	}
	return s
}
