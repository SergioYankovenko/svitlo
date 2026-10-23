import { writeFile } from "node:fs/promises";
const [url, key] = process.argv.slice(2);
if (
  !/^https:\/\/[a-z]{20}\.supabase\.co$/.test(url || "") ||
  !key?.startsWith("sb_publishable_")
)
  throw Error("Provide project URL and public publishable key only.");
await writeFile(
  "app/config.js",
  `export default ${JSON.stringify({ supabaseUrl: url, publishableKey: key, apiUrl: url + "/functions/v1/svitlo-api", local: false })};\n`,
);
console.log("Public browser configuration saved.");
