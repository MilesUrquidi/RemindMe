import { NextRequest, NextResponse } from "next/server";
import { dueReminders, markSent } from "@/lib/reminders";
import { sendMessage } from "@/lib/telegram";

// Pinged every minute by an external scheduler (cron-job.org).
// Fires any reminders whose due_at has passed.
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const due = await dueReminders();

  await Promise.all(
    due.map(async (r) => {
      await sendMessage(r.chat_id, `⏰ Reminder: ${r.content}`);
      await markSent(r.id);
    })
  );

  return NextResponse.json({ ok: true, fired: due.length });
}
