import { NextRequest, NextResponse } from "next/server";
import { parseUpdate, sendMessage } from "@/lib/telegram";
import { searchMemories, storeMemory } from "@/lib/memory";
import { chat } from "@/lib/claude";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const update = parseUpdate(body);

  if (!update) return NextResponse.json({ ok: true });

  const { chatId, text } = update;

  const memories = await searchMemories(text);
  const reply = await chat(text, memories);

  await Promise.all([
    storeMemory("user", text),
    storeMemory("assistant", reply),
    sendMessage(chatId, reply),
  ]);

  return NextResponse.json({ ok: true });
}
