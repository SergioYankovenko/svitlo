import { createClient } from "npm:@supabase/supabase-js@2.106.1";
import webpush from "npm:web-push@3.6.7";
import { Database } from "../../../server/database.js";
import { Source } from "../../../server/source.js";
import { operatorFetch } from "../../../server/transport.js";
import { Service } from "../../../server/service.js";
const env = (k: string) => Deno.env.get(k) || "";
const db = new Database(
  createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  }),
);
const service = new Service({
  db,
  source: new Source(operatorFetch),
  push: async (subscription: unknown, payload: unknown) => {
    webpush.setVapidDetails(
      env("VAPID_SUBJECT"),
      env("VAPID_PUBLIC_KEY"),
      env("VAPID_PRIVATE_KEY"),
    );
    await webpush.sendNotification(subscription, JSON.stringify(payload), {
      TTL: 3600,
      timeout: 10000,
      urgency: "normal",
    });
  },
});
Deno.serve(async (request) => {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const expected = env("CRON_SECRET"),
    actual = request.headers.get("x-cron-secret") || "";
  if (!expected || expected.length < 32 || actual !== expected)
    return new Response(null, { status: 401 });
  try {
    return Response.json(await service.jobs());
  } catch {
    return Response.json({ error: "Job failed" }, { status: 500 });
  }
});
