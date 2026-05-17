-- 0002_auth.sql
-- Magic-link based authentication.
--
-- Tables:
--   auth_allowlist    — invited emails (owner self-promote on first login)
--   auth_login_tokens — short-lived magic-link tokens, single use
--   auth_sessions     — long-lived cookie-backed sessions
--
-- Existing `users` table gets a `role` column ('owner' | 'member') so we can
-- gate /api/v1/members endpoints to owner-only.

-- ── users.role ──────────────────────────────────────────────────────────────
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member';

-- ── auth_allowlist ──────────────────────────────────────────────────────────
CREATE TABLE auth_allowlist (
  email              TEXT PRIMARY KEY,
  role               TEXT NOT NULL DEFAULT 'member',
  invited_by_user_id TEXT,
  created_at         INTEGER NOT NULL
);

-- ── auth_login_tokens ───────────────────────────────────────────────────────
-- Token raw value is never stored; only sha256(token).
CREATE TABLE auth_login_tokens (
  token_sha256  TEXT PRIMARY KEY,
  email         TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  consumed_at   INTEGER
);
CREATE INDEX idx_auth_login_tokens_email_created ON auth_login_tokens(email, created_at DESC);

-- ── auth_sessions ───────────────────────────────────────────────────────────
-- Cookie carries raw session token; DB stores sha256.
CREATE TABLE auth_sessions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  token_sha256  TEXT NOT NULL UNIQUE,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  user_agent    TEXT,
  ip            TEXT
);
CREATE INDEX idx_auth_sessions_user ON auth_sessions(user_id, last_seen_at DESC);
CREATE INDEX idx_auth_sessions_expires ON auth_sessions(expires_at);
