/**
 * Contracte de l'API: única definició de les respostes JSON del Worker.
 *
 * L'importen tant `src/` (que les produeix) com `web/` (que les consumeix), de
 * manera que un canvi de nom o de tipus en una resposta trenca la compilació en
 * lloc de trencar el dashboard en execució.
 */

export type Slug = "placa-vella" | "ajuntament-mercat" | "dr-robert";

/** Una lectura: una fila del CSV i de `/api/day/AAAA-MM-DD`. */
export interface OccupancyRecord {
  timestamp_utc: string;
  timestamp_local: string;
  parking_id: number;
  parking_slug: Slug;
  capacity: number;
  available: number;
  occupied: number;
  occupancy_pct: number;
}

/** Fitxa d'un pàrquing: `/api/parkings`. */
export interface ParkingInfo {
  id: number;
  slug: Slug;
  name: string;
  url: string;
  capacity: number;
  lat: number;
  lon: number;
}

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

/** `/api/latest` */
export interface LatestResponse {
  generated_at: string;
  parkings: LatestParking[];
}

/** `/api/hourly?days=N` */
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

/** `/api/heatmap?weeks=N` */
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

/** `/api/santroc?days=N&threshold=T` */
export interface SantRocResponse {
  parking_ids: number[];
  capacity: number;
  threshold: number;
  days: SantRocDay[];
}

/** `/api/days` */
export interface DayCount {
  day: string;
  rows: number;
}

/** Un canvi de capacitat publicada per saba.es, detectat durant la captura. */
export interface CapacityChange {
  ts: string;
  parking_id: number;
  /** capacitat que el Worker tenia per esperada */
  expected: number;
  /** capacitat que saba.es publicava en aquell moment */
  observed: number;
}

export interface ScrapeError {
  ts: string;
  parking_id: number | null;
  message: string;
}

/** `/api/status` */
export interface StatusResponse {
  /** false si la captura fa massa estona que no escriu o hi ha canvis de capacitat sense revisar */
  healthy: boolean;
  /** motius pels quals `healthy` és false; llista buida si tot va bé */
  issues: string[];
  last_reading_utc: string | null;
  first_reading_utc: string | null;
  /** minuts des de l'última lectura escrita, o null si no n'hi ha cap */
  stale_minutes: number | null;
  /** lectures escrites avui (hora local). Consulta indexada, acotada a un sol dia. */
  readings_today: number;
  /**
   * Total de files de `readings`. Només es calcula si es demana amb `?totals=1`,
   * perquè obliga a recórrer tota la taula; altrament és null.
   */
  readings: number | null;
  recent_errors: ScrapeError[];
  /** canvis de capacitat dels últims 30 dies, els més recents primer */
  recent_capacity_changes: CapacityChange[];
}
