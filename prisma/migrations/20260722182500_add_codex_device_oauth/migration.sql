-- Instance-global ChatGPT/Codex subscription credentials and restart-safe
-- device authorization flows. Credential and code columns contain Recat's
-- AES-256-GCM envelope; raw session tokens are represented only by SHA-256.

CREATE TYPE "CodexDeviceFlowState" AS ENUM (
  'pending',
  'polling',
  'authorized',
  'completed',
  'cancelled',
  'expired',
  'failed'
);

CREATE TABLE "ai_codex_credentials" (
  "singleton"         BOOLEAN NOT NULL DEFAULT TRUE,
  "encrypted_payload" TEXT NOT NULL,
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ai_codex_credentials_pkey" PRIMARY KEY ("singleton"),
  CONSTRAINT "ai_codex_credentials_singleton_check" CHECK ("singleton")
);

CREATE TABLE "ai_codex_device_flows" (
  "id"                     TEXT NOT NULL,
  "admin_user_id"          TEXT NOT NULL,
  "session_hash"           CHAR(64) NOT NULL,
  "device_auth_id_enc"     TEXT,
  "user_code_enc"          TEXT,
  "authorization_code_enc" TEXT,
  "code_verifier_enc"      TEXT,
  "interval_ms"            INTEGER NOT NULL,
  "expires_at"             TIMESTAMP(3) NOT NULL,
  "next_poll_at"           TIMESTAMP(3) NOT NULL,
  "state"                  "CodexDeviceFlowState" NOT NULL DEFAULT 'pending',
  "failure_code"           VARCHAR(100),
  "created_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"             TIMESTAMP(3) NOT NULL,
  "completed_at"           TIMESTAMP(3),

  CONSTRAINT "ai_codex_device_flows_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_codex_device_flows_interval_check"
    CHECK ("interval_ms" BETWEEN 1000 AND 60000),
  CONSTRAINT "ai_codex_device_flows_admin_user_id_fkey"
    FOREIGN KEY ("admin_user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "idx_ai_codex_flows_owner_state"
  ON "ai_codex_device_flows"("admin_user_id", "session_hash", "state");

CREATE INDEX "idx_ai_codex_flows_expiry"
  ON "ai_codex_device_flows"("expires_at");
