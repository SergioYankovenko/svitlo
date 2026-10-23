import webpush from "web-push";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile, access } from "node:fs/promises";
await mkdir(".local", { recursive: true });
const path = ".local/server-secrets.env";
try {
  await access(path);
  throw Error(
    "Secrets already exist; preserve VAPID keys for existing subscriptions.",
  );
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
const keys = webpush.generateVAPIDKeys();
await writeFile(
  path,
  `VAPID_PUBLIC_KEY=${keys.publicKey}\nVAPID_PRIVATE_KEY=${keys.privateKey}\nVAPID_SUBJECT=https://sergioyankovenko.github.io/svitlo/app/\nCRON_SECRET=${randomBytes(32).toString("hex")}\nALLOWED_ORIGINS=https://sergioyankovenko.github.io\n`,
  { mode: 0o600 },
);
console.log(
  "Created ignored .local/server-secrets.env. Secret values were not printed.",
);
