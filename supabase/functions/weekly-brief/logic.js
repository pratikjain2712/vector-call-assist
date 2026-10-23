// weekly-brief logic, kept in plain JS so Node can test it (tests/web/weekly-brief.test.js, fetch mocked).
// index.ts is the thin Deno wrapper. Nothing here reads Deno or process: settings come in as `env`.
//
// What it does: for every live institute (weekly_brief_recipients), compose the four lines
// (weekly_brief_lines, counts only: no rupees in email) and email them to each owner.
// Email goes through a provider-neutral sender. Resend is built in (RESEND_API_KEY, BRIEF_FROM_EMAIL); with no
// key or sender address it skips sending and logs it, so the schedule can run before email is set up.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Same check in constant time, so the secret cannot be guessed one letter at a time.
export function sameSecret(a, b) {
  const x = String(a || ''), y = String(b || '');
  if (!x || !y) return false;
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return diff === 0;
}

// The schedule calls with the service role key as the bearer token, or with x-brief-secret set to
// BRIEF_CRON_SECRET when that is configured. headers: a Headers object or a plain object.
export function isAuthorised(headers, env) {
  const get = (k) => (typeof headers?.get === 'function' ? headers.get(k) : headers?.[k] ?? headers?.[k.toLowerCase()]) || '';
  const bearer = String(get('authorization') || get('Authorization')).replace(/^Bearer\s+/i, '');
  if (env.BRIEF_CRON_SECRET && sameSecret(get('x-brief-secret'), env.BRIEF_CRON_SECRET)) return true;
  return sameSecret(bearer, env.SUPABASE_SERVICE_ROLE_KEY);
}

// A PostgREST RPC call with the service role key. Throws with the database message on failure.
export function makeRpc(env, fetchImpl) {
  const base = String(env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY || '';
  return async function rpc(name, args) {
    const res = await fetchImpl(base + '/rest/v1/rpc/' + name, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: key, Authorization: 'Bearer ' + key },
      body: JSON.stringify(args || {}),
    });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }
    if (!res.ok) throw new Error((body && body.message) || ('database call ' + name + ' failed (' + res.status + ')'));
    return body;
  };
}

function escapeHtml(v) {
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Subject, plain text and simple HTML for one institute's brief.
export function composeEmail({ instituteName, lines, appUrl, today }) {
  const day = today || new Date();
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dateText = day.getUTCDate() + ' ' + months[day.getUTCMonth()];
  const clean = (Array.isArray(lines) ? lines : []).map((l) => String(l || '').trim()).filter(Boolean);
  const name = String(instituteName || 'your institute');
  const subject = 'Your week in 4 lines: ' + name + ', ' + dateText;
  const link = appUrl ? String(appUrl).replace(/\/+$/, '') + '/admin.html#insights' : '';
  const text = ['This week at ' + name + ':', '']
    .concat(clean.map((l, i) => (i + 1) + '. ' + l))
    .concat(['', link ? 'See more on Insights: ' + link : 'See more on the Insights tab of Vector admin.',
      '', 'Counts only. Rupee amounts are shown in the app to people allowed to see them.'])
    .join('\n');
  const html = '<p>This week at <strong>' + escapeHtml(name) + '</strong>:</p><ol>'
    + clean.map((l) => '<li style="margin-bottom:6px">' + escapeHtml(l) + '</li>').join('')
    + '</ol><p>' + (link ? '<a href="' + escapeHtml(link) + '">See more on Insights</a>' : 'See more on the Insights tab of Vector admin.')
    + '</p><p style="color:#56617a;font-size:12px">Counts only. Rupee amounts are shown in the app to people allowed to see them.</p>';
  return { subject, text, html };
}

// The email sender. provider: env.BRIEF_EMAIL_PROVIDER, 'resend' by default. Another provider plugs in here
// with the same shape: { name, configured, send({ to, subject, text, html }) }. Never logs the key.
export function createSender(env, fetchImpl) {
  const provider = String(env.BRIEF_EMAIL_PROVIDER || 'resend').toLowerCase();
  if (provider === 'resend') {
    const key = env.RESEND_API_KEY || '';
    const from = env.BRIEF_FROM_EMAIL || '';
    const configured = !!key && !!from;
    return {
      name: 'resend',
      configured,
      missing: configured ? [] : [!key && 'RESEND_API_KEY', !from && 'BRIEF_FROM_EMAIL'].filter(Boolean),
      async send({ to, subject, text, html }) {
        const res = await fetchImpl('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
          body: JSON.stringify({ from, to: [to], subject, text, html }),
        });
        if (!res.ok) {
          let detail = '';
          try { const b = await res.json(); detail = b && (b.message || b.name) ? ': ' + (b.message || b.name) : ''; } catch (e) { /* no body */ }
          throw new Error('email provider answered ' + res.status + detail);
        }
        return true;
      },
    };
  }
  return { name: provider, configured: false, missing: ['a sender for BRIEF_EMAIL_PROVIDER=' + provider], async send() { return false; } };
}

