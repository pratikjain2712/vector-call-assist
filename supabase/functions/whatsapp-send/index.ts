// whatsapp-send: thin Deno wrapper around logic.mjs (see there for the request and the checks).
//
// Deploy:  supabase functions deploy whatsapp-send          (JWT check on: only signed-in people)
// Secrets: WHATSAPP_TOKEN_KEY (base64, 32 bytes) decrypts institute tokens; WHATSAPP_PLATFORM_TOKEN only when
//          institutes are connected through our own Meta business; WHATSAPP_GRAPH_VERSION optional.
//          SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
// Setup steps: docs/whatsapp-setup.md.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
// @ts-ignore plain JS module, shared with the Node tests
import { handle } from "./logic.mjs";
// @ts-ignore plain JS module, shared with the Node tests
import { makeDeps } from "../_shared/deps.mjs";

const deps = makeDeps(createClient, Deno.env.toObject());
Deno.serve((req: Request) => handle(req, deps));
