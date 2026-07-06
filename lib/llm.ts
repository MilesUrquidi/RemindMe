import { createReminder, listReminders } from "./reminders";
import { listEvents, createEvent } from "./calendar";

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
      {
        name: "list_events",
        description: "List upcoming events from Miles's Apple Calendar.",
        parameters: {
          type: "object",
          properties: {
            days: { type: "number", description: "How many days ahead to look (default: 7)" },
          },
        },
      },
      {
        name: "create_event",
        description: "Create a new event in Miles's Apple Calendar.",
        parameters: {
          type: "object",
          properties: {
            summary: { type: "string", description: "Event title" },
            start: { type: "string", description: "Start time as ISO 8601 with timezone offset" },
            end: { type: "string", description: "End time as ISO 8601 with timezone offset" },
            description: { type: "string", description: "Optional notes for the event" },
            location: { type: "string", description: "Optional location" },
          },
          required: ["summary", "start", "end"],
        },
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

// Models are unreliable at deriving weekdays from dates, so compute them in code
// and hand the model a ready-to-use "when" string.
function formatClock(iso: string): string | null {
  if (!iso.includes("T")) return null;

  if (iso.endsWith("Z")) {
    // UTC timestamp: convert the clock to the user's timezone
    return new Date(iso).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: USER_TIMEZONE,
    });
  }

  // Floating local time: keep the clock as written
  const [hh, mm] = iso.slice(11, 16).split(":").map(Number);
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}:${String(mm).padStart(2, "0")} ${hh < 12 ? "AM" : "PM"}`;
}

function formatEventTime(start: string, end: string): string {
  let dayPart: string;
  if (start.endsWith("Z")) {
    // UTC timestamp: the date can shift when converted, so derive it in the user's timezone
    dayPart = new Date(start).toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      timeZone: USER_TIMEZONE,
    });
  } else {
    const [y, m, d] = start.slice(0, 10).split("-").map(Number);
    dayPart = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  }

  const startClock = formatClock(start);
  if (!startClock) return `${dayPart} (all day)`;

  const endClock = end && end !== start ? formatClock(end) : null;
  return endClock
    ? `${dayPart}, ${startClock} - ${endClock}`
    : `${dayPart}, ${startClock}`;
}

async function runTool(chatId: number, name: string, args: Record<string, unknown>): Promise<object> {
  if (name === "create_reminder") {
    await createReminder(chatId, args.content as string, args.due_at as string);
    return { status: "scheduled", content: args.content, due_at: args.due_at };
  }
  if (name === "list_reminders") {
    return { reminders: await listReminders(chatId) };
  }
  if (name === "list_events") {
    const events = await listEvents((args.days as number) ?? 7);
    return {
      events: events.map((e) => ({ ...e, when: formatEventTime(e.start, e.end) })),
      note: "The 'when' field is pre-computed and correct - use it verbatim for dates, weekdays, and start/end times.",
    };
  }
  if (name === "create_event") {
    await createEvent(
      args.summary as string,
      args.start as string,
      args.end as string,
      args.description as string | undefined,
      args.location as string | undefined
    );
    return { status: "created", summary: args.summary, start: args.start };
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

  const now = new Date().toLocaleString("en-US", {
    timeZone: USER_TIMEZONE,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const systemPrompt =
    `You are RemindMe, Miles's personal AI assistant living in his Telegram.\n\n` +
    `## Who Miles is\n` +
    `Miles Urquidi is a software engineering student at UC Irvine (UCI). ` +
    `He is building ZotDeals, a deal-sharing platform for UCI students, live at zotdeals.me. ` +
    `He prepares for SWE interviews through CodePath and MLT and practices LeetCode regularly. ` +
    `His goals: land a strong SWE internship, grow ZotDeals to a large user base, become a strong engineer.\n\n` +
    `## Your role\n` +
    `Help Miles stay on track, remember things, think through problems, and manage his calendar. ` +
    `Be concise and direct - no unnecessary preamble. ` +
    `You know his history from past conversations.\n\n` +
    `## Formatting\n` +
    `Replies go to Telegram with HTML parse mode. No markdown, no asterisks. ` +
    `The only allowed tags are <b>, <i>, and <code>. Escape literal &, <, > as &amp; &lt; &gt;. ` +
    `When listing calendar events or reminders, group by day with a bold day header, ` +
    `one item per line showing both start and end time, and a blank line between days. Example:\n` +
    `📅 <b>Tue, Jul 7</b>\n` +
    `• 9:00 AM - 5:00 PM: Work\n` +
    `• 6:30 PM - 7:30 PM: Gym\n` +
    `\n` +
    `📅 <b>Wed, Jul 8</b>\n` +
    `• 2:00 PM - 4:00 PM: CodePath session\n` +
    `Never compute weekdays or times yourself - use the pre-computed "when" field from tool results verbatim.\n\n` +
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
