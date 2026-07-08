import { NextRequest, NextResponse } from "next/server";
import { eveningSummary, weeklySummary } from "@/lib/llm";
import { storeMemory } from "@/lib/memory";
import { sendMessage } from "@/lib/telegram";

// Vercel Cron invokes this with GET and an `Authorization: Bearer <CRON_SECRET>` header.
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Sunday's check-in zooms out into the weekly review (Hobby allows only 2 crons,
  // so this shares the 9pm slot). `?weekly=1` forces it for manual runs/testing.
  const laWeekday = new Date().toLocaleDateString("en-US", {
    weekday: "short",
    timeZone: "America/Los_Angeles",
  });
  const isWeekly = laWeekday === "Sun" || req.nextUrl.searchParams.get("weekly") === "1";

  const message = isWeekly ? await weeklySummary() : await eveningSummary();
  // Store it so Miles's reply lands in a conversation the bot remembers starting.
  await Promise.all([
    storeMemory("assistant", message),
    sendMessage(process.env.TELEGRAM_CHAT_ID!, message),
  ]);

  return NextResponse.json({ ok: true });
}
