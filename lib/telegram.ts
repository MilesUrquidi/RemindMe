const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

// Telegram HTML supports only a small tag set (b, i, u, s, code, pre, a).
// Models drift into full HTML (<ul>, <li>, <br>) which Telegram rejects outright,
// so convert lists to bullet lines and strip every unsupported tag before sending.
function sanitizeTelegramHtml(text: string): string {
  return text
    .replace(/[ \t]*<li>\s*/gi, "• ")
    .replace(/\s*<\/li>/gi, "\n")
    .replace(/\s*<\/?(ul|ol|p|div)[^>]*>\s*/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(?!\/?(?:b|i|u|s|code|pre|a)[\s>/])[a-zA-Z][^>]*>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function sendMessage(chatId: string | number, text: string) {
  const clean = sanitizeTelegramHtml(text);
  const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: clean, parse_mode: "HTML" }),
  });

  // Malformed HTML (unescaped < > &) makes Telegram reject the message.
  // Fall back to plain text with all tags stripped so the reply always arrives readable.
  if (!res.ok) {
    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: clean.replace(/<[^>]+>/g, "") }),
    });
  }
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
