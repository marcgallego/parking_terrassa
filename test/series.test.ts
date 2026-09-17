/**
 * Proves de la preparació de sèries per als gràfics del dashboard. Els forats
 * són el punt delicat: una lectura aïllada que falta no ha de tallar la línia,
 * però una captura aturada tampoc no s'ha de dissimular amb una recta.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { addDays, alignSeries, zonedMidnight } from "../web/series";

const TZ = "Europe/Madrid";
const secs = (iso: string): number => Date.parse(iso) / 1000;

test("zonedMidnight: les 00:00 de Terrassa a l'hivern i a l'estiu", () => {
  assert.equal(zonedMidnight("2026-01-15", TZ), secs("2026-01-14T23:00:00Z"));
  assert.equal(zonedMidnight("2026-07-15", TZ), secs("2026-07-14T22:00:00Z"));
});

test("zonedMidnight: els dies de canvi d'hora fan 23 i 25 hores", () => {
  assert.equal(zonedMidnight("2026-03-30", TZ) - zonedMidnight("2026-03-29", TZ), 23 * 3600);
  assert.equal(zonedMidnight("2026-10-26", TZ) - zonedMidnight("2026-10-25", TZ), 25 * 3600);
});

test("addDays travessa mesos i anys", () => {
  assert.equal(addDays("2026-01-31", 1), "2026-02-01");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
});

test("alignSeries: una lectura que falta en una sèrie queda undefined (la línia continua)", () => {
  const a = new Map([[0, 1], [60, 2], [120, 3]]);
  const b = new Map([[0, 5], [120, 7]]);
  const [x, ya, yb] = alignSeries([0, 60, 120], [(t) => a.get(t), (t) => b.get(t)], 300);
  assert.deepEqual(x, [0, 60, 120]);
  assert.deepEqual(ya, [1, 2, 3]);
  assert.deepEqual(yb, [5, undefined, 7]);
});

test("alignSeries: un forat sense cap lectura afegeix un punt null entremig", () => {
  const v = new Map([[0, 1], [60, 2], [1000, 3]]);
  const [x, y] = alignSeries([0, 60, 1000], [(t) => v.get(t)], 300);
  assert.deepEqual(x, [0, 60, 530, 1000]);
  assert.deepEqual(y, [1, 2, null, 3]);
});

test("alignSeries: un forat d'una sola sèrie la talla sense tallar les altres", () => {
  const xs = Array.from({ length: 11 }, (_, i) => i * 60);
  const b = new Map([[0, 5], [600, 9]]);
  const [x, ya, yb] = alignSeries(xs, [() => 1, (t) => b.get(t)], 300);
  assert.deepEqual(x, xs);
  assert.ok(ya?.every((v) => v === 1));
  assert.equal(yb?.[0], 5);
  assert.equal(yb?.[1], null);
  assert.ok(yb?.slice(2, 10).every((v) => v === undefined));
  assert.equal(yb?.[10], 9);
});

test("alignSeries: sense punts retorna sèries buides", () => {
  assert.deepEqual(alignSeries([], [() => 1, () => 2], 300), [[], [], []]);
});
