// weekly-brief: emails each institute's owners the weekly brief (four plain lines) every Monday.
// The logic is in logic.js (tested with Node: tests/web/weekly-brief.test.js); this file only wires Deno in.
//
// Deploy:   supabase functions deploy weekly-brief
// Schedule: Supabase Cron, Mondays 8:00 am India time (02:30 UTC). Steps in docs/weekly-brief.md.
// Secrets:  SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase. Email (optional until set):
//           RESEND_API_KEY and BRIEF_FROM_EMAIL (e.g. "Vector <brief@yourdomain.in>"); BRIEF_EMAIL_PROVIDER
//           (default "resend"); BRIEF_APP_URL (site address for the "See more" link); BRIEF_CRON_SECRET (lets
//           the schedule call with an x-brief-secret header instead of the service role key). Set them with
//           `supabase secrets set`, never in this repo. Without an email key the run composes and logs only.
//
// Request:  POST with "Authorization: Bearer <service role key>" (or x-brief-secret). Body {"dry_run": true}
//           composes every brief and returns them without sending.
import { handleRequest } from "./logic.js";

const ENV_KEYS = [
  "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "RESEND_API_KEY", "BRIEF_FROM_EMAIL",
  "BRIEF_EMAIL_PROVIDER", "BRIEF_APP_URL", "BRIEF_CRON_SECRET",
];

Deno.serve(async (req: Request): Promise<Response> => {
  const env: Record<string, string> = {};
  for (const k of ENV_KEYS) env[k] = Deno.env.get(k) ?? "";
  let body: unknown = null;
  try { body = await req.json(); } catch { body = null; }
  const out = await handleRequest({
    method: req.method,
    headers: req.headers,
    body,
    env,
    fetchImpl: fetch,
    log: (m: string) => console.log(m),
    today: new Date(),
  });
  return new Response(JSON.stringify(out.body), {
    status: out.status,
    headers: { "Content-Type": "application/json" },
  });
});
