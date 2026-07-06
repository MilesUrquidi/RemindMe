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

export async function searchMemories(
  query: string,
  limit = 5
): Promise<{ role: string; content: string }[]> {
  const [embedding, recentRes] = await Promise.all([
    query.trim() ? embed(query) : Promise.resolve(null),
    supabase
      .from("memories")
      .select("role, content")
      .order("created_at", { ascending: false })
      .limit(limit),
  ]);

  // Oldest-first so the conversation reads chronologically.
  const recent = (recentRes.data ?? []).reverse();

  if (!embedding) return recent;

  const { data: relevant, error } = await supabase.rpc("match_memories", {
    query_embedding: embedding,
    match_count: limit,
  });
  if (error) {
    console.error("match_memories failed:", error);
    return recent;
  }

  // Semantically relevant memories first, then recent context; dedupe by content.
  const seen = new Set(recent.map((m) => m.content));
  const merged = (relevant ?? [])
    .filter((m: { content: string }) => !seen.has(m.content))
    .map((m: { role: string; content: string }) => ({ role: m.role, content: m.content }));

  return [...merged, ...recent];
}
