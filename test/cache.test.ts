/**
 * Cache en memòria de l'API. A `*.workers.dev` l'API de cache de Cloudflare no
 * desa res, de manera que sense aquesta capa cada petició tornaria a llegir D1.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import worker, { clearMemoryCache, type Env } from "../src/index";

const g = globalThis as unknown as { caches?: unknown };
let queries = 0;

// Com a workers.dev: la cache de la vora no troba ni desa mai res.
beforeEach(() => {
  queries = 0;
  clearMemoryCache();
  g.caches = { default: { match: async () => undefined, put: async () => undefined } };
});

afterEach(() => {
  delete g.caches;
});

const env = {
  DB: {
    prepare: () => ({
      all: async () => {
        queries++;
        return { results: [{ id: 54, slug: "placa-vella" }] };
      },
    }),
  },
} as unknown as Env;

const get = (path: string): Promise<Response> =>
  worker.fetch!(new Request(`https://parking.example${path}`) as never, env, {} as never) as Promise<Response>;

test("una segona petició igual no torna a llegir D1", async () => {
  const a = await get("/api/parkings");
  const b = await get("/api/parkings");
  assert.equal(queries, 1);
  assert.equal(a.status, 200);
  assert.deepEqual(await b.json(), await a.json());
  assert.match(b.headers.get("Cache-Control") ?? "", /max-age=3600/);
});

test("la resposta en memòria es pot llegir més d'una vegada", async () => {
  await get("/api/parkings");
  const b = await get("/api/parkings");
  const c = await get("/api/parkings");
  assert.equal(await b.text(), await c.text());
  assert.equal(queries, 1);
});
