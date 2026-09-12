// Previsualització del dashboard amb dades de producció.
//
// Serveix les pàgines de public/ tal com estan en local i reenvia /api/* i
// /data/* a l'API pública desplegada. Només fa GET a l'API, com qualsevol
// visitant: no necessita credencials ni pot escriure a la base de dades.
//
//   npm run dev:prod   ->  http://localhost:8788
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const ROOT = resolve("public");
const PORT = Number(process.env.PORT ?? 8788);
const UPSTREAM = process.env.UPSTREAM ?? "https://parking.terrassa.workers.dev";
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
};

// Redireccions de public/_redirects, amb el format de Cloudflare («origen destí [codi]»). Només rutes exactes.
const REDIRECTS = new Map();
try {
  for (const line of readFileSync(resolve(ROOT, "_redirects"), "utf8").split("\n")) {
    const [from, to, status] = line.trim().split(/\s+/);
    if (from && to && !from.startsWith("#")) REDIRECTS.set(from, [to, Number(status ?? 302)]);
  }
} catch {
  // sense _redirects, cap redirecció
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/data/")) {
    try {
      const r = await fetch(UPSTREAM + url.pathname + url.search);
      res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/octet-stream", "cache-control": "no-store" });
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) {
      res.writeHead(502, { "content-type": "text/plain" }).end(`No s'ha pogut contactar ${UPSTREAM}: ${e}`);
    }
    return;
  }

  const redirect = REDIRECTS.get(url.pathname);
  if (redirect) { res.writeHead(redirect[1], { location: redirect[0] + url.search }).end(); return; }

  // Com els assets de Cloudflare: / -> index.html, /saba -> saba.html
  let path = url.pathname === "/" ? "/index.html" : url.pathname;
  if (!extname(path)) path += ".html";
  const file = resolve(ROOT, `.${path}`);
  if (!file.startsWith(ROOT + sep)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("no trobat");
  }
}).listen(PORT, () => console.log(`http://localhost:${PORT} (dades de ${UPSTREAM})`));
