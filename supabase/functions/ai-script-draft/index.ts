// ai-script-draft: the AI script maker for the Scripts tab of the admin page (web/admin.html).
//
// Deploy:  supabase functions deploy ai-script-draft
// Secrets: ANTHROPIC_API_KEY (set with `supabase secrets set ANTHROPIC_API_KEY=...`; never in this repo or the
//          web page). Optional: ANTHROPIC_MODEL_DRAFT (default claude-haiku-5-5) and ANTHROPIC_MODEL_FALLBACK
//          (default claude-sonnet-5-5), so the model can change without a release.
//          SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase. The service
//          role is used only for the request log (ai_reserve_request, ai_finish_request).
//
// Request:  POST with "Authorization: Bearer <the admin's access token>" and a JSON body:
//   {action:"draft",    brief:{call_type, audience, language, purpose, facts, never_say}}
//   {action:"simplify", brief, script:{name, call_type, steps, pushbacks}, target:{step, line} | {pushback} | null}
// Answer:   200 {script, checks:{passed, failures, problems, marks, score}, model, usage:{used, monthly_limit, ...}}
//           or {error} with 400, 401, 403, 429 (monthly limit), 500 or 502.
// Everything else is in logic.mjs (tested in Node: tests/web/ai-script-draft.test.js). script-model.js and
// script-templates.js are exact copies of the files in web/js/ (that test fails when they differ).
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";
import "./script-model.js";
import "./script-templates.js";
import { DEFAULT_MODEL, FALLBACK_MODEL, handle } from "./logic.mjs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function reply(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

// script-model.js and script-templates.js set these globals when imported.
// deno-lint-ignore no-explicit-any
const g = globalThis as any;

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return reply(405, { error: "Use POST." });

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !anon || !service) {
    console.error("ai-script-draft: missing SUPABASE_URL, SUPABASE_ANON_KEY or SUPABASE_SERVICE_ROLE_KEY");
    return reply(500, { error: "The server is not configured for AI drafts." });
  }
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return reply(400, { error: "The request is not valid JSON." });
  }

  // The admin's own token: the database checks the seat and the add-on as this person.
  const userDb: SupabaseClient = createClient(url, anon, {
    global: { headers: { Authorization: auth } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const serviceDb: SupabaseClient = createClient(url, service, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const rpc = async (client: SupabaseClient, name: string, args?: Record<string, unknown>) => {
    const { data, error } = await client.rpc(name, args);
    if (error) throw new Error(error.message);
    return data;
  };
  const first = (d: unknown) => (Array.isArray(d) ? d[0] : d);

  const db = {
    userFromToken: async (t: string) => {
      const { data, error } = await userDb.auth.getUser(t);
      return error || !data?.user ? null : data.user;
    },
    activeSeat: async () => first(await rpc(userDb, "my_active_seat")) ?? null,
    hasFeature: async (inst: string, f: string) => (await rpc(userDb, "has_feature", { inst, feature: f })) === true,
    callTypes: async () => await rpc(userDb, "admin_list_call_types"),
    usage: async () => first(await rpc(userDb, "admin_ai_usage")) ?? null,
    reserve: async (inst: string, seat: string, kind: string) =>
      await rpc(serviceDb, "ai_reserve_request", { p_institute: inst, p_seat: seat, p_kind: kind }),
    // deno-lint-ignore no-explicit-any
    finish: async (id: number, r: any) => {
      await rpc(serviceDb, "ai_finish_request", {
        p_id: id, p_model: r.model, p_attempts: r.attempts, p_input: r.input, p_output: r.output,
        p_cache_read: r.cache_read, p_cache_write: r.cache_write, p_cost: r.cost, p_ok: r.ok,
      });
    },
  };

  try {
    const out = await handle({
      body,
      token,
      env: {
        apiKey: Deno.env.get("ANTHROPIC_API_KEY") ?? "",
        models: {
          draft: Deno.env.get("ANTHROPIC_MODEL_DRAFT") || DEFAULT_MODEL,
          fallback: Deno.env.get("ANTHROPIC_MODEL_FALLBACK") || FALLBACK_MODEL,
        },
      },
      fetchFn: fetch,
      ScriptModel: g.ScriptModel,
      templates: g.ScriptTemplates.TEMPLATES,
      db,
    });
    return reply(out.status, out.body);
  } catch (e) {
    console.error("ai-script-draft error", (e as Error)?.message);
    return reply(500, { error: "Something went wrong. Try again." });
  }
});
