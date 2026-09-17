/** Proves del format compacte del dia (`/api/day/AAAA-MM-DD/series`), el que carrega el dashboard. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { toDaySeries } from "../src/index";

type Row = Parameters<typeof toDaySeries>[1][number];
const T0 = 1_788_220_800; // 2026-09-01T00:00:00Z
const row = (min: number, parking_id: number, slug: Row["slug"], available: number, capacity: number): Row => ({
  ts: T0 + min * 60,
  parking_id,
  slug,
  capacity,
  available,
});

test("agrupa per pàrquing, en ordre d'id i de temps", () => {
  const out = toDaySeries("2026-09-01", [
    row(0, 55, "ajuntament-mercat", 100, 237),
    row(1, 54, "placa-vella", 200, 297),
    row(0, 54, "placa-vella", 201, 297),
    row(1, 55, "ajuntament-mercat", 99, 237),
  ]);
  assert.deepEqual(out, {
    day: "2026-09-01",
    parkings: [
      { parking_id: 54, parking_slug: "placa-vella", points: [[T0, 201, 297], [T0 + 60, 200, 297]] },
      { parking_id: 55, parking_slug: "ajuntament-mercat", points: [[T0, 100, 237], [T0 + 60, 99, 237]] },
    ],
  });
});

test("conserva la capacitat de cada minut, per si canvia durant el dia", () => {
  const out = toDaySeries("2026-09-01", [row(0, 53, "dr-robert", 10, 407), row(1, 53, "dr-robert", 10, 400)]);
  assert.deepEqual(out.parkings[0]?.points.map((p) => p[2]), [407, 400]);
});

test("una lectura per punt: cap no es perd ni es duplica", () => {
  const rows = [53, 54, 55].flatMap((id) => Array.from({ length: 1440 }, (_, m) => row(m, id, "dr-robert", m % 50, 407)));
  const out = toDaySeries("2026-09-01", rows);
  assert.equal(out.parkings.reduce((n, p) => n + p.points.length, 0), rows.length);
});

test("un dia sense lectures no té pàrquings", () => {
  assert.deepEqual(toDaySeries("2026-09-01", []), { day: "2026-09-01", parkings: [] });
});
