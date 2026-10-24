import { createClient } from "npm:@supabase/supabase-js@2.106.1";
import { Database } from "../../../server/database.js";
import { syncRegistry } from "../../../server/queue-registry.js";
import { pdfPages } from "../../../server/pdf-pages.js";
const env = (k: string) => Deno.env.get(k) || "";
const db = new Database(
  createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  }),
);
Deno.serve(async (request) => {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const secret = env("CRON_SECRET");
  if (secret.length < 32 || request.headers.get("x-cron-secret") !== secret)
    return new Response(null, { status: 401 });
  try {
    return Response.json(await syncRegistry({ db, pdfPages }));
  } catch {
    return Response.json({ error: "Registry job failed" }, { status: 500 });
  }
});
