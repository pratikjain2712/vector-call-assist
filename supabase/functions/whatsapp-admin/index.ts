// whatsapp-admin: thin Deno wrapper around logic.mjs (connect a number, submit templates, read their status).
//
// Deploy:  supabase functions deploy whatsapp-admin          (JWT check on: only signed-in admins)
// Secrets: WHATSAPP_TOKEN_KEY (base64, 32 bytes) encrypts each institute's token before it is stored;
//          WHATSAPP_PLATFORM_TOKEN only when institutes are connected through our own Meta business.
// Setup steps: docs/whatsapp-setup.md.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
// @ts-ignore plain JS module, shared with the Node tests
import { handle } from "./logic.mjs";
// @ts-ignore plain JS module, shared with the Node tests
import { makeDeps } from "../_shared/deps.mjs";

const deps = makeDeps(createClient, Deno.env.toObject());
Deno.serve((req: Request) => handle(req, deps));
