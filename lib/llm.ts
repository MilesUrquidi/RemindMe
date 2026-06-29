import { createReminder, listReminders } from "./reminders";

const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const USER_TIMEZONE = "America/Los_Angeles";

// Tools Gemini is allowed to call.
const tools = [
  {
    functionDeclarations: [
      {
        name: "create_reminder",
        description: "Schedule a reminder. The bot will text the user at the given time.",
        parameters: {
          type: "object",
          properties: {
            content: { type: "string", description: "What to remind the user about" },
            due_at: { type: "string", description: "When to fire, as an ISO 8601 timestamp with timezone offset" },
          },
          required: ["content", "due_at"],
        },
      },
      {
        name: "list_reminders",
        description: "List the user's upcoming, unsent reminders.",
        parameters: { type: "object", properties: {} },
      },
    ],
  },
];

type Part = Record<string, unknown>;

async function callGemini(systemPrompt: string, contents: Part[]): Promise<Part> {
  const res = await fetch(`${GEMINI_URL}?key=${process.env.GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
      tools,
    }),
  });

  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);

  const data = await res.json();
  return data?.candidates?.[0]?.content ?? { parts: [{ text: "(no response)" }] };
}

async function runTool(chatId: number, name: string, args: Record<string, unknown>): Promise<object> {
  if (name === "create_reminder") {
    await createReminder(chatId, args.content as string, args.due_at as string);
    return { status: "scheduled", content: args.content, due_at: args.due_at };
  }
  if (name === "list_reminders") {
    return { reminders: await listReminders(chatId) };
  }
  return { error: `unknown tool ${name}` };
}

export async function chat(
  chatId: number,
  userMessage: string,
  memories: { role: string; content: string }[]
): Promise<string> {
  const contextBlock = memories.length
    ? `\n\nRecent conversation history:\n${memories.map((m) => `${m.role}: ${m.content}`).join("\n")}`
    : "";

  const now = new Date().toLocaleString("en-US", { timeZone: USER_TIMEZONE });
  const systemPrompt =
    `You are Miles's personal AI assistant, RemindMe. You live in his Telegram and help him remember things, ` +
    `stay on track, and think through problems. You know his history from past conversations.\n\n` +
    `The current time is ${now} (${USER_TIMEZONE}). When Miles asks to be reminded of something, call create_reminder ` +
    `with an absolute ISO 8601 due_at in his timezone. Resolve relative times like "in 10 minutes" or "tomorrow at 9am" ` +
    `against the current time above.${contextBlock}`;

  const contents: Part[] = [{ role: "user", parts: [{ text: userMessage }] }];

  // Allow up to 3 tool round-trips before giving up.
  for (let i = 0; i < 3; i++) {
    const content = await callGemini(systemPrompt, contents);
    const parts = (content.parts as Part[]) ?? [];
    const fnCall = parts.find((p) => p.functionCall)?.functionCall as
      | { name: string; args: Record<string, unknown> }
      | undefined;

    if (!fnCall) {
      const text = parts.find((p) => p.text)?.text as string | undefined;
      return text ?? "(no response)";
    }

    const result = await runTool(chatId, fnCall.name, fnCall.args ?? {});
    contents.push(content);
    contents.push({
      role: "user",
      parts: [{ functionResponse: { name: fnCall.name, response: result } }],
    });
  }

  return "Done.";
}

export async function dailySummary(
  memories: { role: string; content: string }[]
): Promise<string> {
  const historyBlock = memories.map((m) => `${m.role}: ${m.content}`).join("\n");

  const content = await callGemini(
    "You are Miles's personal AI assistant, RemindMe.",
    [
      {
        role: "user",
        parts: [
          {
            text: `Based on our recent conversations, send me a brief morning check-in. Mention anything I should follow up on or remember today. Keep it short and conversational.\n\nRecent history:\n${historyBlock}`,
          },
        ],
      },
    ]
  );

  const parts = (content.parts as Part[]) ?? [];
  return (parts.find((p) => p.text)?.text as string) ?? "(no response)";
}
