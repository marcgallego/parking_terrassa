/**
 * Proves de la partició del dia en curs (`/api/day/AAAA-MM-DD/series`).
 *
 * El dia en curs es serveix en dos trossos —el tancat, que es guarda a la cache
 * amb el tall de l'hora a la clau, i el viu, que va per la clau primària— per no
 * rellegir el dia sencer de D1 cada minut. Aquí es comprova el que ha de ser
 * cert perquè això no canviï res del que es veu:
 *
 * - la unió dels dos trossos és exactament el dia sencer, per a qualsevol tall;
 * - el tros tancat es llegeix un sol cop per hora, que és tot el sentit del canvi;
 * - si l'hora del tall no cau sencera dins del dia local, es torna a la consulta
 *   d'abans en lloc d'endevinar.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { daySeries, mergeDaySeries, toDaySeries } from "../src/index";
import type { Env } from "../src/index";

type Row = Parameters<typeof toDaySeries>[1][number] & { local_date: string };

const SLUGS = { 53: "dr-robert", 54: "placa-vella", 55: "ajuntament-mercat" } as const;
const CAPS = { 53: 407, 54: 297, 55: 237 } as const;

/** Un dia sencer de lectures, minut a minut, per als tres pàrquings. */
function dayRows(day: string, startUtc: number, minutes = 1440): Row[] {
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

/**
 * D1 de mentida: respon les tres formes de `WHERE` que fa servir
 * `queryReadings` i compta les consultes, per poder afirmar quantes se'n fan.
 */
function fakeDb(rows: Row[]) {
  const queries: { sql: string; binds: unknown[] }[] = [];
  const run = (sql: string, b: unknown[]): Row[] => {
    let out: Row[];
    if (sql.includes("r.local_date = ?1 AND r.ts < ?2")) {
      out = rows.filter((r) => r.local_date === b[0] && r.ts < (b[1] as number));
    } else if (sql.includes("r.ts >= ?1 AND r.ts < ?2")) {
      out = rows.filter((r) => r.ts >= (b[0] as number) && r.ts < (b[1] as number));
    } else if (sql.includes("r.local_date = ?1")) {
      out = rows.filter((r) => r.local_date === b[0]);
    } else {
      throw new Error(`consulta inesperada: ${sql}`);
    }
    return [...out].sort((x, y) => x.ts - y.ts || x.parking_id - y.parking_id);
  };
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind(...binds: unknown[]) {
            return {
              all: async () => {
                queries.push({ sql, binds });
                return { results: run(sql, binds) };
              },
            };
          },
        };
      },
    },
  } as unknown as Env;
  return { env, queries };
}

/** Cache de la vora de mentida, amb la mateixa semàntica de clonatge que la real. */
function fakeCaches(): Map<string, Response> {
  const store = new Map<string, Response>();
  (globalThis as { caches?: unknown }).caches = {
    default: {
      match: async (k: Request) => store.get(k.url)?.clone(),
      put: async (k: Request, v: Response) => void store.set(k.url, v.clone()),
    },
  };
  return store;
}

/** La consulta del dia sencer: el `WHERE` és només `r.local_date = ?1`. */
const isFullDay = (sql: string): boolean => /WHERE r\.local_date = \?1\s*\n\s*ORDER BY/.test(sql);

const req = (day: string) => new Request(`https://example.com/api/day/${day}/series`);

// 2026-09-18, Europe/Madrid (CEST, UTC+2): el dia local va de les 22:00 UTC del 17
// a les 22:00 UTC del 18.
const DAY = "2026-09-18";
const DAY_START_UTC = Date.UTC(2026, 8, 17, 22, 0, 0) / 1000;

