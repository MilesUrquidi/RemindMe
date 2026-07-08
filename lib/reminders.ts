import { supabase } from "./supabase";

export async function createReminder(chatId: number, content: string, dueAt: string) {
  await supabase.from("reminders").insert({ chat_id: chatId, content, due_at: dueAt });
}

export async function listReminders(
  chatId: number
): Promise<{ id: number; content: string; due_at: string }[]> {
  const { data } = await supabase
    .from("reminders")
    .select("id, content, due_at")
    .eq("chat_id", chatId)
    .eq("sent", false)
    .order("due_at", { ascending: true });

  return data ?? [];
}

export async function cancelReminder(chatId: number, id: number): Promise<boolean> {
  const { data } = await supabase
    .from("reminders")
    .delete()
    .eq("id", id)
    .eq("chat_id", chatId)
    .eq("sent", false)
    .select("id");
  return (data ?? []).length > 0;
}

export async function dueReminders(): Promise<{ id: number; chat_id: number; content: string }[]> {
  const { data } = await supabase
    .from("reminders")
    .select("id, chat_id, content")
    .eq("sent", false)
    .lte("due_at", new Date().toISOString());

  return data ?? [];
}

export async function markSent(id: number) {
  await supabase.from("reminders").update({ sent: true }).eq("id", id);
}
