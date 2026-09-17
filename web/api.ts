/**
 * Accés a l'API del Worker des del dashboard.
 *
 * Els tipus de les respostes viuen a `shared/api.ts`, compartits amb el Worker
 * que les produeix; aquí només es reexporten per comoditat dels imports.
 */

export type {
  CapacityChange,
  DayCount,
  DaySeriesParking,
  DaySeriesResponse,
  HeatmapCell,
  HeatmapResponse,
  HourlyRecord,
  LatestParking,
  LatestResponse,
  OccupancyRecord,
  ParkingInfo,
  SantRocDay,
  SantRocResponse,
  ScrapeError,
  Slug,
  StatusResponse,
} from "../shared/api";

/** Nom històric de `OccupancyRecord` al dashboard: una fila de `/api/day/...`. */
export type { OccupancyRecord as DayRecord } from "../shared/api";

export async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return (await r.json()) as T;
}
