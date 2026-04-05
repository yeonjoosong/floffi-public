package cmd

import (
	"bufio"
	"os"
	"strings"
)

// loadDotEnv reads a .env file and sets any variables not already present
// in the process environment. It silently succeeds if the file does not exist.
//
// Supported syntax:
//
//	KEY=VALUE
//	KEY="VALUE WITH SPACES"
//	KEY='VALUE'
//	# comment lines are ignored
//	blank lines are ignored
func loadDotEnv(path string) {
	f, err := os.Open(path)
	if err != nil {
		return // missing .env is fine
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}

		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)

		// Strip surrounding quotes (" or ')
		if len(value) >= 2 {
			if (value[0] == '"' && value[len(value)-1] == '"') ||
				(value[0] == '\'' && value[len(value)-1] == '\'') {
				value = value[1 : len(value)-1]
			}
		}

		// Only set if not already defined — shell env takes precedence
		if os.Getenv(key) == "" {
			_ = os.Setenv(key, value)
		}
	}
}
