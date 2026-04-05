package app

import (
	"context"
	"fmt"

	"floffi/internal/server"
)

type Config struct {
	Addr     string
	AuthUser string
	AuthPass string
	Secret   string
}

// Run is the top-level application entrypoint.
func Run(ctx context.Context, cfg Config) error {
	addr := cfg.Addr
	if addr == "" {
		addr = ":8080"
	}

	srv := server.New(addr, server.AuthConfig{
		Username: cfg.AuthUser,
		Password: cfg.AuthPass,
		Secret:   cfg.Secret,
	})
	fmt.Printf("floffi listening on %s\n", addr)

	return srv.ListenAndServe(ctx)
}
