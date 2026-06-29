import { createDAVClient } from "tsdav";

type DAVClientInstance = Awaited<ReturnType<typeof createDAVClient>>;

let _client: DAVClientInstance | null = null;

async function getClient(): Promise<DAVClientInstance> {
  if (_client) return _client;
  _client = await createDAVClient({
    serverUrl: "https://caldav.icloud.com",
    credentials: {
      username: process.env.APPLE_ID!,
      password: process.env.APPLE_APP_PASSWORD!,
    },
    authMethod: "Basic",
    defaultAccountType: "caldav",
  });
  return _client;
}

function parseIcalDate(raw: string): string {
  // All-day: 20260629 → 2026-06-29
  // With time: 20260629T090000Z → 2026-06-29T09:00:00Z
  if (!raw.includes("T")) {
    return raw.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3");
  }
  const utc = raw.endsWith("Z");
  const clean = raw
    .replace("Z", "")
    .replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/, "$1-$2-$3T$4:$5:$6");
  return utc ? clean + "Z" : clean;
}

function parseVEvent(ical: string): CalendarEvent | null {
  const get = (key: string) =>
    ical.match(new RegExp(`(?:^|\\r?\\n)${key}(?:;[^:\\r\\n]*)?:([^\\r\\n]+)`))?.[1]?.trim();

  const summary = get("SUMMARY");
  const dtstart = get("DTSTART");
  if (!summary || !dtstart) return null;

  const dtend = get("DTEND");
  return {
    summary,
    start: parseIcalDate(dtstart),
    end: dtend ? parseIcalDate(dtend) : parseIcalDate(dtstart),
    description: get("DESCRIPTION") ?? undefined,
    location: get("LOCATION") ?? undefined,
  };
}

function toIcalDate(iso: string): string {
  return iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function generateUID(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}@remindme`;
}

export interface CalendarEvent {
  summary: string;
  start: string;
  end: string;
  description?: string;
  location?: string;
}

export async function listEvents(days = 7): Promise<CalendarEvent[]> {
  const client = await getClient();
  const calendars = await client.fetchCalendars();

  const now = new Date();
  const end = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  const events: CalendarEvent[] = [];

  for (const calendar of calendars) {
    const objects = await client.fetchCalendarObjects({
      calendar,
      timeRange: { start: now.toISOString(), end: end.toISOString() },
    });

    for (const obj of objects) {
      if (!obj.data) continue;
      const veventMatch = obj.data.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/);
      if (!veventMatch) continue;
      const parsed = parseVEvent(veventMatch[0]);
      if (parsed) events.push(parsed);
    }
  }

  return events.sort((a, b) => a.start.localeCompare(b.start));
}

export async function createEvent(
  summary: string,
  startIso: string,
  endIso: string,
  description?: string,
  location?: string
): Promise<void> {
  const client = await getClient();
  const calendars = await client.fetchCalendars();
  if (!calendars.length) throw new Error("No calendars found");

  const uid = generateUID();
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//RemindMe//EN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${toIcalDate(new Date().toISOString())}`,
    `DTSTART:${toIcalDate(startIso)}`,
    `DTEND:${toIcalDate(endIso)}`,
    `SUMMARY:${summary}`,
    description ? `DESCRIPTION:${description}` : null,
    location ? `LOCATION:${location}` : null,
    "END:VEVENT",
    "END:VCALENDAR",
  ]
    .filter(Boolean)
    .join("\r\n");

  await client.createCalendarObject({
    calendar: calendars[0],
    filename: `${uid}.ics`,
    iCalString: lines,
  });
}