// One run. Returns { institutes, emails, sent, skipped, failed, dryRun, preview? }. log(message) gets one line
// per institute (no email addresses, no secrets). dryRun: compose but send nothing; preview lists what would go.
export async function runWeeklyBrief({ rpc, sender, log, appUrl, dryRun, today }) {
  const say = typeof log === 'function' ? log : () => {};
  const out = { institutes: 0, emails: 0, sent: 0, skipped: 0, failed: 0, dryRun: !!dryRun };
  if (dryRun) out.preview = [];
  const rows = (await rpc('weekly_brief_recipients', {})) || [];
  if (!sender.configured && !dryRun) say('weekly-brief: email is not set up (' + (sender.missing || []).join(', ') + '); nothing is sent');
  for (const row of rows) {
    if (!row || !UUID.test(String(row.institute_id || ''))) continue;
    out.institutes++;
    const emails = (Array.isArray(row.emails) ? row.emails : []).filter((e) => EMAIL.test(String(e || '')));
    let lines;
    try {
      lines = await rpc('weekly_brief_lines', { p_institute: row.institute_id, p_campaign: null, p_money: false });
    } catch (err) {
      out.failed += emails.length || 1;
      say('weekly-brief: institute ' + row.institute_id + ': could not compose (' + err.message + ')');
      continue;
    }
    const mail = composeEmail({ instituteName: row.institute_name, lines, appUrl, today });
    out.emails += emails.length;
    if (dryRun) { out.preview.push({ institute_id: row.institute_id, to: emails.length, subject: mail.subject, lines }); continue; }
    if (!sender.configured) { out.skipped += emails.length; continue; }
    let sent = 0;
    for (const to of emails) {
      try { await sender.send({ to, subject: mail.subject, text: mail.text, html: mail.html }); sent++; } catch (err) {
        out.failed++;
        say('weekly-brief: institute ' + row.institute_id + ': an email failed (' + err.message + ')');
      }
    }
    out.sent += sent;
    say('weekly-brief: institute ' + row.institute_id + ': sent ' + sent + ' of ' + emails.length);
  }
  return out;
}

// The whole request, for index.ts: method and auth checks, then a run. Returns { status, body }.
export async function handleRequest({ method, headers, body, env, fetchImpl, log, today }) {
  if (method !== 'POST') return { status: 405, body: { error: 'Use POST.' } };
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    if (log) log('weekly-brief: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    return { status: 500, body: { error: 'The server is not configured.' } };
  }
  if (!isAuthorised(headers, env)) return { status: 401, body: { error: 'Not allowed.' } };
  try {
    const out = await runWeeklyBrief({
      rpc: makeRpc(env, fetchImpl),
      sender: createSender(env, fetchImpl),
      log,
      appUrl: env.BRIEF_APP_URL || '',
      dryRun: !!(body && body.dry_run === true),
      today,
    });
    return { status: 200, body: out };
  } catch (err) {
    if (log) log('weekly-brief: run failed (' + err.message + ')');
    return { status: 500, body: { error: 'The weekly brief run failed. See the function log.' } };
  }
}
