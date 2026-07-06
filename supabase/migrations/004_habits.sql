CREATE TABLE habit_logs (
  id BIGSERIAL PRIMARY KEY,
  habit TEXT NOT NULL,
  note TEXT,
  logged_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ON habit_logs (habit, logged_at);
