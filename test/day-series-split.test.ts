/**
 * Proves de la partició del dia en curs (`/api/day/AAAA-MM-DD/series`).
 *
 * El dia en curs es serveix en dos trossos —el tancat, que es guarda a la cache
 * amb el tall de l'hora a la clau, i el viu, que va per la clau primària— per no
 * rellegir el dia sencer de D1 a cada petició. Tot el valor del canvi depèn de
 * dues coses que no es veuen des de fora i que aquí es fixen: que la unió dels
 * dos trossos sigui exactament el dia sencer, i que el tros tancat es llegeixi
 * un sol cop per hora.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { clearMemoryCache, daySeries, mergeDaySeries, toDaySeries } from "../src/index";
import type { Env } from "../src/index";

type Row = Parameters<typeof toDaySeries>[1][number] & { local_date: string };

const SLUGS = { 53: "dr-robert", 54: "placa-vella", 55: "ajuntament-mercat" } as const;
const CAPS = { 53: 407, 54: 297, 55: 237 } as const;

/** Lectures minut a minut per als tres pàrquings, a partir de `startUtc`. */
function dayRows(day: string, startUtc: number, minutes: number): Row[] {
  const rows: Row[] = [];
  for (let m = 0; m < minutes; m++) {
    for (const id of [53, 54, 55] as const) {
      rows.push({
        ts: startUtc + m * 60,
        parking_id: id,
        slug: SLUGS[id],
        capacity: CAPS[id],
        available: (m * 7 + id) % CAPS[id],
        local_date: day,
      });
    }
  }
  return rows;
}

// Les tres formes de `WHERE` que fa servir `queryReadings`, per poder dir quina
// consulta s'ha fet sense repetir-ne el literal a cada asserció.
const isFullDay = (sql: string): boolean => /WHERE r\.local_date = \?1\s*\n\s*ORDER BY/.test(sql);
const isClosed = (sql: string): boolean => sql.includes("r.local_date = ?1 AND r.ts < ?2");
const isLive = (sql: string): boolean => sql.includes("r.ts >= ?1 AND r.ts < ?2");

/**
 * D1 de mentida. Guarda la referència a `rows`, de manera que una prova pot
 * afegir-hi lectures a mig camí i veure-les a la consulta següent.
 */
function fakeDb(rows: Row[]) {
  const queries: { sql: string; binds: unknown[] }[] = [];
  const run = (sql: string, b: unknown[]): Row[] => {
    let out: Row[];
    if (isClosed(sql)) out = rows.filter((r) => r.local_date === b[0] && r.ts < (b[1] as number));
    else if (isLive(sql)) out = rows.filter((r) => r.ts >= (b[0] as number) && r.ts < (b[1] as number));
    else if (isFullDay(sql)) out = rows.filter((r) => r.local_date === b[0]);
    else throw new Error(`consulta inesperada: ${sql}`);
    return [...out].sort((x, y) => x.ts - y.ts || x.parking_id - y.parking_id);
  };
  const env = {
    DB: {
      prepare: (sql: string) => ({
        bind: (...binds: unknown[]) => ({
          all: async () => {
            queries.push({ sql, binds });
            return { results: run(sql, binds) };
          },
        }),
      }),
    },
  } as unknown as Env;
  return { env, queries };
}

// Cache de la vora de mentida, amb la mateixa semàntica de clonatge que la
// real. Es posa i es treu a cada prova, com fa `test/month.test.ts`.
const g = globalThis as unknown as { caches?: unknown };

beforeEach(() => {
  // La cache en memòria és de mòdul i sobreviuria d'una prova a l'altra: hi ha
  // proves que comparteixen dia i tall, i per tant clau.
  clearMemoryCache();
  const store = new Map<string, Response>();
  g.caches = {
    default: {
      match: async (k: Request) => store.get(k.url)?.clone(),
      put: async (k: Request, v: Response) => void store.set(k.url, v.clone()),
    },
  };
});

afterEach(() => {
  delete g.caches;
});

const req = (day: string) => new Request(`https://example.com/api/day/${day}/series`);

// 2026-09-18, Europe/Madrid (CEST, UTC+2): el dia local va de les 22:00 UTC del
// 17 a les 22:00 UTC del 18.
const DAY = "2026-09-18";
const DAY_START_UTC = Date.UTC(2026, 8, 17, 22, 0, 0) / 1000;

test("la unió del tros tancat i el viu és el dia sencer, per a qualsevol tall d'hora", () => {
  const rows = dayRows(DAY, DAY_START_UTC, 1440);
  const sencer = toDaySeries(DAY, rows);
  for (let h = 0; h < 24; h++) {
    const cutoff = DAY_START_UTC + h * 3600;
    const tancat = toDaySeries(DAY, rows.filter((r) => r.ts < cutoff));
    const viu = toDaySeries(DAY, rows.filter((r) => r.ts >= cutoff));
    assert.deepEqual(mergeDaySeries(tancat, viu), sencer, `tall a l'hora ${h}`);
  }
});

test("un pàrquing que només apareix al tros viu s'hi afegeix, en ordre d'id", () => {
  const base = toDaySeries(DAY, dayRows(DAY, DAY_START_UTC, 1).filter((r) => r.parking_id === 55));
  const extra = toDaySeries(DAY, dayRows(DAY, DAY_START_UTC + 60, 1));
  assert.deepEqual(
    mergeDaySeries(base, extra).parkings.map((p) => p.parking_id),
    [53, 54, 55],
  );
});

