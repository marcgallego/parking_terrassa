/**
 * Proves de les utilitats d'hora local. L'horari d'estiu és el punt on un error
 * passaria desapercebut: canviaria el `local_date`/`local_hour` de les lectures
 * (i per tant el mapa de calor i els agregats diaris) sense fer fallar res.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { isoUtc, localIso, localParts } from "../src/index";

const TZ = "Europe/Madrid";
const at = (iso: string): Date => new Date(iso);
const secs = (iso: string): number => Math.floor(new Date(iso).getTime() / 1000);

test("hivern: Europe/Madrid va una hora per davant d'UTC", () => {
  assert.deepEqual(localParts(at("2026-01-15T12:00:00Z"), TZ), {
    local_date: "2026-01-15",
    local_hour: 13,
    local_minute: 0,
    local_dow: 3, // dijous
  });
  assert.equal(localIso(secs("2026-01-15T12:00:00Z"), TZ), "2026-01-15T13:00:00+01:00");
});

test("estiu: Europe/Madrid va dues hores per davant d'UTC", () => {
  assert.deepEqual(localParts(at("2026-07-15T12:00:00Z"), TZ), {
    local_date: "2026-07-15",
    local_hour: 14,
    local_minute: 0,
    local_dow: 2, // dimecres
  });
  assert.equal(localIso(secs("2026-07-15T12:00:00Z"), TZ), "2026-07-15T14:00:00+02:00");
});

test("salt de primavera: 02:00 local no existeix el darrer diumenge de març", () => {
  // 2026-03-29: a les 02:00 locals els rellotges salten a les 03:00.
  assert.equal(localParts(at("2026-03-29T00:59:00Z"), TZ).local_hour, 1);
  assert.equal(localParts(at("2026-03-29T01:00:00Z"), TZ).local_hour, 3);
  assert.equal(localIso(secs("2026-03-29T00:59:00Z"), TZ), "2026-03-29T01:59:00+01:00");
  assert.equal(localIso(secs("2026-03-29T01:00:00Z"), TZ), "2026-03-29T03:00:00+02:00");
});

test("salt de tardor: l'hora repetida queda desambiguada per l'offset", () => {
  // 2026-10-25: les 02:00-02:59 locals passen dues vegades. Les dues lectures
  // tenen el mateix `local_hour`, i només el desplaçament les distingeix.
  const first = localIso(secs("2026-10-25T00:59:00Z"), TZ);
  const second = localIso(secs("2026-10-25T01:59:00Z"), TZ);
  assert.equal(first, "2026-10-25T02:59:00+02:00");
  assert.equal(second, "2026-10-25T02:59:00+01:00");
  assert.notEqual(first, second, "l'hora repetida ha de ser distingible");
});

test("el dia local pot avançar-se al dia UTC", () => {
  // 23:30 UTC de l'11 de setembre són les 01:30 del dia 12 a Terrassa.
  assert.equal(localParts(at("2026-09-11T23:30:00Z"), TZ).local_date, "2026-09-12");
});

test("local_dow compta el dilluns com a 0", () => {
  assert.equal(localParts(at("2026-09-14T00:00:00Z"), TZ).local_dow, 0); // dilluns
  assert.equal(localParts(at("2026-09-13T12:00:00Z"), TZ).local_dow, 6); // diumenge
});

test("isoUtc dóna segons sencers sense mil·lisegons", () => {
  assert.equal(isoUtc(secs("2026-09-11T23:30:00Z")), "2026-09-11T23:30:00Z");
});

test("LOCAL_TZ pot ser una zona darrere d'UTC", () => {
  // `LOCAL_TZ` és configurable a wrangler.jsonc. Amb un desplaçament negatiu el
  // dia local queda darrere del dia UTC, el cas contrari al de Terrassa.
  assert.equal(localIso(secs("2026-09-11T02:30:00Z"), "America/New_York"), "2026-09-10T22:30:00-04:00");
  assert.equal(localIso(secs("2026-01-15T02:30:00Z"), "America/New_York"), "2026-01-14T21:30:00-05:00");
});

/**
 * Referència sense cap cache: un formatador nou per instant, i el desplaçament
 * calculat a partir de la data local sencera. És lenta, que és justament el que
 * `localIso` evita; aquí serveix per comprovar que evitar-ho no canvia res.
 */
function referenceLocalIso(ts: number, tz: string): string {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(new Date(ts * 1000))) p[part.type] = part.value;
  const hour = Number(p.hour) % 24;
  const off = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hour, Number(p.minute)) / 60_000 - Math.floor(ts / 60);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const a = Math.abs(off);
  return `${p.year}-${p.month}-${p.day}T${pad(hour)}:${p.minute}:00${off >= 0 ? "+" : "-"}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

test("localIso coincideix minut a minut amb Intl, també els dies de canvi d'hora", () => {
  // La cache de `localIso` guarda un desplaçament per hora UTC. Aquests casos
  // cobreixen els canvis en punt (Madrid, Nova York), una zona de mitja hora
  // (Calcuta), una que canvia 30 minuts a mitja hora UTC (Lord Howe) i una més
  // enllà de +12 h (Kiritimati).
  const cases: [string, string][] = [
    ["Europe/Madrid", "2026-03-29"],
    ["Europe/Madrid", "2026-10-25"],
    ["America/New_York", "2026-11-01"],
    ["Asia/Kolkata", "2026-09-12"],
    ["Australia/Lord_Howe", "2026-10-04"],
    ["Pacific/Kiritimati", "2026-09-12"],
  ];
  for (const [tz, day] of cases) {
    const from = secs(`${day}T00:00:00Z`) - 12 * 3600;
    for (let ts = from; ts < from + 36 * 3600; ts += 60) {
      assert.equal(localIso(ts, tz), referenceLocalIso(ts, tz), `${tz} ${isoUtc(ts)}`);
    }
  }
});

test("un dia sencer no consulta Intl a cada lectura", () => {
  // Consultar-lo (i crear-ne un formatador) per fila feia que /api/day
  // gastés uns 200 ms de CPU i el Worker caigués per l'error 1102 (503).
  const proto = Intl.DateTimeFormat.prototype;
  const original = proto.formatToParts;
  let calls = 0;
  proto.formatToParts = function (this: Intl.DateTimeFormat, date?: Date | number) {
    calls++;
    return original.call(this, date);
  };
  try {
    const from = secs("2026-06-01T22:00:00Z");
    for (let i = 0; i < 3 * 1440; i++) localIso(from + Math.floor(i / 3) * 60, TZ);
  } finally {
    proto.formatToParts = original;
  }
  assert.ok(calls <= 2 * 24, `${calls} consultes a Intl per a les 4.320 lectures d'un dia`);
});
