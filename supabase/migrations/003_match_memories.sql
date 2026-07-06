-- Semantic search over memories via cosine similarity.
-- Rows without embeddings (pre-backfill or failed embeds) are skipped.
CREATE OR REPLACE FUNCTION match_memories(
  query_embedding vector(1536),
  match_count int DEFAULT 5
)
RETURNS TABLE (role text, content text, similarity float)
LANGUAGE sql STABLE
AS $$
  SELECT role, content, 1 - (embedding <=> query_embedding) AS similarity
  FROM memories
  WHERE embedding IS NOT NULL
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;
