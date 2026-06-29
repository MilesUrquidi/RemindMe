import Anthropic from "@anthropic-ai/sdk";
import { supabase } from "./supabase";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function embed(text: string): Promise<number[]> {
  // Anthropic doesn't have an embeddings API - use text-embedding-3-small via OpenAI
  // or we generate a pseudo-embedding by hashing. For now use a simple approach:
  // We'll store messages without embeddings and do recency-based retrieval.
  // TODO: swap in an embeddings provider (OpenAI, Voyage, etc.)
  return [];
}

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
