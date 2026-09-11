/** Proves del format de sortida: el CSV és el contracte públic del dataset. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { pct, toCsv } from "../src/index";
import type { OccupancyRecord } from "../shared/api";

const record = (over: Partial<OccupancyRecord> = {}): OccupancyRecord => ({
  timestamp_utc: "2026-09-11T10:00:00Z",
  timestamp_local: "2026-09-11T12:00:00+02:00",
  parking_id: 54,
  parking_slug: "placa-vella",
  capacity: 297,
  available: 230,
  occupied: 67,
  occupancy_pct: 22.6,
  ...over,
});

test("el CSV porta sempre la capçalera documentada", () => {
  const [header] = toCsv([]).split("\n");
  assert.equal(header, "timestamp_utc,timestamp_local,parking_id,parking_slug,capacity,available,occupied,occupancy_pct");
});

test("una fila per lectura, en l'ordre de les columnes", () => {
  const lines = toCsv([record()]).trimEnd().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(lines[1], "2026-09-11T10:00:00Z,2026-09-11T12:00:00+02:00,54,placa-vella,297,230,67,22.6");
});

test("un CSV buit és només la capçalera", () => {
  assert.equal(toCsv([]).trimEnd().split("\n").length, 1);
});

test("cap camp no conté comes que trencarien el CSV", () => {
  // Tots els valors són numèrics, dates ISO o slugs; si això canviés caldria escapar.
  const row = toCsv([record()]).trimEnd().split("\n")[1] as string;
  assert.equal(row.split(",").length, 8);
});

test("l'ocupació s'arrodoneix a una decimal", () => {
  assert.equal(pct(297, 230), 22.6);
  assert.equal(pct(297, 297), 0);
  assert.equal(pct(297, 0), 100);
  assert.equal(pct(3, 1), 66.7);
});
