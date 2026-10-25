// Rebuilds the demo institute "Sunrise Coaching Academy (Demo)" with fresh dates, so "Today" on Home is live.
// Only the demo owner (owner.sunrise@example.com) may call it. It runs supabase/demo/demo_seed.sql as one
// transaction against this project's database; the seed touches the demo institute only (docs/demo.md).
// The 7 demo logins must already exist. Deploy with JWT verification on.
import postgres from "npm:postgres@3.4.5";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const DEMO_OWNER = "owner.sunrise@example.com";
// Pinned to a commit so a later push cannot change what this function runs.
const SEED_URL =
  "https://raw.githubusercontent.com/pratikjain2712/vector-call-assist/1898f1b/supabase/demo/demo_seed.sql";

// The seed is written for psql: drop its backslash commands and fill in its three variables.
function plainSql(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("\\"))
    .join("\n")
    .replace(":'terms_version'", "'2026-10-draft'")
    .replace(":'terms_hash'", "'3732a16861029ea50ec162fa0c7dcb85885f3ccf4eec06682d80d89af8fe32d1'")
    .replace(":'demo_seed'", "'0.2410'")
    .replace(" as _s \\gset", " as _s;");
}

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return reply(405, { error: "use POST" });
  const auth = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false },
  });
  const { data: who } = await auth.auth.getUser();
  if (who?.user?.email?.toLowerCase() !== DEMO_OWNER) return reply(403, { error: "demo owner only" });

  const res = await fetch(SEED_URL);
  if (!res.ok) return reply(502, { error: "could not fetch the demo seed", status: res.status });
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
  try {
    await sql.unsafe(plainSql(await res.text())).simple();
    const [row] = await sql`
      select count(*)::int as calls from public.call_outcomes
      where institute_id = '5a1e0000-0000-4000-8000-000000000001'`;
    return reply(200, { ok: true, calls: row.calls });
  } catch (err) {
    return reply(500, { error: String((err as Error).message ?? err) });
  } finally {
    await sql.end();
  }
});
