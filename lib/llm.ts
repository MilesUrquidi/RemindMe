import Anthropic from "@anthropic-ai/sdk";
import { listEvents, createEvent } from "./calendar";
import { recentCommits, openItems, createIssue } from "./github";
import { getWeather } from "./weather";
import { logHabit, habitSummary } from "./habits";
import { saveJournal, recentJournal } from "./journal";
import type { MemoryContext } from "./memory";

// Provider order: Anthropic Haiku (prepaid credits - cheap, better quality) first,
// then free-tier Gemini when credits run out or Anthropic errors. Prepaid balance
// is the spend cap: when it hits zero the API errors and Gemini takes over.
const ANTHROPIC_MODEL = "claude-haiku-4-5";
const anthropic = new Anthropic();

// Free-tier quotas are per model per day, so a rate-limited primary
// can fall back to a model with its own separate quota bucket.
const GEMINI_MODELS = ["gemini-2.5-flash", "gemini-2.5-flash-lite"];

const USER_TIMEZONE = "America/Los_Angeles";

// Single source of truth for tool definitions; mapped to each provider's format below.
const toolDefs = [
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
    name: "create_github_issue",
    description:
      "Create an issue in one of Miles's GitHub repos. Use when he asks to file/make/open an issue. Write a clear title and a short useful body from what he described.",
    parameters: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repository name, e.g. 'RemindMe'" },
        title: { type: "string", description: "Issue title" },
        body: { type: "string", description: "Issue body in GitHub markdown" },
      },
      required: ["repo", "title"],
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
];

const tools = [{ functionDeclarations: toolDefs }];

const anthropicTools: Anthropic.Tool[] = toolDefs.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.parameters as Anthropic.Tool.InputSchema,
}));

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
  if (name === "create_github_issue") {
    const issue = await createIssue(
      args.repo as string,
      args.title as string,
      args.body as string | undefined
    );
    return { status: "created", ...issue };
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

// Static half of the chat system prompt. Kept separate from the per-message
// dynamic context (time, memories) so Anthropic can cache it across requests.
const PERSONA =
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
  `Never compute weekdays or times yourself - use the pre-computed "when" field from tool results verbatim.`;

// One-shot compose (no tools) used by the cron briefs: Anthropic first, Gemini fallback.
async function compose(systemPrompt: string, userText: string): Promise<string> {
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const response = await anthropic.messages.create({
        model: ANTHROPIC_MODEL,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: "user", content: userText }],
      });
      const text = response.content.find((b) => b.type === "text");
      if (response.stop_reason !== "refusal" && text?.type === "text") return text.text;
    } catch (err) {
      console.warn("Anthropic compose failed, using Gemini:", err);
    }
  }

  const content = await callGemini(
    systemPrompt,
    [{ role: "user", parts: [{ text: userText }] }],
    false
  );
  const parts = (content.parts as Part[]) ?? [];
  return (parts.find((p) => p.text)?.text as string) ?? "(no response)";
}

// Recent messages become real conversation turns. Consecutive same-role rows
// (e.g. cron-sent briefs) are merged so alternation holds, and any leading
// assistant turn is dropped since a conversation must start with the user.
// Gemini calls the assistant role "model"; Anthropic calls it "assistant".
function toTurns(
  recent: MemoryContext["recent"],
  assistantRole: "model" | "assistant"
): { role: string; text: string }[] {
  const turns: { role: string; texts: string[] }[] = [];
  for (const m of recent) {
    const role = m.role === "assistant" ? assistantRole : "user";
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.texts.push(m.content);
    else turns.push({ role, texts: [m.content] });
  }
  while (turns.length && turns[0].role === assistantRole) turns.shift();
  return turns.map((t) => ({ role: t.role, text: t.texts.join("\n") }));
}

export async function chat(
  chatId: number,
  userMessage: string,
  memories: MemoryContext
): Promise<string> {
  const contextBlock = memories.relevant.length
    ? `\n\nPossibly relevant memories from past conversations (may be old - trust the live conversation over these):\n` +
      memories.relevant.map((m) => `${m.role}: ${m.content}`).join("\n")
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
  const dynamicContext =
    `The current time is ${now} (${USER_TIMEZONE}). When Miles asks to schedule something, call create_event ` +
    `with absolute ISO 8601 times in his timezone. Resolve relative times like "tomorrow at 9am" ` +
    `against the current time above.${contextBlock}`;

  if (process.env.ANTHROPIC_API_KEY) {
    try {
      return await chatAnthropic(dynamicContext, memories.recent, userMessage);
    } catch (err) {
      if (!(err instanceof AnthropicUnavailable)) throw err;
      console.warn("Anthropic unavailable, using Gemini:", err.message);
    }
  }
  return chatGemini(`${PERSONA}\n\n${dynamicContext}`, memories.recent, userMessage);
}

// Thrown only when no side-effecting tool has run yet, so retrying the whole
// conversation on Gemini is safe (no duplicate events/issues).
class AnthropicUnavailable extends Error {}

