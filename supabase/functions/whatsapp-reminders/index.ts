// whatsapp-reminders: thin Deno wrapper around logic.mjs (see there for the jobs).
//
// Deploy:  supabase functions deploy whatsapp-reminders --no-verify-jwt
//          (called by the daily schedule, which sends x-cron-secret instead of a login)
// Secrets: WHATSAPP_CRON_SECRET (long random text, also stored in the schedule), WHATSAPP_TOKEN_KEY,
//          WHATSAPP_PLATFORM_TOKEN (only for institutes connected through our Meta business).
// Setup steps and the schedule SQL: docs/whatsapp-setup.md.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
// @ts-ignore plain JS module, shared with the Node tests
import { handle } from "./logic.mjs";
// @ts-ignore plain JS module, shared with the Node tests
import { makeDeps } from "../_shared/deps.mjs";

const deps = makeDeps(createClient, Deno.env.toObject());
Deno.serve((req: Request) => handle(req, deps));
