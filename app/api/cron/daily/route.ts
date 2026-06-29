import { NextRequest, NextResponse } from "next/server";
import { searchMemories } from "@/lib/memory";
import { dailySummary } from "@/lib/llm";
import { sendMessage } from "@/lib/telegram";

// Vercel Cron invokes this with GET and an `Authorization: Bearer <CRON_SECRET>` header.
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const memories = await searchMemories("", 15);
  const message = await dailySummary(memories);
  await sendMessage(process.env.TELEGRAM_CHAT_ID!, message);

  return NextResponse.json({ ok: true });
}
