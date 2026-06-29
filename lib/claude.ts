import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function chat(
  userMessage: string,
  memories: { role: string; content: string }[]
): Promise<string> {
  const contextBlock = memories.length
    ? `\n\nRecent conversation history:\n${memories.map((m) => `${m.role}: ${m.content}`).join("\n")}`
    : "";

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: `You are Miles's personal AI assistant, RemindMe. You live in his Telegram and help him remember things, stay on track, and think through problems. You know his history from past conversations.${contextBlock}`,
    messages: [{ role: "user", content: userMessage }],
  });

  return (response.content[0] as { type: string; text: string }).text;
}

export async function dailySummary(
  memories: { role: string; content: string }[]
): Promise<string> {
  const historyBlock = memories.map((m) => `${m.role}: ${m.content}`).join("\n");

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 512,
    system: "You are Miles's personal AI assistant, RemindMe.",
    messages: [
      {
        role: "user",
        content: `Based on our recent conversations, send me a brief morning check-in. Mention anything I should follow up on or remember today. Keep it short and conversational.\n\nRecent history:\n${historyBlock}`,
      },
    ],
  });

  return (response.content[0] as { type: string; text: string }).text;
}
