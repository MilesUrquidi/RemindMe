CREATE TABLE reminders (
  id BIGSERIAL PRIMARY KEY,
  chat_id BIGINT NOT NULL,
  content TEXT NOT NULL,
  due_at TIMESTAMPTZ NOT NULL,
  sent BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Fast lookup of unsent reminders that are due
CREATE INDEX ON reminders (due_at) WHERE sent = FALSE;
