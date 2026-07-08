import { NextRequest, NextResponse } from "next/server";
import { parseUpdate, sendMessage, sendTyping } from "@/lib/telegram";
import { searchMemories, storeMemory } from "@/lib/memory";
import { chat } from "@/lib/llm";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const update = parseUpdate(body);

  if (!update) return NextResponse.json({ ok: true });

  const { chatId, text } = update;

  // Personal bot: only respond to Miles. Silently drop anyone else so
  // strangers can't burn quota or touch memory/habits/journal/tools.
  if (String(chatId) !== process.env.TELEGRAM_CHAT_ID) {
    return NextResponse.json({ ok: true });
  }

  sendTyping(chatId);

  try {
    const memories = await searchMemories(text);
    const reply = await chat(chatId, text, memories);

    await Promise.all([
      storeMemory("user", text),
      storeMemory("assistant", reply),
      sendMessage(chatId, reply),
    ]);
  } catch (err) {
    // Always reply and return 200: a 5xx makes Telegram re-deliver the update,
    // which would hammer the already-failing (often rate-limited) LLM call.
    console.error("telegram webhook failed:", err);
    await sendMessage(chatId, "Something went wrong on my end (probably a rate limit). Try again in a minute.");
  }

  return NextResponse.json({ ok: true });
}
