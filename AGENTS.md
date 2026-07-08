<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# RemindMe

Personal AI assistant bot for Miles, living in Telegram (@MilesRemindr_bot).
Deployed on Vercel (Hobby) at remindme-black.vercel.app; `git push` to main auto-deploys.
For full history, design decisions, and agent lessons, read the Obsidian note:
`/Users/miles/Library/Mobile Documents/iCloud~md~obsidian/Documents/First Database/MilesBase/Projects/RemindMe/RemindMe.md`

## What it does

- Chat with long-term memory: every message embedded (`gemini-embedding-001`, 1536 dims) into Supabase pgvector; retrieval = semantic matches + recent messages.
- Tools via Gemini function calling: Apple Calendar (read/create), GitHub (commits, open issues/PRs), weather (Open-Meteo), habit log/summary (gym, leetcode, project), journal save/read.
- 8am PT morning brief cron: calendar (or suggestions), weather with emoji, habit accountability.
- 9pm PT evening check-in cron: day recap + reflective question; Miles's reply is saved as a journal entry. Sundays it becomes the weekly review (`?weekly=1` forces it).
- One-off reminders ("remind me to X in 20 min"): create/list/cancel tools; fired by `/api/cron/reminders`, pinged every minute by cron-job.org (restored 2026-07-08 as the wedge feature for a future multi-user version).

## Architecture

- `app/api/telegram/route.ts` — webhook; only responds to Miles's chat id (`TELEGRAM_CHAT_ID`); always replies + returns 200 on errors so Telegram doesn't re-deliver.
- `app/api/cron/daily/route.ts` + `app/api/cron/evening/route.ts` — briefs; GET + `Authorization: Bearer <CRON_SECRET>`; schedules in `vercel.json` are UTC (15 = 8am PDT, 4 = 9pm PDT).
- `lib/llm.ts` — the LLM layer, provider-isolated. Primary: Claude Haiku 4.5 (`@anthropic-ai/sdk`, prepaid credits as the natural spend cap, static persona block prompt-cached). Fallback on any Anthropic failure (incl. exhausted credits): Gemini raw fetch, `gemini-2.5-flash` → `gemini-2.5-flash-lite` on 429/503 with a second sweep after backoff. No `ANTHROPIC_API_KEY` = pure Gemini. Tool defs live once in `toolDefs`, mapped to both providers' formats. If a side-effecting tool already ran, a mid-conversation Anthropic failure does NOT re-run on Gemini (prevents duplicate events/issues). System prompt carries Miles's persona, Telegram HTML formatting rules, and pre-computed event times (never let the model derive weekdays).
- `lib/telegram.ts` — sendMessage sanitizes model output to Telegram's tag subset (`<b> <i> <code>`), converts markdown/list tags to `• ` lines, falls back to tag-stripped plain text.
- `lib/memory.ts`, `lib/calendar.ts`, `lib/github.ts`, `lib/weather.ts`, `lib/habits.ts`, `lib/journal.ts` — one file per capability.
- `supabase/migrations/` — applied manually by Miles via the Supabase dashboard SQL editor (no CLI); never assume a migration ran.

## Conventions and gotchas

- Secrets in `.env.local` (never committed) + Vercel env vars. Ask Miles to run `vercel env add` himself.
- Gemini free tier: ~20 requests/day per model; heavy E2E testing burns it — test sparingly, quota resets midnight PT.
- iCloud CalDAV ignores time-range filters — calendar.ts fetches all and filters client-side by LA-date strings.
- All times resolved against `America/Los_Angeles`; Vercel crons and servers run UTC — never parse a local-naive string on the server.
- Miles's memory and habit/journal data are real — don't insert test rows without cleaning up, and don't send test Telegram messages beyond what's needed.
- E2E test = simulate the webhook (see Obsidian note for curl commands); local dev shares prod's Supabase.
- ZotDeals is a retired past project — don't reference it or build on it.
