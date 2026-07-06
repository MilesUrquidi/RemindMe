// One-off: embed all memories that don't have an embedding yet.
// Run: node --env-file=.env.local scripts/backfill-embeddings.mjs
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const EMBED_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent";

async function embed(text) {
  const res = await fetch(`${EMBED_URL}?key=${process.env.GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "models/gemini-embedding-001",
      content: { parts: [{ text }] },
      outputDimensionality: 1536,
    }),
  });
  if (!res.ok) throw new Error(`embed ${res.status}: ${await res.text()}`);
  const values = (await res.json()).embedding.values;
  const norm = Math.sqrt(values.reduce((s, v) => s + v * v, 0));
  return values.map((v) => v / norm);
}

const { data: rows, error } = await supabase
  .from("memories")
  .select("id, content")
  .is("embedding", null);
if (error) throw error;

console.log(`${rows.length} memories to backfill`);

for (const [i, row] of rows.entries()) {
  const embedding = await embed(row.content);
  const { error: upErr } = await supabase
    .from("memories")
    .update({ embedding })
    .eq("id", row.id);
  if (upErr) throw upErr;
  console.log(`${i + 1}/${rows.length} id=${row.id}`);
  await new Promise((r) => setTimeout(r, 700)); // stay under free-tier RPM
}

console.log("done");
