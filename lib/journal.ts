import { supabase } from "./supabase";

const USER_TIMEZONE = "America/Los_Angeles";

export async function saveJournal(content: string) {
  const { error } = await supabase.from("journal_entries").insert({ content });
  if (error) throw new Error(`saveJournal: ${error.message}`);
}

export interface JournalEntry {
  date: string;
  content: string;
}

export async function recentJournal(days = 7): Promise<JournalEntry[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("journal_entries")
    .select("content, created_at")
    .gte("created_at", since)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`recentJournal: ${error.message}`);

  return (data ?? []).map((row) => ({
    date: new Date(row.created_at).toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      timeZone: USER_TIMEZONE,
    }),
    content: row.content,
  }));
}