test("el dia en curs dona el mateix que el dia sencer, i el tros tancat es llegeix un sol cop per hora", async () => {
  const rows = dayRows(DAY, DAY_START_UTC, 700); // el dia a mitges
  const nowTs = rows[rows.length - 1]!.ts;
  const { env, queries } = fakeDb(rows);

  for (let i = 0; i < 5; i++) {
    assert.deepEqual(await daySeries(req(DAY), env, DAY, DAY, "Europe/Madrid", nowTs + i * 60), toDaySeries(DAY, rows));
  }
  assert.equal(queries.filter((q) => isClosed(q.sql)).length, 1, "el tros tancat, un sol cop");
  assert.equal(queries.filter((q) => isLive(q.sql)).length, 5, "el tros viu, un cop per petició");
  // I cap consulta del dia sencer, que és la que es volia evitar.
  assert.equal(queries.filter((q) => isFullDay(q.sql)).length, 0);

  // L'hora següent estrena tall: el tros tancat es torna a llegir, un sol cop.
  const seguent = nowTs + 3600;
  await daySeries(req(DAY), env, DAY, DAY, "Europe/Madrid", seguent);
  await daySeries(req(DAY), env, DAY, DAY, "Europe/Madrid", seguent + 60);
  assert.equal(queries.filter((q) => isClosed(q.sql)).length, 2);
});

test("un dia passat es llegeix sencer: no té tros viu", async () => {
  const rows = dayRows(DAY, DAY_START_UTC, 1440);
  const { env, queries } = fakeDb(rows);
  const out = await daySeries(req(DAY), env, DAY, "2026-09-21", "Europe/Madrid", DAY_START_UTC + 3 * 86_400);
  assert.deepEqual(out, toDaySeries(DAY, rows));
  assert.equal(queries.length, 1);
  assert.ok(isFullDay(queries[0]!.sql));
});

test("si la mitjanit local no cau en punt, es torna a la consulta del dia sencer", async () => {
  // Asia/Kolkata va UTC+5:30: la mitjanit local cau a les 18:30 UTC, a mitja
  // hora UTC, de manera que la finestra del tall no és tota del mateix dia local
  // i el tros viu (que només mira el `ts`) hi barrejaria lectures del dia d'abans.
  const day = "2026-09-19";
  const rows = dayRows(day, Date.UTC(2026, 8, 18, 18, 30, 0) / 1000, 30);
  const { env, queries } = fakeDb(rows);
  const nowTs = Date.UTC(2026, 8, 18, 18, 45, 0) / 1000; // 00:15 local
  const out = await daySeries(req(day), env, day, day, "Asia/Kolkata", nowTs);
  // La consulta de recanvi demana el dia per `local_date`, de manera que en
  // retorna totes les lectures, no només les anteriors a «ara».
  assert.deepEqual(out, toDaySeries(day, rows));
  assert.equal(queries.length, 1);
  assert.ok(isFullDay(queries[0]!.sql));
});

test("a Europe/Madrid la partició val també el dia del canvi d'hora", async () => {
  // 2026-10-25: CEST -> CET a les 03:00 locals (01:00 UTC). El dia local dura
  // 25 hores i la mitjanit segueix caient en punt d'UTC, així que es parteix.
  const day = "2026-10-25";
  const rows = dayRows(day, Date.UTC(2026, 9, 24, 22, 0, 0) / 1000, 600);
  const nowTs = rows[rows.length - 1]!.ts;
  const { env, queries } = fakeDb(rows);
  const out = await daySeries(req(day), env, day, day, "Europe/Madrid", nowTs);
  assert.deepEqual(out, toDaySeries(day, rows));
  assert.ok(queries.some((q) => isClosed(q.sql)), "s'ha de partir");
});

test("una lectura amb un `ts` futur no s'escola al tros viu", async () => {
  const rows = dayRows(DAY, DAY_START_UTC, 700);
  const nowTs = rows[rows.length - 1]!.ts;
  // El tros viu acaba al final de l'hora que corre: la fila de prova ha de
  // quedar per sobre d'aquest límit.
  const futura = { ...rows[0]!, ts: Math.floor(nowTs / 3600) * 3600 + 2 * 3600 };
  const { env } = fakeDb([...rows, futura]);
  assert.deepEqual(await daySeries(req(DAY), env, DAY, DAY, "Europe/Madrid", nowTs), toDaySeries(DAY, rows));
});

test("una lectura que arriba tard surt de seguida, no una hora després", async () => {
  // La captura de l'últim minut d'una hora es pot desar ja passada l'hora (un
  // cron endarrerit, o el reintent de cinc segons). Si el tros tancat es
  // congelés just a l'hora en punt, aquell minut no es veuria fins a la següent.
  const enPunt = DAY_START_UTC + 840 * 60; // 12:00 UTC, 14:00 local
  const rows = dayRows(DAY, DAY_START_UTC, 839); // ... i hi falta el minut 11:59
  const tardana = dayRows(DAY, enPunt - 60, 1);
  const desades = [...rows];
  const { env } = fakeDb(desades); // `fakeDb` en guarda la referència

  // Primera petició, just passada l'hora: la lectura encara no hi és, i aquí és
  // on es calcula i es congela el tros tancat.
  assert.deepEqual(await daySeries(req(DAY), env, DAY, DAY, "Europe/Madrid", enPunt + 5), toDaySeries(DAY, rows));

  desades.push(...tardana); // ara arriba, amb el `ts` de l'hora que ja ha passat

  // La petició següent l'ha de portar, sense esperar el tall de l'hora vinent.
  assert.deepEqual(
    await daySeries(req(DAY), env, DAY, DAY, "Europe/Madrid", enPunt + 65),
    toDaySeries(DAY, [...rows, ...tardana]),
  );
});
