// whatsapp-reminders: the daily WhatsApp job, run by a schedule (docs/whatsapp-setup.md, "Daily job").
// The logic lives here (tested in tests/web/whatsapp-functions.test.js); index.ts only wires it.
//
// Request: POST with "x-cron-secret: <WHATSAPP_CRON_SECRET>" and an optional JSON body
//   { job: "all" | "reminders" | "brief", today: "YYYY-MM-DD" }   (defaults: "all", today in India)
// 1. Reminders: the utility template 'promise_due' to every lead whose promised payment date is tomorrow,
//    with WhatsApp consent and not "do not call". wa_claim_reminders claims each one with a key made of the
//    lead and the date, so a reminder never goes twice, however often the job runs. A failed one is tried
//    again on the next run.
// 2. Weekly brief (Mondays, or job "brief"): the lines of admin_weekly_brief(campaign) for each running
//    campaign, to every owner who turned it on in Settings, with the approved 'weekly_brief' template. Sent once
//    a week per owner and campaign. When the database has no admin_weekly_brief yet, it is skipped.
// Answer: 200 { ok, today, reminders: {claimed, sent, failed}, brief: {...} }.
import { reply, readJson, sameSecret, sendClaimed, indiaToday, mondayOf, cleanParam } from '../_shared/whatsapp.mjs';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const BRIEF_MAX = 900;   // the template body is at most 1024 characters with the fixed text

// One line of admin_weekly_brief's answer, whatever shape the Insights feature gave it: a string, an object
// with one text field (line, text …), or an array of strings.
export function briefLines(rows) {
  const out = [];
  const add = (v) => {
    if (typeof v === 'string') { const t = cleanParam(v); if (t) out.push(t); return; }
    if (Array.isArray(v)) { v.forEach(add); return; }
    if (v && typeof v === 'object') {
      const pick = v.line ?? v.text ?? v.lines ?? v.admin_weekly_brief ?? Object.values(v).find((x) => typeof x === 'string' || Array.isArray(x));
      if (pick !== undefined) add(pick);
    }
  };
  add(Array.isArray(rows) ? rows : [rows]);
  return out;
}

// The typed blanks of the weekly brief template: the first is the campaign name, the next the lines joined
// with ' · ' (Meta does not allow new lines in a blank). One typed blank only: both in one.
export function briefParams(template, campaignName, lines) {
  const typedCount = (template.param_sources || []).filter((s) => s === 'typed').length;
  let text = lines.join(' · ');
  if (text.length > BRIEF_MAX) text = text.slice(0, BRIEF_MAX - 1) + '…';
  const values = typedCount >= 2 ? [campaignName, text] : [campaignName + ': ' + text];
  const typed = [];
  let k = 0;
  (template.param_sources || []).forEach((s, i) => { if (s === 'typed') typed[i] = values[k++] || '-'; });
  return typed;
}

// deps: { env, fetch, rpc(name, args) with the service role }
export async function handle(req, deps) {
  const env = deps.env || {};
  if (req.method !== 'POST') return reply(405, { error: 'Use POST.' });
  if (!env.WHATSAPP_CRON_SECRET) {
    console.error('whatsapp-reminders: WHATSAPP_CRON_SECRET is not set');
    return reply(500, { error: 'not configured' });
  }
  if (!sameSecret(req.headers.get('x-cron-secret'), env.WHATSAPP_CRON_SECRET)) return reply(401, { error: 'not allowed' });
  const body = (await readJson(req)) || {};
  const job = ['all', 'reminders', 'brief'].includes(body.job) ? body.job : 'all';
  const today = typeof body.today === 'string' && DAY.test(body.today) ? body.today : indiaToday(deps.now ? deps.now() : null);
  const isMonday = new Date(today + 'T00:00:00Z').getUTCDay() === 1;
  const tokenCache = new Map();
  const result = { ok: true, today, reminders: null, brief: null };

  try {
    if (job === 'all' || job === 'reminders') {
      const r = { claimed: 0, sent: 0, failed: 0 };
      const rows = (await deps.rpc('wa_claim_reminders', { p_today: today, p_limit: 500 })) || [];
      for (const ctx of rows) {
        r.claimed++;
        const out = await sendClaimed(deps, ctx, { tokenCache });
        if (out.ok) r.sent++; else r.failed++;
      }
      result.reminders = r;
    }
    if (job === 'brief' || (job === 'all' && isMonday)) {
      const b = { available: true, claimed: 0, sent: 0, failed: 0 };
      b.available = !!(await deps.rpc('wa_brief_available', {}));
      if (b.available) {
        const rows = (await deps.rpc('wa_claim_briefs', { p_week: mondayOf(today) })) || [];
        for (const ctx of rows) {
          b.claimed++;
          const lines = briefLines(ctx.lines);
          const out = await sendClaimed(deps, ctx, {
            tokenCache,
            to: String(ctx.phone || '').replace(/[^0-9]/g, ''),
            typed: briefParams(ctx.template, ctx.campaign_name || 'your campaign', lines.length ? lines : ['No calls this week.']),
            // The brief may hold ₹ totals: the log keeps only what it was about (money rules).
            maskedBody: 'Weekly brief: ' + (ctx.campaign_name || ''),
          });
          if (out.ok) b.sent++; else b.failed++;
        }
      }
      result.brief = b;
    }
  } catch (err) {
    console.error('whatsapp-reminders database error', err && err.code, err && err.message);
    return reply(500, { error: 'database error', partial: result });
  }
  return reply(200, result);
}
