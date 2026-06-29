import { NextRequest, NextResponse } from "next/server";
import { searchMemories } from "@/lib/memory";
import { dailySummary } from "@/lib/claude";
import { sendMessage } from "@/lib/telegram";

export async function POST(req: NextRequest) {
  const secret = req.headers.get("x-cron-secret");
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const memories = await searchMemories("", 15);
  const message = await dailySummary(memories);
  await sendMessage(process.env.TELEGRAM_CHAT_ID!, message);

  return NextResponse.json({ ok: true });
}