test("la unió del tros tancat i el viu és el dia sencer, per a qualsevol tall d'hora", async () => {
  const rows = dayRows(DAY, DAY_START_UTC);
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

test("el dia en curs dona el mateix que la consulta del dia sencer", async () => {
  const rows = dayRows(DAY, DAY_START_UTC, 700); // el dia a mitges
  const nowTs = rows[rows.length - 1]!.ts;
  fakeCaches();
  const { env } = fakeDb(rows);
  const out = await daySeries(req(DAY), env, DAY, "Europe/Madrid", nowTs);
  assert.deepEqual(out, toDaySeries(DAY, rows));
});

test("el tros tancat es llegeix un sol cop per hora, no a cada petició", async () => {
  const rows = dayRows(DAY, DAY_START_UTC, 700);
  const nowTs = rows[rows.length - 1]!.ts;
  fakeCaches();
  const { env, queries } = fakeDb(rows);

  for (let i = 0; i < 5; i++) {
    assert.deepEqual(await daySeries(req(DAY), env, DAY, "Europe/Madrid", nowTs + i * 60), toDaySeries(DAY, rows));
  }
  const tancades = queries.filter((q) => q.sql.includes("r.local_date = ?1 AND r.ts < ?2"));
  const vives = queries.filter((q) => q.sql.includes("r.ts >= ?1 AND r.ts < ?2"));
  assert.equal(tancades.length, 1, "el tros tancat s'ha de llegir un sol cop");
  assert.equal(vives.length, 5, "el tros viu, un cop per petició");
  // I cap consulta del dia sencer, que és la que es volia evitar.
  assert.equal(queries.filter((q) => isFullDay(q.sql)).length, 0);

  // L'hora següent estrena tall: el tros tancat es torna a llegir, un sol cop.
  const seguent = nowTs + 3600;
  await daySeries(req(DAY), env, DAY, "Europe/Madrid", seguent);
  await daySeries(req(DAY), env, DAY, "Europe/Madrid", seguent + 60);
  assert.equal(queries.filter((q) => q.sql.includes("r.local_date = ?1 AND r.ts < ?2")).length, 2);
});

test("un dia passat es llegeix sencer: no té tros viu", async () => {
  const rows = dayRows(DAY, DAY_START_UTC);
  fakeCaches();
  const { env, queries } = fakeDb(rows);
  // «Ara» és tres dies després del dia demanat.
  const out = await daySeries(req(DAY), env, DAY, "Europe/Madrid", DAY_START_UTC + 3 * 86_400);
  assert.deepEqual(out, toDaySeries(DAY, rows));
  assert.equal(queries.length, 1);
  assert.ok(isFullDay(queries[0]!.sql));
});

test("si la mitjanit local no cau en punt, es torna a la consulta del dia sencer", async () => {
  // Asia/Kolkata va UTC+5:30: la mitjanit local cau a les 18:30 UTC, a mitja
  // hora UTC, de manera que l'hora del tall no és tota del mateix dia local i el
  // tros viu (que només mira el `ts`) hi barrejaria lectures del dia d'abans.
  const day = "2026-09-19";
  const start = Date.UTC(2026, 8, 18, 18, 30, 0) / 1000;
  const rows = dayRows(day, start, 30);
  fakeCaches();
  const { env, queries } = fakeDb(rows);
  const nowTs = Date.UTC(2026, 8, 18, 18, 45, 0) / 1000; // 00:15 local
  const out = await daySeries(req(day), env, day, "Asia/Kolkata", nowTs);
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
  const start = Date.UTC(2026, 9, 24, 22, 0, 0) / 1000;
  const rows = dayRows(day, start, 600);
  const nowTs = rows[rows.length - 1]!.ts;
  fakeCaches();
  const { env, queries } = fakeDb(rows);
  const out = await daySeries(req(day), env, day, "Europe/Madrid", nowTs);
  assert.deepEqual(out, toDaySeries(day, rows));
  assert.ok(queries.some((q) => q.sql.includes("r.local_date = ?1 AND r.ts < ?2")), "s'ha de partir");
});

test("una lectura amb un `ts` futur no s'escola al tros viu", async () => {
  const rows = dayRows(DAY, DAY_START_UTC, 700);
  const nowTs = rows[rows.length - 1]!.ts;
  // El tall és l'hora anterior a la que corre, i el tros viu arriba fins a dues
  // hores més enllà: la fila de prova ha de quedar per sobre d'aquest límit.
  const cutoff = Math.floor(nowTs / 3600) * 3600 - 3600;
  const futura = { ...rows[0]!, ts: cutoff + 2 * 3600 + 60 };
  fakeCaches();
  const { env } = fakeDb([...rows, futura]);
  const out = await daySeries(req(DAY), env, DAY, "Europe/Madrid", nowTs);
  assert.deepEqual(out, toDaySeries(DAY, rows));
});

test("una lectura que arriba tard surt de seguida, no una hora després", async () => {
  // La captura de l'últim minut d'una hora es pot desar ja passada l'hora (un
  // cron endarrerit, o el reintent de cinc segons). Si el tros tancat es
  // congelés a l'hora en punt, aquell minut no es veuria fins a l'hora següent.
  const rows = dayRows(DAY, DAY_START_UTC, 840); // fins a les 12:00 UTC, dia local a mig fer
  const horaEnPunt = DAY_START_UTC + 840 * 60;
  const tardana = dayRows(DAY, horaEnPunt - 60, 1); // el minut 13:59, encara no desat
  fakeCaches();
  const vives = [...rows];
  const { env } = fakeDb(vives);

  // Primera petició, just passada l'hora: encara no hi és i es calcula el tros tancat.
  const abans = await daySeries(req(DAY), env, DAY, "Europe/Madrid", horaEnPunt + 5);
  assert.deepEqual(abans, toDaySeries(DAY, rows));

  // Ara arriba la lectura endarrerida, amb el `ts` de l'hora que ja ha passat.
  vives.push(...tardana);

  // La petició següent l'ha de portar, sense esperar el tall de l'hora vinent.
  const despres = await daySeries(req(DAY), env, DAY, "Europe/Madrid", horaEnPunt + 65);
  assert.deepEqual(despres, toDaySeries(DAY, [...rows, ...tardana]));
});
