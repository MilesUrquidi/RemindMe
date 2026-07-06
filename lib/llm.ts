import { listEvents, createEvent } from "./calendar";
import { recentCommits, openItems } from "./github";

// Free-tier quotas are per model per day, so a rate-limited primary
// can fall back to a model with its own separate quota bucket.
const GEMINI_MODELS = ["gemini-2.5-flash", "gemini-2.5-flash-lite"];

const USER_TIMEZONE = "America/Los_Angeles";

// Tools Gemini is allowed to call.
const tools = [
  {
    functionDeclarations: [
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
      {
        name: "list_recent_commits",
        description: "List Miles's recent GitHub commits across his repos. Use for questions like 'what did I ship this week'.",
        parameters: {
          type: "object",
          properties: {
            days: { type: "number", description: "How many days back to look (default: 7)" },
          },
        },
      },
      {
        name: "list_open_github_items",
        description: "List open issues and pull requests across Miles's GitHub repos.",
        parameters: { type: "object", properties: {} },
      },
    ],
  },
];

type Part = Record<string, unknown>;

async function callGemini(systemPrompt: string, contents: Part[]): Promise<Part> {
  let lastError: Error | null = null;

  for (const model of GEMINI_MODELS) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents,
          tools,
        }),
      }
    );

    if (res.ok) {
      const data = await res.json();
      return data?.candidates?.[0]?.content ?? { parts: [{ text: "(no response)" }] };
    }

    lastError = new Error(`Gemini ${model} ${res.status}: ${await res.text()}`);
    // Quota exhaustion (429) and transient overload (503) fall through to the
    // next model; real errors surface immediately.
    if (res.status !== 429 && res.status !== 503) throw lastError;
    console.warn(`${model} unavailable (${res.status}), trying next model`);
  }

  throw lastError ?? new Error("no Gemini models configured");
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

async function runTool(name: string, args: Record<string, unknown>): Promise<object> {
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
  if (name === "list_recent_commits") {
    return { commits: await recentCommits((args.days as number) ?? 7) };
  }
  if (name === "list_open_github_items") {
    return { items: await openItems() };
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
    `He prepares for SWE interviews through CodePath and MLT and practices LeetCode regularly. ` +
    `He works on personal coding projects and goes to the gym. ` +
    `His goals: land a strong SWE internship, stay consistent with the gym and his projects, become a strong engineer.\n\n` +
    `## Your role\n` +
    `You are a full general-purpose assistant. Answer any question from your own knowledge - ` +
    `coding help, LeetCode problems, system design, interview prep, career advice, explanations, brainstorming, anything. ` +
    `Tools (calendar) are extras, not your limits: never refuse a question just because no tool covers it. ` +
    `Only say you can't help when you genuinely can't, e.g. live data you have no access to (weather, news, stock prices). ` +
    `Beyond that, help Miles stay on track, remember things, and manage his calendar. ` +
    `Be concise and direct - no unnecessary preamble. ` +
    `You know his history from past conversations.\n\n` +
    `## Formatting\n` +
    `Replies go to Telegram with HTML parse mode. No markdown, no asterisks. ` +
    `The ONLY allowed tags are <b>, <i>, and <code> - Telegram rejects everything else. ` +
    `Never use <ul>, <ol>, <li>, <p>, <br>, or headings. For lists, write plain lines starting with "• " or "1." ` +
    `Escape literal &, <, > as &amp; &lt; &gt;. ` +
    `When listing calendar events, group by day with a bold day header, ` +
    `one item per line showing both start and end time, and a blank line between days. Example:\n` +
    `📅 <b>Tue, Jul 7</b>\n` +
    `• 9:00 AM - 5:00 PM: Work\n` +
    `• 6:30 PM - 7:30 PM: Gym\n` +
    `\n` +
    `📅 <b>Wed, Jul 8</b>\n` +
    `• 2:00 PM - 4:00 PM: CodePath session\n` +
    `Never compute weekdays or times yourself - use the pre-computed "when" field from tool results verbatim.\n\n` +
    `The current time is ${now} (${USER_TIMEZONE}). When Miles asks to schedule something, call create_event ` +
    `with absolute ISO 8601 times in his timezone. Resolve relative times like "tomorrow at 9am" ` +
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

    const result = await runTool(fnCall.name, fnCall.args ?? {});
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
