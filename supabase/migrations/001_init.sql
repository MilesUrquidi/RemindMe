CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE memories (
  id BIGSERIAL PRIMARY KEY,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding vector(1536),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ON memories USING hnsw (embedding vector_cosine_ops);
