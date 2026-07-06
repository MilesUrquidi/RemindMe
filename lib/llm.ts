import { listEvents, createEvent } from "./calendar";
import { recentCommits, openItems } from "./github";
import { getWeather } from "./weather";
import { logHabit, habitSummary } from "./habits";
import { saveJournal, recentJournal } from "./journal";

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
      {
        name: "log_habit",
        description:
          "Log that Miles did a habit today. Call whenever he mentions completing gym, leetcode, or personal project work. Use canonical habit names: 'gym', 'leetcode', 'project'.",
        parameters: {
          type: "object",
          properties: {
            habit: { type: "string", description: "Habit name: gym, leetcode, project, or another short lowercase name" },
            note: { type: "string", description: "Optional detail, e.g. 'push day' or 'worked on RemindMe'" },
          },
          required: ["habit"],
        },
      },
      {
        name: "get_habit_summary",
        description:
          "Get counts, active days, and last-done dates for Miles's habits. Use for 'how consistent have I been', streak questions, and accountability nudges.",
        parameters: {
          type: "object",
          properties: {
            days: { type: "number", description: "How many days back to look (default: 7)" },
          },
        },
      },
      {
        name: "save_journal_entry",
        description:
          "Save a journal entry. Call when Miles reflects on his day - especially replies to the evening check-in - or explicitly asks to journal something. Save his reflection in his own words, lightly cleaned up.",
        parameters: {
          type: "object",
          properties: {
            content: { type: "string", description: "The journal entry text" },
          },
          required: ["content"],
        },
      },
      {
        name: "get_journal_entries",
        description: "Get Miles's recent journal entries. Use when he asks what he journaled or how past days went.",
        parameters: {
          type: "object",
          properties: {
            days: { type: "number", description: "How many days back to look (default: 7)" },
          },
        },
      },
      {
        name: "get_weather",
        description: "Get current weather and forecast. Defaults to Irvine, CA.",
        parameters: {
          type: "object",
          properties: {
            days: { type: "number", description: "Forecast days, 1-7 (default: 1)" },
            location: { type: "string", description: "City name if not Irvine, e.g. 'San Francisco'" },
          },
        },
      },
    ],
  },
];

type Part = Record<string, unknown>;

