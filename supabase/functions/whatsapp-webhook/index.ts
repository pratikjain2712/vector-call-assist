// whatsapp-webhook: thin Deno wrapper around logic.mjs (see there for what Meta sends and what is stored).
//
// Deploy:  supabase functions deploy whatsapp-webhook --no-verify-jwt
//          (Meta has no Supabase login; every POST is checked with X-Hub-Signature-256 instead.)
// Secrets: WHATSAPP_APP_SECRET (Meta app > App settings > Basic > App secret) and WHATSAPP_VERIFY_TOKEN
//          (any long random text, typed again in Meta's webhook setup). SUPABASE_URL and
//          SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
// Setup steps: docs/whatsapp-setup.md.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
// @ts-ignore plain JS module, shared with the Node tests
import { handle } from "./logic.mjs";
// @ts-ignore plain JS module, shared with the Node tests
import { makeDeps } from "../_shared/deps.mjs";

const deps = makeDeps(createClient, Deno.env.toObject());
Deno.serve((req: Request) => handle(req, deps));
