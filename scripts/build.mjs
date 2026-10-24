import { build } from "esbuild";
import { mkdir, cp, readFile, writeFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
await mkdir("app/vendor", { recursive: true });
await build({
  stdin: {
    contents: 'export {createClient} from "@supabase/supabase-js";',
    resolveDir: process.cwd(),
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "safari16.4",
  outfile: "app/vendor/supabase.js",
  minify: true,
});
await mkdir("dist/app", { recursive: true });
await cp("app", "dist/app", { recursive: true });
const files = async (dir) =>
  (
    await Promise.all(
      (await readdir(dir, { withFileTypes: true })).map(async (e) =>
        e.isDirectory() ? files(dir + "/" + e.name) : [dir + "/" + e.name],
      ),
    )
  ).flat();
const list = await files("app"),
  hash = createHash("sha256");
for (const f of list.filter((f) => !f.endsWith("/sw.js")))
  hash.update(await readFile(f));
const version = hash.digest("hex").slice(0, 12);
let sw = await readFile("app/sw.js", "utf8");
sw = sw.replace(
  /(["'])svitlo-pwa-[^"']+\1/,
  JSON.stringify(`svitlo-pwa-${version}`),
);
await writeFile("dist/app/sw.js", sw);
await writeFile("app/sw.js", sw);
await mkdir(".local/bundles", { recursive: true });
for (const name of ["svitlo-api", "svitlo-jobs", "svitlo-registry"])
  await build({
    entryPoints: [`supabase/functions/${name}/index.ts`],
    bundle: true,
    format: "esm",
    platform: "neutral",
    external: ["npm:*", "node:*"],
    alias: { unpdf: "npm:unpdf@1.9.1" },
    outfile: `.local/bundles/${name}.ts`,
  });
console.log(`Built PWA ${version}: dist/app; Edge bundles: .local/bundles`);
