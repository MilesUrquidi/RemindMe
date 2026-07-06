import { NextRequest, NextResponse } from "next/server";
import { eveningSummary } from "@/lib/llm";
import { storeMemory } from "@/lib/memory";
import { sendMessage } from "@/lib/telegram";

// Vercel Cron invokes this with GET and an `Authorization: Bearer <CRON_SECRET>` header.
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const message = await eveningSummary();
  // Store it so Miles's reply lands in a conversation the bot remembers starting.
  await Promise.all([
    storeMemory("assistant", message),
    sendMessage(process.env.TELEGRAM_CHAT_ID!, message),
  ]);

  return NextResponse.json({ ok: true });
}
