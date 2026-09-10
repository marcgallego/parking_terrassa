/** Tipus de les respostes de l'API del Worker (mirall de src/index.ts). */

export type Slug = "placa-vella" | "ajuntament-mercat" | "dr-robert";

export interface LatestParking {
  parking_id: number;
  parking_slug: Slug;
  name: string;
  timestamp_utc: string;
  timestamp_local: string;
  capacity: number;
  available: number;
  occupied: number;
  occupancy_pct: number;
  /** [segons Unix, places lliures] de les últimes 3 hores */
  spark: [number, number][];
}

export interface LatestResponse {
  generated_at: string;
  parkings: LatestParking[];
}

export interface DayRecord {
  timestamp_utc: string;
  timestamp_local: string;
  parking_id: number;
  parking_slug: Slug;
  capacity: number;
  available: number;
  occupied: number;
  occupancy_pct: number;
}

export interface HourlyRecord {
  hour_utc: string;
  hour_local: string;
  parking_id: number;
  parking_slug: Slug;
  capacity: number;
  n: number;
  avg_available: number;
  min_available: number;
  max_available: number;
  avg_occupancy_pct: number;
}

export interface HeatmapCell {
  parking_id: number;
  parking_slug: Slug;
  dow: number;
  hour: number;
  avg_occupancy_pct: number;
  n: number;
}

export interface HeatmapResponse {
  weeks: number;
  cells: HeatmapCell[];
}

export interface SantRocDay {
  day: string;
  /** minuts amb lectura dels dos pàrquings */
  minutes: number;
  min_free: number;
  min_at_utc: string;
  min_at_local: string;
  minutes_below: number;
}

export interface SantRocResponse {
  parking_ids: number[];
  capacity: number;
  threshold: number;
  days: SantRocDay[];
}

export interface DayCount {
  day: string;
  rows: number;
}

export async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return (await r.json()) as T;
}
