-- TOTP 복구 코드 저장 테이블 (Phase 4).
-- 0001_init.sql의 비어있던 recovery_codes 테이블과 충돌하지 않게 v2 접미사 사용.
-- 코드 원문은 한 번만 사용자에게 노출하고 DB에는 argon2id 해시만 보관.
CREATE TABLE IF NOT EXISTS recovery_codes_v2 (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,           -- argon2id(code)
  used_at    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recovery_codes_v2_user ON recovery_codes_v2(user_id);

-- MFA 챌린지 토큰: 로그인 1단계(비번 OK) 이후 2FA 단계 대기 상태 식별.
-- 메모리에 두지 않고 DB에 5분 TTL로 저장 -> 서버 재시작 시에도 일관.
CREATE TABLE IF NOT EXISTS mfa_challenges (
  id          TEXT PRIMARY KEY,        -- 챌린지 토큰 자체 (랜덤 base64url)
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  consumed_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_mfa_challenges_user ON mfa_challenges(user_id);

-- refresh_sessions.mfa_at: 이 세션이 마지막으로 강한 인증(MFA 또는 신선한
-- 비밀번호 재인증)을 통과한 시각. step-up 윈도우 검증에 사용. 회전 시 그대로
-- 복사되므로 refresh만으로는 갱신되지 않는다.
ALTER TABLE refresh_sessions ADD COLUMN mfa_at INTEGER NOT NULL DEFAULT 0;
