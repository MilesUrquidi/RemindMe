import { supabase } from "./supabase";

const USER_TIMEZONE = "America/Los_Angeles";

export async function logHabit(habit: string, note?: string) {
  const { error } = await supabase
    .from("habit_logs")
    .insert({ habit: habit.toLowerCase().trim(), note });
  if (error) throw new Error(`logHabit: ${error.message}`);
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
