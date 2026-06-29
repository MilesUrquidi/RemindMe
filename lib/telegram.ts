const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

export async function sendMessage(chatId: string | number, text: string) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

export function parseUpdate(body: unknown): { chatId: number; text: string } | null {
  const update = body as Record<string, unknown>;
  const message = update?.message as Record<string, unknown> | undefined;
  if (!message) return null;
  const chatId = (message.chat as Record<string, unknown>)?.id as number;
  const text = message.text as string | undefined;
  if (!chatId || !text) return null;
  return { chatId, text };
}
