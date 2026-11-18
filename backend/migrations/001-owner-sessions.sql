CREATE TABLE owner_sessions (
    token_digest text PRIMARY KEY,
    expires_at timestamptz NOT NULL
);

CREATE INDEX owner_sessions_expiry ON owner_sessions (expires_at);
