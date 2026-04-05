package cmd

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/signal"
	"syscall"

	"floffi/internal/app"

	"github.com/spf13/cobra"
)

var (
	host    string
	port    int
	envFile string
)

func init() {
	serveCmd.Flags().StringVar(&host, "host", "0.0.0.0", "host interface to bind")
	serveCmd.Flags().IntVar(&port, "port", 8080, "port to listen on")
	serveCmd.Flags().StringVar(&envFile, "env-file", "", "path to .env file to load before starting")
	rootCmd.AddCommand(serveCmd)
}

var serveCmd = &cobra.Command{
	Use:   "serve",
	Short: "Start the HTTP server",
	RunE: func(cmd *cobra.Command, args []string) error {
		// .env 로딩 정책:
		//   1) --env-file 명시 시 그 경로를 사용 (없으면 silent skip).
		//   2) 미명시 시 현재 디렉토리의 .env 를 자동 로드.
		// 자동 fallback 이 없으면 사용자가 start.sh 가 아니라 ./floffi
		// serve 를 직접 호출할 때 .env 의 SMTP/PUBLIC_URL 이 무시되어
		// stdout sender 로 떨어지는 혼란이 생긴다. 로드한 경로는 부팅
		// 로그에 한 줄로 남겨, 어느 파일이 적용됐는지(또는 아무 것도
		// 안 읽혔는지) 즉시 보이게 한다.
		switch {
		case envFile != "":
			loadDotEnv(envFile)
			fmt.Fprintf(os.Stderr, "  loaded env from %s\n", envFile)
		default:
			if _, err := os.Stat(".env"); err == nil {
				loadDotEnv(".env")
				fmt.Fprintln(os.Stderr, "  loaded env from .env (auto)")
			}
		}

		ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
		defer stop()

		addr := net.JoinHostPort(host, fmt.Sprintf("%d", port))
		return app.Run(ctx, app.Config{
			Addr:     addr,
			AuthUser: os.Getenv("FLOFFI_AUTH_USER"),
			AuthPass: os.Getenv("FLOFFI_AUTH_PASS"),
			Secret:   os.Getenv("FLOFFI_SESSION_SECRET"),
		})
	},
}