async function chatAnthropic(
  dynamicContext: string,
  recent: MemoryContext["recent"],
  userMessage: string
): Promise<string> {
  const messages: Anthropic.MessageParam[] = [
    ...toTurns(recent, "assistant").map((t) => ({
      role: t.role as "user" | "assistant",
      content: t.text,
    })),
    { role: "user", content: userMessage },
  ];

  let toolsRan = false;
  try {
    // Allow up to 3 tool round-trips before giving up.
    for (let i = 0; i < 3; i++) {
      const response = await anthropic.messages.create({
        model: ANTHROPIC_MODEL,
        max_tokens: 2048,
        system: [
          // Static persona is cached (90% cheaper on reads); dynamic time/memory context stays out.
          { type: "text", text: PERSONA, cache_control: { type: "ephemeral" } },
          { type: "text", text: dynamicContext },
        ],
        tools: anthropicTools,
        messages,
      });

      if (response.stop_reason === "refusal") {
        return "I'm not able to help with that.";
      }

      if (response.stop_reason === "tool_use") {
        messages.push({ role: "assistant", content: response.content });
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const block of response.content) {
          if (block.type === "tool_use") {
            toolsRan = true;
            const result = await runTool(block.name, block.input as Record<string, unknown>);
            results.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: JSON.stringify(result),
            });
          }
        }
        messages.push({ role: "user", content: results });
        continue;
      }

      const text = response.content.find((b) => b.type === "text");
      return text?.type === "text" ? text.text : "(no response)";
    }
    return "Done.";
  } catch (err) {
    if (toolsRan) throw err;
    throw new AnthropicUnavailable(err instanceof Error ? err.message : String(err));
  }
}

async function chatGemini(
  systemPrompt: string,
  recent: MemoryContext["recent"],
  userMessage: string
): Promise<string> {
  const contents: Part[] = [
    ...toTurns(recent, "model").map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
    { role: "user", parts: [{ text: userMessage }] },
  ];

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

export async function dailySummary(memories: MemoryContext): Promise<string> {
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
  const historyBlock = memories.recent.map((m) => `${m.role}: ${m.content}`).join("\n");

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

  return compose(
    systemPrompt,
    `Today's calendar: ${eventsBlock}\n\n` +
      `Weather data: ${JSON.stringify(weather)}\n\n` +
      `Habit summary (last 7 days): ${JSON.stringify(habits)}\n\n` +
      `Recent conversation history:\n${historyBlock}`
  );
}

export async function weeklySummary(): Promise<string> {
  const [habits, prevHabits, journal, commits] = await Promise.all([
    habitSummary(7).catch(() => "unavailable" as const),
    habitSummary(14).catch(() => "unavailable" as const),
    recentJournal(7).catch(() => "unavailable" as const),
    recentCommits(7).catch(() => "unavailable" as const),
  ]);

  const now = new Date().toLocaleString("en-US", {
    timeZone: USER_TIMEZONE,
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const systemPrompt =
    `You are RemindMe, Miles's personal AI assistant. It's Sunday evening (${now}) - compose his weekly review, ` +
    `which replaces tonight's regular check-in.\n\n` +
    `Structure:\n` +
    `1. Short greeting acknowledging the week is wrapping up.\n` +
    `2. 💪 <b>Habits</b> - this week's consistency per habit (days active out of 7). The 14-day data minus ` +
    `the 7-day data is last week's baseline: say whether he's trending up or down, honestly.\n` +
    `3. 🚢 <b>Shipped</b> - what he committed this week, grouped by repo, one line each. Skip if no commits.\n` +
    `4. 📓 <b>Reflections</b> - 1-2 themes from his journal entries this week, in a sentence or two. ` +
    `Quote a short phrase of his own words if one stands out. Skip if no entries.\n` +
    `5. 🎯 One suggested focus for next week, grounded in the data (weakest habit, stalled project, ` +
    `or something he said he wanted to do).\n` +
    `6. End with one reflective question about the week overall - his answer becomes a journal entry.\n\n` +
    `Formatting: Telegram HTML. Only <b>, <i>, <code> tags. No markdown, no <ul>/<li>. ` +
    `Use "• " for list lines and blank lines between sections. Compact but warmer than the daily texts - ` +
    `it's the one message of the week that zooms out.`;

  return compose(
    systemPrompt,
    `Habits last 7 days: ${JSON.stringify(habits)}\n\n` +
      `Habits last 14 days (for week-over-week comparison): ${JSON.stringify(prevHabits)}\n\n` +
      `Journal entries this week: ${JSON.stringify(journal)}\n\n` +
      `Commits this week: ${JSON.stringify(commits)}`
  );
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

  return compose(
    systemPrompt,
    `Habits logged today: ${JSON.stringify(habits)}\n\n` +
      `Commits today: ${JSON.stringify(commits)}\n\n` +
      `Today's calendar was: ${JSON.stringify(events)}`
  );
}