async function callGemini(
  systemPrompt: string,
  contents: Part[],
  withTools = true
): Promise<Part> {
  let lastError: Error | null = null;

  // Two passes over the model list: 503s are transient overload spikes,
  // so a short backoff before the second sweep usually recovers.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 3000));

    for (const model of GEMINI_MODELS) {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents,
            ...(withTools ? { tools } : {}),
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
  if (name === "log_habit") {
    const status = await logHabit(args.habit as string, args.note as string | undefined);
    return { status, habit: args.habit, note: args.note };
  }
  if (name === "get_habit_summary") {
    return { habits: await habitSummary((args.days as number) ?? 7) };
  }
  if (name === "save_journal_entry") {
    await saveJournal(args.content as string);
    return { status: "saved" };
  }
  if (name === "get_journal_entries") {
    return { entries: await recentJournal((args.days as number) ?? 7) };
  }
  if (name === "get_weather") {
    return await getWeather(
      (args.days as number) ?? 1,
      args.location as string | undefined
    );
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
    `Only say you can't help when you genuinely can't, e.g. live data no tool covers (news, stock prices). ` +
    `Beyond that, help Miles stay on track, remember things, and manage his calendar. ` +
    `Hold him accountable on his habits (gym, leetcode, personal projects): when he mentions completing one, ` +
    `log it with log_habit and acknowledge briefly. If he asks how he's doing, use get_habit_summary and be honest - ` +
    `celebrate consistency, call out slumps without nagging. ` +
    `When he reflects on how his day went (especially in the evening), save it with save_journal_entry in his own words, ` +
    `and still log any habits he mentions. ` +
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
  // Gather everything in code so the brief is one deterministic compose call.
  // Each source degrades to a note instead of killing the whole brief.
  const [events, weather, habits] = await Promise.all([
    listEvents(0).catch(() => "unavailable" as const),
    getWeather(1).catch(() => "unavailable" as const),
    habitSummary(7).catch(() => "unavailable" as const),
  ]);

  const eventsBlock =
    events === "unavailable"
      ? "calendar unavailable"
      : events.length
        ? JSON.stringify(events.map((e) => ({ ...e, when: formatEventTime(e.start, e.end) })))
        : "no events today";
  const historyBlock = memories.map((m) => `${m.role}: ${m.content}`).join("\n");

  const now = new Date().toLocaleString("en-US", {
    timeZone: USER_TIMEZONE,
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const systemPrompt =
    `You are RemindMe, Miles's personal AI assistant. Compose his morning check-in text for ${now}.\n\n` +
    `Structure, in this order:\n` +
    `1. One short friendly greeting line with an emoji.\n` +
    `2. 📅 <b>Today</b> - his calendar events, one per line ("• 9:00 AM - 5:00 PM: Work"), using the pre-computed ` +
    `"when" fields verbatim. If there are no events, instead suggest 1-2 concrete things based on his habit data ` +
    `(e.g. gym if he hasn't been recently) and anything he said he wants to do in the recent conversation history.\n` +
    `3. Weather - pick a header emoji matching the conditions (☀️ 🌤 ☁️ 🌧 ⛈ 🌫), e.g. "☀️ <b>Weather</b>". ` +
    `Then two lines: current temp + conditions, and high/low + rain chance.\n` +
    `4. 💪 <b>Habits</b> - only if habit data exists: one line per habit with days active this week and when last done. ` +
    `One short honest nudge if something is slipping, brief praise if consistent.\n` +
    `5. Optional single closing line - only if the recent history has something worth following up on today.\n\n` +
    `Formatting: Telegram HTML. Only <b>, <i>, <code> tags. No markdown, no asterisks, no <ul>/<li>. ` +
    `Blank line between sections. Keep the whole thing compact - it's a morning text, not a report.`;

  const content = await callGemini(
    systemPrompt,
    [
      {
        role: "user",
        parts: [
          {
            text:
              `Today's calendar: ${eventsBlock}\n\n` +
              `Weather data: ${JSON.stringify(weather)}\n\n` +
              `Habit summary (last 7 days): ${JSON.stringify(habits)}\n\n` +
              `Recent conversation history:\n${historyBlock}`,
          },
        ],
      },
    ],
    false
  );

  const parts = (content.parts as Part[]) ?? [];
  return (parts.find((p) => p.text)?.text as string) ?? "(no response)";
}

export async function eveningSummary(): Promise<string> {
  const [habits, commits, events] = await Promise.all([
    habitSummary(1).catch(() => "unavailable" as const),
    recentCommits(1).catch(() => "unavailable" as const),
    listEvents(0).catch(() => "unavailable" as const),
  ]);

  const now = new Date().toLocaleString("en-US", {
    timeZone: USER_TIMEZONE,
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const systemPrompt =
    `You are RemindMe, Miles's personal AI assistant. Compose his evening check-in text for ${now}.\n\n` +
    `Structure:\n` +
    `1. One short winding-down greeting line with an emoji (🌙 or similar).\n` +
    `2. A compact recap of the day from the data: habits he logged, commits he shipped, events he had. ` +
    `Only mention sections that have data - skip empty ones entirely. If he logged nothing and shipped nothing, ` +
    `gently note the day looks quiet without guilt-tripping.\n` +
    `3. End with ONE reflective question inviting him to journal - e.g. how the day went, ` +
    `what he got done, whether he hit the gym. Vary the phrasing naturally; if the data already shows gym/leetcode ` +
    `logged, don't ask about those - ask something the data doesn't show.\n\n` +
    `Formatting: Telegram HTML. Only <b>, <i>, <code> tags. No markdown, no <ul>/<li>. ` +
    `Use "• " for list lines and blank lines between sections. Keep it short - a nightly text, not a report.`;

  const content = await callGemini(
    systemPrompt,
    [
      {
        role: "user",
        parts: [
          {
            text:
              `Habits logged today: ${JSON.stringify(habits)}\n\n` +
              `Commits today: ${JSON.stringify(commits)}\n\n` +
              `Today's calendar was: ${JSON.stringify(events)}`,
          },
        ],
      },
    ],
    false
  );

  const parts = (content.parts as Part[]) ?? [];
  return (parts.find((p) => p.text)?.text as string) ?? "(no response)";
}
