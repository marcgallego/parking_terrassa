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
