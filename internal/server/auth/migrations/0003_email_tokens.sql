-- 이메일 인증 / 비밀번호 재설정 토큰 저장 테이블 (Phase 3).
-- 토큰 원문은 절대 저장하지 않고 sha256 해시만 보관 -> DB 덤프 재사용 차단.
CREATE TABLE IF NOT EXISTS email_tokens (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,           -- "verify" 또는 "reset"
  token_hash TEXT NOT NULL,           -- sha256(token)
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_email_tokens_user_kind ON email_tokens(user_id, kind);
CREATE INDEX IF NOT EXISTS idx_email_tokens_hash ON email_tokens(token_hash);
