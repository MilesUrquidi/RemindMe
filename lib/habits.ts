import { supabase } from "./supabase";

const USER_TIMEZONE = "America/Los_Angeles";

export async function logHabit(habit: string, note?: string): Promise<"logged" | "already_logged_today"> {
  const name = habit.toLowerCase().trim();

  // One row per habit per LA-day: mentioning the same workout twice shouldn't inflate
  // counts. Compare LA day-strings (server may run in UTC) over the last 24h of rows.
  const toDay = (d: Date | string) =>
    new Date(d).toLocaleDateString("en-CA", { timeZone: USER_TIMEZONE });
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: recent, error: selErr } = await supabase
    .from("habit_logs")
    .select("logged_at")
    .eq("habit", name)
    .gte("logged_at", dayAgo);
  if (selErr) throw new Error(`logHabit: ${selErr.message}`);
  const today = toDay(new Date());
  if ((recent ?? []).some((r) => toDay(r.logged_at) === today)) return "already_logged_today";

  const { error } = await supabase.from("habit_logs").insert({ habit: name, note });
  if (error) throw new Error(`logHabit: ${error.message}`);
  return "logged";
}

export interface HabitSummary {
  habit: string;
  count: number;
  days_active: number;
  last_logged: string;
  recent_notes: string[];
}

export async function habitSummary(days = 7): Promise<HabitSummary[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("habit_logs")
    .select("habit, note, logged_at")
    .gte("logged_at", since)
    .order("logged_at", { ascending: false });
  if (error) throw new Error(`habitSummary: ${error.message}`);

  const toDay = (iso: string) =>
    new Date(iso).toLocaleDateString("en-CA", { timeZone: USER_TIMEZONE });

  const byHabit = new Map<string, { rows: typeof data; days: Set<string> }>();
  for (const row of data ?? []) {
    const entry = byHabit.get(row.habit) ?? { rows: [], days: new Set<string>() };
    entry.rows.push(row);
    entry.days.add(toDay(row.logged_at));
    byHabit.set(row.habit, entry);
  }

  return [...byHabit.entries()].map(([habit, { rows, days }]) => ({
    habit,
    count: rows.length,
    days_active: days.size,
    last_logged: toDay(rows[0].logged_at),
    recent_notes: rows
      .map((r) => r.note)
      .filter((n): n is string => Boolean(n))
      .slice(0, 3),
  }));
}
