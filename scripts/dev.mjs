import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { Service, httpHandler } from "../server/service.js";
import { Source } from "../server/source.js";
import { MemoryDatabase } from "../server/memory.js";
const root = resolve("dist"),
  port = Number(process.env.PORT || 4173),
  origin = `http://localhost:${port}`,
  service = new Service({ db: new MemoryDatabase(), source: new Source() });
createServer(async (req, res) => {
  try {
    const u = new URL(req.url, origin);
    if (u.pathname === "/api") {
      const buffers = [];
      let size = 0;
      for await (const b of req) {
        size += b.length;
        if (size > 16000) {
          res.writeHead(413);
          return res.end();
        }
        buffers.push(b);
      }
      const r = await httpHandler(
        new Request(origin + "/api", {
          method: req.method,
          headers: req.headers,
          ...(req.method === "POST" ? { body: Buffer.concat(buffers) } : {}),
        }),
        service,
        async () => "local-preview",
        [origin, `http://127.0.0.1:${port}`],
      );
      res.writeHead(r.status, Object.fromEntries(r.headers));
      return res.end(Buffer.from(await r.arrayBuffer()));
    }
    if (u.pathname === "/app/config.js") {
      res.writeHead(200, {
        "Content-Type": "text/javascript",
        "Cache-Control": "no-store",
      });
      return res.end(`export default {apiUrl:'/api',local:true};`);
    }
    const path = resolve(
      root,
      "." +
        decodeURIComponent(u.pathname) +
        (u.pathname.endsWith("/") ? "index.html" : ""),
    );
    if (!path.startsWith(root + sep)) {
      res.writeHead(403);
      return res.end();
    }
    const mime = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
      ".png": "image/png",
      ".svg": "image/svg+xml",
      ".webmanifest": "application/manifest+json",
    };
    const body = await readFile(path);
    res.writeHead(200, {
      "Content-Type": mime[extname(path)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}).listen(port, "127.0.0.1", () =>
  console.log(`${origin}/app/ — local source adapter, no production push`),
);
