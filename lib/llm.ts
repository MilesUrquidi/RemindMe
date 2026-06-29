const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

async function generate(systemPrompt: string, userMessage: string): Promise<string> {
  const res = await fetch(`${GEMINI_URL}?key=${process.env.GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: userMessage }] }],
    }),
  });

  if (!res.ok) {
    throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "(no response)";
}

export async function chat(
  userMessage: string,
  memories: { role: string; content: string }[]
): Promise<string> {
  const contextBlock = memories.length
    ? `\n\nRecent conversation history:\n${memories.map((m) => `${m.role}: ${m.content}`).join("\n")}`
    : "";

  const systemPrompt = `You are Miles's personal AI assistant, RemindMe. You live in his Telegram and help him remember things, stay on track, and think through problems. You know his history from past conversations.${contextBlock}`;

  return generate(systemPrompt, userMessage);
}

export async function dailySummary(
  memories: { role: string; content: string }[]
): Promise<string> {
  const historyBlock = memories.map((m) => `${m.role}: ${m.content}`).join("\n");

  return generate(
    "You are Miles's personal AI assistant, RemindMe.",
    `Based on our recent conversations, send me a brief morning check-in. Mention anything I should follow up on or remember today. Keep it short and conversational.\n\nRecent history:\n${historyBlock}`
  );
}
