package auth

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"net/smtp"
	"os"
	"strconv"
	"time"
)

// smtpDialTimeout caps the TCP dial + TLS handshake. net/smtp.SendMail
// uses an unbounded net.Dial under the hood, so a flaky relay (closed
// port, slow STARTTLS, DNS hiccup) can hang the calling goroutine for
// the kernel's TCP timeout — minutes — without ever cancelling. We
// dial ourselves with a deadline so the request returns in seconds.
const smtpDialTimeout = 10 * time.Second

// EmailSender abstracts outbound email so dev runs print to stdout while
// prod uses SMTP (or, later, a transactional API). One method keeps the
// surface small enough to swap implementations without churn.
type EmailSender interface {
	Send(ctx context.Context, to, subject, bodyText string) error
}

// StdoutSender prints a clear "outbox" block to stdout. Default in dev so a
// fresh checkout doesn't need any env var ceremony to exercise the verify /
// reset flows. The format is deliberately copy/pasteable so the developer
// can grab the link from the terminal.
type StdoutSender struct{}

func (StdoutSender) Send(_ context.Context, to, subject, bodyText string) error {
	fmt.Println("─── outbox (stdout sender) ─────────────────────────")
	fmt.Printf(" to:      %s\n", to)
	fmt.Printf(" subject: %s\n", subject)
	fmt.Println(" body:")
	fmt.Println(bodyText)
	fmt.Println("────────────────────────────────────────────────────")
	return nil
}

// SMTPSender talks to an SMTP relay with PlainAuth. Intentionally minimal —
// the only thing we need from a transactional provider during phase 3 is the
// ability to deliver verify / reset links. HTML rendering is deferred until
// we pick a real provider with templating.
type SMTPSender struct {
	Host     string
	Port     int
	Username string
	Password string
	From     string
}

func (s SMTPSender) Send(_ context.Context, to, subject, bodyText string) error {
	if s.Host == "" || s.Port == 0 || s.From == "" {
		return errors.New("smtp: incomplete config (host/port/from required)")
	}
	addr := net.JoinHostPort(s.Host, strconv.Itoa(s.Port))
	msg := []byte("From: " + s.From + "\r\n" +
		"To: " + to + "\r\n" +
		"Subject: " + subject + "\r\n" +
		"Content-Type: text/plain; charset=UTF-8\r\n" +
		"\r\n" + bodyText + "\r\n")

	// Dial ourselves with a hard timeout so a stuck relay can't pin
	// the goroutine indefinitely. smtp.SendMail's internal net.Dial
	// has no deadline, which is what causes the "password reset just
	// hangs" symptom when Gmail's submission port misbehaves.
	conn, err := net.DialTimeout("tcp", addr, smtpDialTimeout)
	if err != nil {
		return fmt.Errorf("smtp dial %s: %w", addr, err)
	}
	c, err := smtp.NewClient(conn, s.Host)
	if err != nil {
		_ = conn.Close()
		return fmt.Errorf("smtp new client: %w", err)
	}
	defer c.Close()
	// STARTTLS for the standard 587 submission flow. Port 465 (implicit
	// TLS) isn't supported here — Gmail and most providers expose 587
	// + STARTTLS as the modern path, and dropping back to plaintext
	// would leak the App Password over the wire.
	if ok, _ := c.Extension("STARTTLS"); ok {
		if err := c.StartTLS(&tls.Config{ServerName: s.Host}); err != nil {
			return fmt.Errorf("smtp starttls: %w", err)
		}
	}
	if s.Username != "" {
		if err := c.Auth(smtp.PlainAuth("", s.Username, s.Password, s.Host)); err != nil {
			return fmt.Errorf("smtp auth: %w", err)
		}
	}
	if err := c.Mail(s.From); err != nil {
		return fmt.Errorf("smtp mail-from: %w", err)
	}
	if err := c.Rcpt(to); err != nil {
		return fmt.Errorf("smtp rcpt: %w", err)
	}
	wc, err := c.Data()
	if err != nil {
		return fmt.Errorf("smtp data: %w", err)
	}
	if _, err := wc.Write(msg); err != nil {
		_ = wc.Close()
		return fmt.Errorf("smtp write: %w", err)
	}
	if err := wc.Close(); err != nil {
		return fmt.Errorf("smtp data close: %w", err)
	}
	return c.Quit()
}

// SenderFromEnv returns an SMTPSender when FLOFFI_SMTP_HOST is set, otherwise
// a StdoutSender. Keep the selection logic in one place so the server boot,
// tests, and future CLI tools all agree on what "default" means.
func SenderFromEnv() EmailSender {
	host := os.Getenv("FLOFFI_SMTP_HOST")
	if host == "" {
		return StdoutSender{}
	}
	port := 587
	if v := os.Getenv("FLOFFI_SMTP_PORT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			port = n
		}
	}
	from := os.Getenv("FLOFFI_SMTP_FROM")
	if from == "" {
		from = "no-reply@" + host
	}
	return SMTPSender{
		Host:     host,
		Port:     port,
		Username: os.Getenv("FLOFFI_SMTP_USER"),
		Password: os.Getenv("FLOFFI_SMTP_PASS"),
		From:     from,
	}
}

// PublicBaseURL returns the URL the user-facing links should point at. The
// frontend serves /verify and /reset on the same origin as the API, so a
// single env var is enough.
func PublicBaseURL() string {
	if v := os.Getenv("FLOFFI_PUBLIC_URL"); v != "" {
		return v
	}
	return "http://localhost:8080"
}
