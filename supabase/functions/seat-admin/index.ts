// seat-admin: seat actions for the Vector admin page (web/admin.html).
//
// Deploy:  supabase functions deploy seat-admin
// Secret:  SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided to deployed functions
//          by Supabase, so nothing needs setting by hand. The service role key is used only to send
//          invitation emails. It must never be put in this repo or in the web page. Check the function
//          log if it answers "server not configured".
//
// Request:  POST with "Authorization: Bearer <the admin's access token>" and a JSON body:
//   {action:"invite",     institute, email, label, role}   role is "rep" (caller), "admin" (manager; the first
//                                                          admin is the owner) or "accounts" (owners only, A.2).
//                                                          "caller" and "manager" are read as "rep" and "admin"
//   {action:"reassign",   seat, email}
//   {action:"revoke",     seat}
//   {action:"reset_pairing", seat, kind}                   kind is "phone" or "laptop"
// Every database call runs with the caller's own token, so the RPC admin checks in the migrations decide.
// The own-seat rule (no revoke or reassign of your own seat) is checked here as well as on the page.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function reply(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

type DbError = { code?: string; message?: string };

// Messages from our own database functions are raised with RAISE EXCEPTION (code P0001) and are safe to show.
// Anything else is logged here only and answered with a generic message.
function dbFailure(err: DbError | null): Response {
  const code = err?.code ?? "";
  if (code === "P0001") return reply(400, { error: err?.message ?? "Not done." });
  if (code === "42501") {
    return reply(403, { error: /accounts/i.test(err?.message ?? "") ? "Only an owner can add an Accounts seat." : "You are not allowed to do that." });
  }
  if (code === "23505") return reply(409, { error: "This email already has an invited seat here." });
  console.error("seat-admin database error", code, err?.message);
  return reply(500, { error: "Something went wrong. Try again." });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function text(body: Record<string, unknown>, key: string, max: number): string | null {
  const v = body[key];
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 && t.length <= max ? t : null;
}

// Sends the invitation email. Returns false when the person already has an account (they sign in with
// the emailed link instead). Throws on any other failure.
async function sendInvite(email: string): Promise<boolean> {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const admin: SupabaseClient = createClient(url, service, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await admin.auth.admin.inviteUserByEmail(email);
  if (!error) return true;
  const already = error.code === "email_exists" || /already.*registered|already been registered/i.test(error.message);
  if (already) return false;
  throw error;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return reply(405, { error: "Use POST." });

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !anon || !service) {
    console.error("seat-admin: missing SUPABASE_URL, SUPABASE_ANON_KEY or SUPABASE_SERVICE_ROLE_KEY");
    return reply(500, { error: "The server is not configured for seat changes." });
  }

  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return reply(401, { error: "Sign in first." });

  let body: Record<string, unknown>;
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return reply(400, { error: "The request is not valid JSON." });
  }

  // The caller's own token: every RPC below is checked as this person by the database.
  const db: SupabaseClient = createClient(url, anon, {
    global: { headers: { Authorization: auth } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: who, error: whoErr } = await db.auth.getUser();
  if (whoErr || !who?.user) return reply(401, { error: "Sign in first." });

  const action = typeof body.action === "string" ? body.action : "";
  // Phase A.2: the roles invite_seat takes. It checks the seat limit and that only an owner adds Accounts.
  const inviteRole = (v: unknown): string | null =>
    ({ rep: "rep", caller: "rep", admin: "admin", manager: "admin", accounts: "accounts" } as Record<string, string>)[
      typeof v === "string" ? v : ""
    ] ?? null;

  if (action === "invite") {
    const institute = typeof body.institute === "string" && UUID.test(body.institute) ? body.institute : null;
    const email = text(body, "email", 254)?.toLowerCase() ?? null;
    const label = text(body, "label", 80);
    const role = inviteRole(body.role);
    if (!institute || !email || !EMAIL.test(email) || !label || !role) {
      return reply(400, { error: "Give the institute, a valid email, a label and a role." });
    }
    const { data: seatId, error } = await db.rpc("invite_seat", {
      p_institute: institute, p_email: email, p_label: label, p_role: role,
    });
    if (error) return dbFailure(error);
    try {
      const sent = await sendInvite(email);
      return reply(200, { ok: true, seat_id: seatId, email_sent: sent });
    } catch (e) {
      // The person got no invitation, so take the new seat back: nothing is left half done.
      console.error("seat-admin invite email failed", (e as DbError)?.message);
      await db.rpc("revoke_seat", { p_seat: seatId });
      return reply(502, { error: "The invitation email could not be sent, so no seat was added. Try again." });
    }
  }

  if (action === "reassign" || action === "revoke" || action === "reset_pairing") {
    const seat = typeof body.seat === "string" && UUID.test(body.seat) ? body.seat : null;
    if (!seat) return reply(400, { error: "Choose a seat." });

    if (action === "reassign" || action === "revoke") {
      const { data: mine, error: mineErr } = await db.rpc("my_active_seat");
      if (mineErr) return dbFailure(mineErr);
      const row = Array.isArray(mine) ? mine[0] : mine;
      if (row?.id === seat) {
        return reply(400, { error: action === "revoke" ? "You cannot revoke your own seat." : "You cannot reassign your own seat." });
      }
    }

    if (action === "revoke") {
      const { error } = await db.rpc("revoke_seat", { p_seat: seat });
      return error ? dbFailure(error) : reply(200, { ok: true });
    }

    if (action === "reset_pairing") {
      const kind = typeof body.kind === "string" ? body.kind : "";
      const { error } = await db.rpc("reset_pairing", { p_seat: seat, p_kind: kind });
      return error ? dbFailure(error) : reply(200, { ok: true });
    }

    // reassign: the new person needs an account to claim the seat, so they get the invitation too.
    const email = text(body, "email", 254)?.toLowerCase() ?? null;
    if (!email || !EMAIL.test(email)) return reply(400, { error: "Enter a valid email address." });
    const { error } = await db.rpc("reassign_seat", { p_seat: seat, p_email: email });
    if (error) return dbFailure(error);
    try {
      const sent = await sendInvite(email);
      return reply(200, { ok: true, email_sent: sent });
    } catch (e) {
      console.error("seat-admin reassign email failed", (e as DbError)?.message);
      return reply(200, {
        ok: true,
        email_sent: false,
        note: "The seat was reassigned, but the invitation email failed. Send the invitation again from your email settings.",
      });
    }
  }

  return reply(400, { error: "Unknown action." });
});
