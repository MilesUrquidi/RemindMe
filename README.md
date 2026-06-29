# RemindMe

A personal AI agent that lives in Telegram. It has long-term memory, responds using Google Gemini, and proactively sends daily check-ins via a cron job.

## Stack

- **Next.js** (App Router) on Vercel - webhook endpoint + cron
- **Supabase** (Postgres + pgvector) - memory storage
- **Google Gemini** (`gemini-2.5-flash`, free tier) - reasoning and responses
- **Telegram Bot API** - webhook-based messaging interface
- **Vercel Cron** - proactive scheduled messages

## How it works

1. You message the bot on Telegram.
2. `POST /api/telegram` receives the webhook, retrieves recent memory, calls Gemini, replies, and stores the exchange in Supabase.
3. `GET /api/cron/daily` runs each morning, summarizes recent context, and sends a proactive check-in.

## Setup

1. Create a Supabase project and run `supabase/migrations/001_init.sql`.
2. Create a Telegram bot via [@BotFather](https://t.me/BotFather) and a Gemini key at [AI Studio](https://aistudio.google.com/apikey).
3. Set the environment variables (see below) locally in `.env.local` and on Vercel.
4. Deploy: `vercel deploy --prod`.
5. Register the webhook:
   ```bash
   curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<your-app>.vercel.app/api/telegram"
   ```

## Environment variables

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Your personal chat ID (from @userinfobot) |
| `GEMINI_API_KEY` | Google Gemini API key |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key |
| `CRON_SECRET` | Random string protecting the cron endpoint |

## Roadmap

- Semantic memory via Gemini embeddings (currently recency-based)
- Tool use: GitHub, calendar, Obsidian
- Open-source "deploy your own" flow
