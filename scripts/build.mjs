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
const files = async (dir) =>
  (
    await Promise.all(
      (await readdir(dir, { withFileTypes: true })).map(async (e) =>
        e.isDirectory() ? files(dir + "/" + e.name) : [dir + "/" + e.name],
      ),
    )
  ).flat();
const list = await files("app");
// GitHub Pages serves repository bytes. Canonical LF must be hashed and copied,
// even when the Windows checkout uses automatic CRLF conversion.
for (const file of list.filter(f=>/\.(?:js|html|css|json|webmanifest|svg)$/.test(f))) {
  const source=await readFile(file,'utf8'),canonical=source.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n');
  if(source!==canonical)await writeFile(file,canonical);
}
await cp("app", "dist/app", { recursive: true });
const hash = createHash("sha256");
for (const f of list.filter((f) => !f.endsWith("/sw.js"))) {
  const body=await readFile(f);
  hash.update(f.endsWith('/index.html')?body.toString().replace(/data-shell="[^"]*"/,'data-shell="development"'):body);
}
const version = hash.digest("hex").slice(0, 12);
const html=(await readFile('app/index.html','utf8')).replace(/data-shell="[^"]*"/,`data-shell="svitlo-pwa-${version}"`);
await writeFile('app/index.html',html);await writeFile('dist/app/index.html',html);
let sw = await readFile("app/sw.js", "utf8");
sw = sw.replace(
  /(["'])svitlo-pwa-[^"']+\1/,
  JSON.stringify(`svitlo-pwa-${version}`),
);
sw = sw.replace(/const SHELL = \[[\s\S]*?\];/, "const SHELL = "+JSON.stringify(["./",...list.filter(f=>!f.endsWith("/sw.js")).map(f=>"./"+f.slice(4))])+";");
const integrity={};
for(const f of list.filter(f=>!f.endsWith('/sw.js')))integrity['./'+f.slice(4)]=createHash('sha256').update(await readFile(f)).digest('hex');
sw=sw.replace(/const HASHES = \{[^;]*\};/, 'const HASHES = '+JSON.stringify(integrity)+';');
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
