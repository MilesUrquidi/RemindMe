import { supabase } from "./supabase";

const EMBED_MODEL = "gemini-embedding-001";
const EMBED_URL = `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:embedContent`;
// Must match the vector(1536) column in the memories table.
const EMBED_DIMS = 1536;

export async function embed(text: string): Promise<number[] | null> {
  try {
    const res = await fetch(`${EMBED_URL}?key=${process.env.GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `models/${EMBED_MODEL}`,
        content: { parts: [{ text }] },
        outputDimensionality: EMBED_DIMS,
      }),
    });
    if (!res.ok) throw new Error(`embed ${res.status}: ${await res.text()}`);

    const data = await res.json();
    const values: number[] | undefined = data?.embedding?.values;
    if (!values?.length) return null;

    // Gemini only returns unit-norm vectors at full 3072 dims;
    // truncated outputs must be re-normalized for cosine similarity to work.
    const norm = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
    return values.map((v) => v / norm);
  } catch (err) {
    console.error("embedding failed:", err);
    return null;
  }
}

export async function storeMemory(role: "user" | "assistant", content: string) {
  // A failed embed still stores the memory - it just won't be semantically searchable.
  const embedding = await embed(content);
  await supabase.from("memories").insert({ role, content, embedding });
}

export interface Memory {
  role: string;
  content: string;
}

export interface MemoryContext {
  /** Last messages in chronological order - sent to the model as real conversation turns. */
  recent: Memory[];
  /** Semantic matches from further back, deduped against recent - injected as system context. */
  relevant: Memory[];
}

export async function searchMemories(
  query: string,
  recentLimit = 8,
  relevantLimit = 4
): Promise<MemoryContext> {
  const [embedding, recentRes] = await Promise.all([
    query.trim() ? embed(query) : Promise.resolve(null),
    supabase
      .from("memories")
      .select("role, content")
      .order("created_at", { ascending: false })
      .limit(recentLimit),
  ]);

  // Oldest-first so the conversation reads chronologically.
  const recent = (recentRes.data ?? []).reverse();

  if (!embedding) return { recent, relevant: [] };

  const { data: matches, error } = await supabase.rpc("match_memories", {
    query_embedding: embedding,
    match_count: relevantLimit + recentLimit,
  });
  if (error) {
    console.error("match_memories failed:", error);
    return { recent, relevant: [] };
  }

  const seen = new Set(recent.map((m) => m.content));
  const relevant = (matches ?? [])
    .filter((m: { content: string }) => !seen.has(m.content))
    .slice(0, relevantLimit)
    .map((m: Memory) => ({ role: m.role, content: m.content }));

  return { recent, relevant };
}
