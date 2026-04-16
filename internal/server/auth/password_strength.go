package auth

// password_strength.go — Phase 6.8 strength policy for new passwords.
//
// Applied to signup and password-reset-complete. Rejects passwords
// that are too short, too monotonous (one character class only), or
// that match a small blacklist of obvious entries (the username, the
// email local-part, "password", repeated digits, etc.).
//
// We deliberately stay closer to NIST SP 800-63B's "length over
// complexity" guidance than the bank-portal habit of "must contain
// exactly one of every category" — the policy gates the WORST cases
// (a 10-char string of digits, "passwordpassword") without
// micromanaging good entries.

import (
	"errors"
	"strings"
	"unicode"
)

const (
	// MinPasswordLen is the floor — 10 chars. Below this we reject
	// outright before checking anything else.
	MinPasswordLen = 10

	// MinPasswordCharClasses is how many of the four character
	// classes (lower, upper, digit, symbol) a password must mix.
	// Two of four (e.g. lowercase + digit) is enough to keep the
	// keyspace honest without locking out users who can't type a
	// symbol on every keyboard.
	MinPasswordCharClasses = 2

	// MaxConsecutiveRepeat is how many times the same character can
	// repeat in a row before we reject. Catches "aaaaaaaaaa" /
	// "1111111111" without flagging legitimate doubles like "letter".
	MaxConsecutiveRepeat = 4
)

// ErrWeakPassword is the single sentinel surfaced to callers. The
// detailed reason is logged but not returned to the client — telling
// an attacker exactly which rule their guess violated narrows their
// search.
var ErrWeakPassword = errors.New("weak password")

// commonWeakPasswords is a tiny blacklist of patterns that show up
// over and over in credential dumps. Lowercased for comparison.
// Intentionally short: a real defense uses HIBP / a breach API; this
// is just enough to refuse the most embarrassing entries before
// argon2id even runs.
var commonWeakPasswords = map[string]struct{}{
	"password":      {},
	"password1":     {},
	"password12":    {},
	"qwerty":        {},
	"qwerty123":     {},
	"qwertyuiop":    {},
	"1234567890":    {},
	"abcdefghij":    {},
	"letmein":       {},
	"welcome":       {},
	"admin":         {},
	"administrator": {},
	"changeme":      {},
	"iloveyou":      {},
	"floffi":        {},
	"admin12345":    {},
}

// CheckPasswordStrength validates a candidate password against the
// project policy. usernameAndEmail lets the caller pass identifiers
// that must NOT appear inside the password (so "alice123" can't
// sign up with password "alice123456"). Pass empty strings if no
// identifiers are known yet.
//
// Returns nil on accept, ErrWeakPassword otherwise.
func CheckPasswordStrength(password, username, email string) error {
	if len(password) < MinPasswordLen {
		return ErrWeakPassword
	}

	// Character-class count.
	var hasLower, hasUpper, hasDigit, hasSymbol bool
	var lastRune rune
	var repeatCount int
	for i, r := range password {
		switch {
		case unicode.IsLower(r):
			hasLower = true
		case unicode.IsUpper(r):
			hasUpper = true
		case unicode.IsDigit(r):
			hasDigit = true
		case unicode.IsSpace(r):
			// Allow internal whitespace (passphrases) but it doesn't
			// count toward any class.
		default:
			// Anything else (punctuation, symbols, unicode marks).
			hasSymbol = true
		}

		// Track consecutive-same-rune runs. i==0 means lastRune is
		// the zero value; reset rather than count against it.
		if i > 0 && r == lastRune {
			repeatCount++
			if repeatCount >= MaxConsecutiveRepeat {
				return ErrWeakPassword
			}
		} else {
			repeatCount = 1
		}
		lastRune = r
	}

	classes := 0
	for _, b := range []bool{hasLower, hasUpper, hasDigit, hasSymbol} {
		if b {
			classes++
		}
	}
	if classes < MinPasswordCharClasses {
		return ErrWeakPassword
	}

	// Common-password blacklist (case-insensitive).
	lc := strings.ToLower(password)
	if _, bad := commonWeakPasswords[lc]; bad {
		return ErrWeakPassword
	}

	// Username / email local-part containment. A password that's a
	// trivial expansion of the user's handle ("alice2024") gives up
	// most of its entropy to anyone who knows the account.
	//
	// Minimum identifier length is 5 — anything shorter (rec, ab,
	// dev, etc.) collides with normal English fragments inside
	// otherwise-strong passwords ("correct-horse" trips on a 3-char
	// "rec" from the email). Five chars is roughly where an
	// identifier stops looking like a generic word fragment.
	const minIdentifierLen = 5
	if len(username) >= minIdentifierLen {
		if strings.Contains(lc, strings.ToLower(username)) {
			return ErrWeakPassword
		}
	}
	if email != "" {
		if at := strings.IndexByte(email, '@'); at > 0 {
			local := strings.ToLower(email[:at])
			if len(local) >= minIdentifierLen && strings.Contains(lc, local) {
				return ErrWeakPassword
			}
		}
	}

	return nil
}
