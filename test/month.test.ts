/**
 * Proves del CSV mensual. El Worker no el genera: un mes sencer supera els 10 ms
 * de CPU del pla gratuït. El passa tal com el publica la còpia de dades, i és
 * important que no toqui D1 ni el contingut.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import worker, { localParts, monthMirrorUrl, type Env } from "../src/index";

const MIRROR = "https://mirror.example/data";
const MONTH_CSV =
  "timestamp_utc,timestamp_local,parking_id,parking_slug,capacity,available,occupied,occupancy_pct\n" +
  "2026-09-11T10:00:00Z,2026-09-11T12:00:00+02:00,54,placa-vella,297,230,67,22.6\n";

const g = globalThis as unknown as { caches?: unknown };
const realFetch = globalThis.fetch;
let requested: string[] = [];
let puts = 0;

beforeEach(() => {
  requested = [];
  puts = 0;
  g.caches = {
    default: {
      match: async () => undefined,
      put: async (_key: Request, res: Response) => {
        puts++;
        await res.arrayBuffer();
      },
    },
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete g.caches;
});

const mirror = (res: () => Response): void => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    requested.push(input instanceof Request ? input.url : String(input));
    return res();
  }) as typeof fetch;
};

const env = (): Env =>
  ({
    // Qualsevol accés a D1 fa fallar la petició (i la prova).
    DB: new Proxy({}, { get: () => { throw new Error("el CSV mensual no ha de llegir D1"); } }),
    ASSETS: {},
    DATA_MIRROR_URL: MIRROR,
  }) as unknown as Env;

const get = (path: string): Promise<Response> =>
  worker.fetch(new Request(`https://parking.example${path}`) as never, env(), {} as never);

test("l'adreça del mes és AAAA/AAAA-MM.csv dins la còpia", () => {
  assert.equal(monthMirrorUrl(MIRROR, "2026-09"), "https://mirror.example/data/2026/2026-09.csv");
  assert.equal(monthMirrorUrl(`${MIRROR}/`, "2026-09"), "https://mirror.example/data/2026/2026-09.csv");
});

test("el CSV mensual es passa tal com és, amb les capçaleres del dataset i sense llegir D1", async () => {
  mirror(() => new Response(MONTH_CSV, { headers: { "Content-Type": "text/plain; charset=utf-8" } }));
  const res = await get("/data/2020-01.csv");
  assert.equal(res.status, 200);
  assert.deepEqual(requested, [`${MIRROR}/2020/2020-01.csv`]);
  assert.equal(res.headers.get("Content-Type"), "text/csv; charset=utf-8");
  assert.equal(res.headers.get("Content-Disposition"), 'inline; filename="parking-terrassa-2020-01.csv"');
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(await res.text(), MONTH_CSV);
  assert.equal(puts, 1);
});

test("es conserva la codificació de la còpia, perquè el cos passi comprimit sense descomprimir-lo", async () => {
  mirror(() => new Response(MONTH_CSV, { headers: { "Content-Encoding": "gzip" } }));
  const res = await get("/data/2020-01.csv");
  assert.equal(res.headers.get("Content-Encoding"), "gzip");
  assert.equal(res.headers.get("Content-Type"), "text/csv; charset=utf-8");
});

test("un mes tancat es guarda un dia a la cache; el mes en curs, una hora", async () => {
  mirror(() => new Response(MONTH_CSV));
  assert.equal((await get("/data/2020-01.csv")).headers.get("Cache-Control"), "public, max-age=86400");
  const thisMonth = localParts(new Date(), "Europe/Madrid").local_date.slice(0, 7);
  assert.equal((await get(`/data/${thisMonth}.csv`)).headers.get("Cache-Control"), "public, max-age=3600");
});

test("un mes sense còpia respon 404 i no es guarda a la cache", async () => {
  mirror(() => new Response("404: Not Found", { status: 404 }));
  const res = await get("/data/2031-01.csv");
  assert.equal(res.status, 404);
  assert.equal(((await res.json()) as { error: string }).error, "no trobat");
  assert.equal(puts, 0);
});

test("si la còpia falla, 502 sense guardar-ho a la cache", async () => {
  mirror(() => new Response("error", { status: 503 }));
  const res = await get("/data/2020-01.csv");
  assert.equal(res.status, 502);
  assert.equal(puts, 0);
});
