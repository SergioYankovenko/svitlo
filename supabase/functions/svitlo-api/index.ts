import { createClient } from "npm:@supabase/supabase-js@2.106.1";
import { Database } from "../../../server/database.js";
import { Source } from "../../../server/source.js";
import { operatorFetch } from "../../../server/transport.js";
import { Service, httpHandler, ApiError } from "../../../server/service.js";
const env = (k: string) => Deno.env.get(k) || "";
const admin = createClient(
  env("SUPABASE_URL"),
  env("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const service = new Service({
  db: new Database(admin),
  source: new Source(operatorFetch),
  vapid: env("VAPID_PUBLIC_KEY"),
});
Deno.serve((request) =>
  httpHandler(
    request,
    service,
    async (req: Request) => {
      const token = req.headers.get("Authorization")?.replace(/^Bearer /, "");
      if (!token) throw new ApiError(401, "Потрібне підключення");
      const { data, error } = await admin.auth.getUser(token);
      if (error || !data.user)
        throw new ApiError(
          401,
          "Сеанс завершився. Відкрийте застосунок повторно.",
        );
      return data.user.id;
    },
    env("ALLOWED_ORIGINS").split(",").filter(Boolean),
  ),
);
