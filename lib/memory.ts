import { supabase } from "./supabase";

// TODO: add semantic embeddings (Gemini text-embedding-004 is free).
// For now memory uses recency-based retrieval - the last N messages.

export async function storeMemory(role: "user" | "assistant", content: string) {
  await supabase.from("memories").insert({ role, content });
}

export async function searchMemories(query: string, limit = 5): Promise<{ role: string; content: string }[]> {
  // Recency-based fallback until embeddings are wired up
  const { data } = await supabase
    .from("memories")
    .select("role, content")
    .order("created_at", { ascending: false })
    .limit(limit * 3);

  return (data ?? []).slice(0, limit).reverse();
}
