/**
 * Ocupació dels pàrquings Saba de Terrassa
 * Cloudflare Worker: captura cada minut (cron), agregat horari, API oberta i dashboard.
 */

import type {
  DayCount,
  HeatmapResponse,
  HourlyRecord,
  LatestParking,
  LatestResponse,
  OccupancyRecord,
  ParkingInfo,
  SantRocResponse,
  Slug,
  StatusResponse,
} from "../shared/api";

/** Reexportat perquè el contracte de l'API es pugui importar des del Worker. */
export type { OccupancyRecord } from "../shared/api";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  LOCAL_TZ?: string;
  /** Opcional: URL a la qual notificar que la captura falla (`wrangler secret put ALERT_WEBHOOK`). */
  ALERT_WEBHOOK?: string;
}

const USER_AGENT =
  "parking-terrassa-dataset/1.0 (open parking occupancy dataset; Cloudflare Workers)";
const FETCH_TIMEOUT_MS = 20_000;
const SPARK_MINUTES = 180;
const CRON_HOURLY = "7 * * * *";
const ERROR_RETENTION_DAYS = 30;
/** Caràcters de la pàgina que es desen quan no se sap llegir, per poder-la diagnosticar. */
const ERROR_HTML_CHARS = 1000;
/** Minuts sense cap lectura nova a partir dels quals la captura es considera aturada. */
const STALE_ALERT_MINUTES = 15;
/**
 * Lectures coincidents (de les últimes 24 h) necessàries per acceptar una
 * capacitat nova a la fitxa del pàrquing. Evita que un minut anòmal la canviï.
 */
const CAPACITY_CONFIRM_READINGS = 60;

/**
 * Pàrquings que es capturen. Es defineixen aquí (i no a D1) perquè la captura no
 * depengui de cap lectura de la base de dades: si la quota diària de lectures
 * s'esgotés, les escriptures continuarien igualment.
 */
const PARKINGS: readonly { id: number; url: string; capacity: number }[] = [
  { id: 54, url: "https://www.saba.es/ca/parking-terrassa/parking-saba-placa-vella", capacity: 297 },
  { id: 55, url: "https://www.saba.es/ca/parking-terrassa/parking-saba-ajuntament-mercat", capacity: 237 },
  { id: 53, url: "https://www.saba.es/ca/parking-terrassa/parking-saba-dr.-robert", capacity: 407 },
];
/** Capacitat que el Worker espera de cada pàrquing, per detectar-ne els canvis sense llegir D1. */
const EXPECTED_CAPACITY = new Map(PARKINGS.map((p) => [p.id, p.capacity]));
/** Pàrquings a tocar del Portal de Sant Roc: Plaça Vella (54) i Ajuntament-Mercat (55). */
const SANT_ROC_PARKINGS = [54, 55] as const;
const SANT_ROC_THRESHOLDS = [10, 25, 50] as const;
type SantRocThreshold = (typeof SANT_ROC_THRESHOLDS)[number];

// ---------------------------------------------------------------------------
// Tipus de files de D1
// ---------------------------------------------------------------------------

interface ReadingRow {
  ts: number;
  parking_id: number;
  slug: Slug;
  capacity: number;
  available: number;
}

interface LatestRow extends ReadingRow {
  name: string;
}

interface HourlyRow {
  hour_ts: number;
  parking_id: number;
  slug: Slug;
  capacity: number;
  n: number;
  avg_available: number;
  min_available: number;
  max_available: number;
}

interface HeatmapRow {
  parking_id: number;
  slug: Slug;
  local_dow: number;
  local_hour: number;
  avg_occupancy_pct: number;
  n: number;
}

interface SantRocDayRow {
  day: string;
  minutes: number;
  min_free: number;
  min_ts: number;
  minutes_below: number;
}

interface DailySantRocRow {
  day: string;
  minutes: number;
  min_free: number;
  min_ts: number;
  below_10: number;
  below_25: number;
  below_50: number;
}

interface CapacityChangeRow {
  ts: number;
  parking_id: number;
  expected: number;
  observed: number;
}

interface ErrorRow {
  ts: number;
  parking_id: number | null;
  message: string;
  html?: string | null;
}

// ---------------------------------------------------------------------------
// Tipus de sortida de l'API
// ---------------------------------------------------------------------------

interface LocalParts {
  local_date: string;
  local_hour: number;
  local_minute: number;
  local_dow: number;
}

type ScrapeOutcome =
  | { id: number; capacity: number; available: number; error?: undefined; html?: undefined }
  | { id: number; error: string; html: string | null };

// ---------------------------------------------------------------------------
// Utilitats de temps (hora local Europe/Madrid)
// ---------------------------------------------------------------------------

const DOW_INDEX: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

export function localParts(date: Date, tz: string): LocalParts {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
  return {
    local_date: `${p.year}-${p.month}-${p.day}`,
    local_hour: Number(p.hour) % 24, // alguns runtimes retornen "24" a mitjanit
    local_minute: Number(p.minute),
    local_dow: DOW_INDEX[p.weekday ?? ""] ?? 0,
  };
}

export function isoUtc(ts: number): string {
  return new Date(ts * 1000).toISOString().replace(".000Z", "Z");
}

export function localIso(ts: number, tz: string): string {
  const d = new Date(ts * 1000);
  const p = localParts(d, tz);
  const utcMinutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  const localMinutes = p.local_hour * 60 + p.local_minute;
  let off = localMinutes - utcMinutes;
  if (off > 720) off -= 1440;
  if (off < -720) off += 1440;
  const sign = off >= 0 ? "+" : "-";
  const a = Math.abs(off);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.local_date}T${pad(p.local_hour)}:${pad(p.local_minute)}:00${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

// ---------------------------------------------------------------------------
// Captura
// ---------------------------------------------------------------------------

const AVAILABLE_RE =
  /Places:\s*<strong>\s*(\d+)\s*<\/strong>[\s\S]*?Places disponibles:\s*<strong>\s*(\d+)\s*<\/strong>/;

/**
 * Tros de pàgina que es desa quan la captura falla: la finestra al voltant del
 * bloc d'ocupació, o bé el principi de la pàgina si el bloc no hi és. Acotat a
 * ERROR_HTML_CHARS perquè una pàgina d'error no ompli la base de dades.
 */
export function htmlSnippet(html: string): string {
  const i = html.indexOf('class="available-places"');
  const from = i < 0 ? 0 : Math.max(0, i - 200);
  return html.slice(from, from + ERROR_HTML_CHARS);
}

export function parseOccupancy(html: string): { capacity: number; available: number } {
  const i = html.indexOf('class="available-places"');
  if (i < 0) throw new Error("no s'ha trobat el bloc 'available-places'");
  const m = AVAILABLE_RE.exec(html.slice(i, i + 600));
  if (!m) throw new Error("bloc 'available-places' amb format inesperat");
  const capacity = Number(m[1]);
  const available = Number(m[2]);
  if (!Number.isInteger(capacity) || capacity <= 0 || capacity > 5000) throw new Error(`capacitat inversemblant (${capacity})`);
  if (available > capacity) throw new Error(`disponibles (${available}) > capacitat (${capacity})`);
  return { capacity, available };
}

async function fetchPage(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept-Language": "ca,es;q=0.8",
      "Cache-Control": "no-cache",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    cf: { cacheTtl: 0 },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function scrapeAll(env: Env, now = new Date()): Promise<{ ts: number; outcomes: ScrapeOutcome[] }> {
  const tz = env.LOCAL_TZ ?? "Europe/Madrid";
  const ts = Math.floor(now.getTime() / 60_000) * 60;
  const lp = localParts(new Date(ts * 1000), tz);
  const outcomes = await Promise.all(
    PARKINGS.map(async (p): Promise<ScrapeOutcome> => {
      // `html` es declara fora del try perquè, si el que falla és llegir-la (i no
      // descarregar-la), el catch la pugui desar com a prova.
      let html: string | undefined;
      try {
        html = await fetchPage(p.url);
        const r = parseOccupancy(html);
        if (r.capacity !== p.capacity) console.warn(`parking ${p.id}: capacitat ${r.capacity} (esperada ${p.capacity})`);
        return { id: p.id, ...r };
      } catch (e) {
        return { id: p.id, error: errorMessage(e), html: html === undefined ? null : htmlSnippet(html) };
      }
    }),
  );

  const ins = env.DB.prepare(
    "INSERT OR REPLACE INTO readings (ts, parking_id, capacity, available, local_date, local_hour, local_dow) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const err = env.DB.prepare("INSERT INTO scrape_errors (ts, parking_id, message, html) VALUES (?, ?, ?, ?)");
  const cap = env.DB.prepare(
    "INSERT OR IGNORE INTO capacity_changes (parking_id, expected, observed, ts) VALUES (?, ?, ?, ?)",
  );
  const stmts = outcomes.map((o) =>
    o.error !== undefined
      ? err.bind(ts, o.id, o.error, o.html)
      : ins.bind(ts, o.id, o.capacity, o.available, lp.local_date, lp.local_hour, lp.local_dow),
  );
  // La capacitat publicada pot canviar (places d'abonat, obres). Es compara amb
  // la constant del Worker, que és a memòria: així la captura continua sense
  // llegir res de D1.
  for (const o of outcomes) {
    if (o.error !== undefined) continue;
    const expected = EXPECTED_CAPACITY.get(o.id);
    if (expected !== undefined && expected !== o.capacity) stmts.push(cap.bind(o.id, expected, o.capacity, ts));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return { ts, outcomes };
}

async function aggregateHourly(env: Env, now = new Date()): Promise<void> {
  const currentHour = Math.floor(now.getTime() / 3_600_000) * 3600;
  const from = currentHour - 3 * 3600; // reagrupem les 3 últimes hores tancades
  await env.DB.prepare(
    `INSERT OR REPLACE INTO hourly
       (hour_ts, parking_id, local_date, local_hour, local_dow, n, capacity, avg_available, min_available, max_available)
     SELECT (ts / 3600) * 3600, parking_id, MIN(local_date), MIN(local_hour), MIN(local_dow),
            COUNT(*), MAX(capacity), AVG(available), MIN(available), MAX(available)
     FROM readings
     WHERE ts >= ?1 AND ts < ?2
     GROUP BY (ts / 3600) * 3600, parking_id`,
  )
    .bind(from, currentHour)
    .run();
}

/** Recalcula l'agregat diari del Portal de Sant Roc per a un dia local (idempotent). */
async function aggregateDailySantRoc(env: Env, day: string): Promise<void> {
  const ids = SANT_ROC_PARKINGS.join(",");
  await env.DB.prepare(
    `INSERT OR REPLACE INTO daily_santroc (day, minutes, min_free, min_ts, below_10, below_25, below_50)
     SELECT ?1, COUNT(*), MIN(free), ts,
            SUM(CASE WHEN free < 10 THEN 1 ELSE 0 END),
            SUM(CASE WHEN free < 25 THEN 1 ELSE 0 END),
            SUM(CASE WHEN free < 50 THEN 1 ELSE 0 END)
     FROM (
       SELECT ts, SUM(available) AS free
       FROM readings
       WHERE parking_id IN (${ids}) AND local_date = ?1
       GROUP BY ts
       HAVING COUNT(*) = ${SANT_ROC_PARKINGS.length}
     )
     GROUP BY 1 HAVING COUNT(*) > 0`,
  )
    .bind(day)
    .run();
}

/**
 * Posa al dia la capacitat de la fitxa dels pàrquings a partir del que s'ha anat
 * llegint. Sense això, /api/parkings i el denominador del panell del Portal de
 * Sant Roc es quedarien amb el valor de la migració inicial per sempre.
 *
 * Només accepta una capacitat nova si domina clarament les últimes 24 hores, de
 * manera que un minut amb una xifra estranya no la faci oscil·lar.
 */
async function reconcileCapacities(env: Env, now: Date): Promise<number> {
  const from = Math.floor(now.getTime() / 1000) - 86_400;
  const [seen, fitxa] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare(
      `SELECT parking_id, capacity, COUNT(*) AS n FROM readings WHERE ts >= ?1 GROUP BY parking_id, capacity`,
    ).bind(from),
    env.DB.prepare("SELECT id, capacity FROM parkings"),
  ]);
  const best = new Map<number, { capacity: number; n: number }>();
  for (const r of (seen?.results ?? []) as unknown as { parking_id: number; capacity: number; n: number }[]) {
    const cur = best.get(r.parking_id);
    if (!cur || r.n > cur.n) best.set(r.parking_id, { capacity: r.capacity, n: r.n });
  }
  const upd = env.DB.prepare("UPDATE parkings SET capacity = ?1 WHERE id = ?2");
  const stmts = [];
  for (const p of (fitxa?.results ?? []) as unknown as { id: number; capacity: number }[]) {
    const b = best.get(p.id);
    if (b && b.n >= CAPACITY_CONFIRM_READINGS && b.capacity !== p.capacity) {
      console.warn(`parking ${p.id}: capacitat de la fitxa ${p.capacity} -> ${b.capacity}`);
      stmts.push(upd.bind(b.capacity, p.id));
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
  return stmts.length;
}

/**
 * Estat de salut de la captura, compartit per /api/status i per l'avís horari.
 *
 * Es consulta cada hora dues vegades (el cron i la feina de GitHub Actions), i
 * D1 factura files llegides, així que totes les consultes han d'estar acotades.
 * Dos detalls que ho fan possible i que és fàcil desfer sense adonar-se'n:
 *
 * - `MAX(ts)` i `MIN(ts)` van en consultes separades. Juntes a la mateixa
 *   consulta, SQLite no pot fer servir l'índex i recorre tota la taula
 *   (`EXPLAIN QUERY PLAN` passa de SEARCH a SCAN).
 * - El total de files només es calcula si `totals` és cert, perquè és l'única
 *   consulta que no es pot acotar. Per al dia a dia hi ha `readings_today`, que
 *   va per `idx_readings_local_date`.
 * - El tros de pàgina de cada error només es demana si `html` és cert: són fins
 *   a 20 KB que no cal arrossegar a cada consulta horària.
 */
async function checkHealth(env: Env, now: Date, { totals = false, html = false } = {}): Promise<StatusResponse> {
  const nowTs = Math.floor(now.getTime() / 1000);
  const today = localParts(now, env.LOCAL_TZ ?? "Europe/Madrid").local_date;
  const stmts = [
    env.DB.prepare("SELECT MAX(ts) AS ts FROM readings"),
    env.DB.prepare("SELECT MIN(ts) AS ts FROM readings"),
    env.DB.prepare("SELECT COUNT(*) AS n FROM readings WHERE local_date = ?1").bind(today),
    env.DB.prepare(
      `SELECT ts, parking_id, message${html ? ", html" : ""} FROM scrape_errors ORDER BY ts DESC LIMIT 20`,
    ),
    env.DB.prepare("SELECT ts, parking_id, expected, observed FROM capacity_changes ORDER BY ts DESC LIMIT 20"),
    env.DB.prepare("SELECT id, capacity FROM parkings"),
  ];
  if (totals) stmts.push(env.DB.prepare("SELECT COUNT(*) AS n FROM readings"));
  const [lastR, firstR, todayR, errs, caps, fitxa, totalR] = await env.DB.batch<Record<string, unknown>>(stmts);
  const l = {
    ts: (lastR?.results[0] as { ts: number | null } | undefined)?.ts ?? null,
    first_ts: (firstR?.results[0] as { ts: number | null } | undefined)?.ts ?? null,
  };
  const nToday = (todayR?.results[0] as { n: number } | undefined)?.n ?? 0;
  const n = totals ? ((totalR?.results[0] as { n: number } | undefined)?.n ?? 0) : null;
  const recent = (errs?.results ?? []) as unknown as ErrorRow[];
  const capRows = (caps?.results ?? []) as unknown as CapacityChangeRow[];
  const staleMinutes = l.ts ? Math.floor((nowTs - l.ts) / 60) : null;

  const issues: string[] = [];
  if (staleMinutes === null) issues.push("encara no hi ha cap lectura");
  else if (staleMinutes >= STALE_ALERT_MINUTES) issues.push(`fa ${staleMinutes} minuts que no s'escriu cap lectura`);
  const lastHourErrors = recent.filter((e) => e.ts >= nowTs - 3600).length;
  if (lastHourErrors > 0) issues.push(`${lastHourErrors} error(s) de captura a l'última hora`);
  // Discrepància d'estat, no esdeveniment: es compara la fitxa (ja reconciliada
  // amb el que s'ha llegit) amb la constant del Worker. L'avís s'apaga tot sol
  // quan s'actualitza PARKINGS i es torna a desplegar.
  for (const p of (fitxa?.results ?? []) as unknown as { id: number; capacity: number }[]) {
    const expected = EXPECTED_CAPACITY.get(p.id);
    if (expected !== undefined && expected !== p.capacity) {
      issues.push(`el pàrquing ${p.id} publica ${p.capacity} places i el Worker n'espera ${expected}: actualitzeu PARKINGS`);
    }
  }

  return {
    healthy: issues.length === 0,
    issues,
    last_reading_utc: l.ts ? isoUtc(l.ts) : null,
    first_reading_utc: l.first_ts ? isoUtc(l.first_ts) : null,
    stale_minutes: staleMinutes,
    readings_today: nToday,
    readings: n,
    recent_errors: recent.map((e) => ({ ...e, ts: isoUtc(e.ts), html: e.html ?? null })),
    recent_capacity_changes: capRows.map((c) => ({ ...c, ts: isoUtc(c.ts) })),
  };
}

/**
 * Avisa si la captura s'ha aturat o si la capacitat publicada ha canviat.
 * Només fa res si hi ha el secret `ALERT_WEBHOOK`; sense secret, l'estat es
 * consulta igualment a /api/status.
 *
 * El cos porta el mateix missatge amb els dos noms de camp que fan servir els
 * serveis habituals —`text` (Slack, Telegram) i `content` (Discord)—, i l'estat
 * complet imbricat sota `health`, que cap d'ells no interpreta. Imbricar-lo
 * evita que camps com `issues` o `recent_errors` acabin al primer nivell, on
 * podrien xocar amb paràmetres del servei.
 */
async function sendAlert(env: Env, health: StatusResponse): Promise<void> {
  if (!env.ALERT_WEBHOOK || health.healthy) return;
  const text = `parking-terrassa: ${health.issues.join("; ")}`;
  try {
    await fetch(env.ALERT_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, content: text, health }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    console.error("no s'ha pogut enviar l'avís", errorMessage(e));
  }
}

/** Feina horària: agregat horari, agregats diaris tancats i neteja d'errors antics. */
async function hourlyMaintenance(env: Env, now: Date): Promise<void> {
  const tz = env.LOCAL_TZ ?? "Europe/Madrid";
  await aggregateHourly(env, now);
  const hour = localParts(now, tz).local_hour;
  const dayBefore = (n: number): string => localParts(new Date(now.getTime() - n * 86_400_000), tz).local_date;
  if (hour >= 1 && hour <= 3) {
    // Just després de mitjanit: tanquem el dia d'ahir (tres intents per si un cron falla).
    await aggregateDailySantRoc(env, dayBefore(1));
  } else if (hour === 4) {
    // Un cop al dia: repassem l'última setmana per cobrir dies que haguessin quedat sense agregar.
    for (let n = 2; n <= 7; n++) await aggregateDailySantRoc(env, dayBefore(n));
    // Els errors caduquen; els canvis de capacitat no, són poques files i
    // documenten com ha evolucionat l'oferta de places.
    await env.DB.prepare("DELETE FROM scrape_errors WHERE ts < ?1")
      .bind(Math.floor(now.getTime() / 1000) - ERROR_RETENTION_DAYS * 86_400)
      .run();
  }
  // Cada hora: posa al dia la capacitat de la fitxa i avisa si alguna cosa falla.
  await reconcileCapacities(env, now);
  await sendAlert(env, await checkHealth(env, now));
}

// ---------------------------------------------------------------------------
// Respostes
// ---------------------------------------------------------------------------

const CSV_HEADER =
  "timestamp_utc,timestamp_local,parking_id,parking_slug,capacity,available,occupied,occupancy_pct\n";

export const pct = (capacity: number, available: number): number =>
  Math.round((1000 * (capacity - available)) / capacity) / 10;

function rowToRecord(r: ReadingRow, tz: string): OccupancyRecord {
  return {
    timestamp_utc: isoUtc(r.ts),
    timestamp_local: localIso(r.ts, tz),
    parking_id: r.parking_id,
    parking_slug: r.slug,
    capacity: r.capacity,
    available: r.available,
    occupied: r.capacity - r.available,
    occupancy_pct: pct(r.capacity, r.available),
  };
}

export function toCsv(records: OccupancyRecord[]): string {
  let out = CSV_HEADER;
  for (const x of records) {
    out += `${x.timestamp_utc},${x.timestamp_local},${x.parking_id},${x.parking_slug},${x.capacity},${x.available},${x.occupied},${x.occupancy_pct}\n`;
  }
  return out;
}

interface ResponseOpts {
  status?: number;
  maxAge?: number;
}

function json(data: unknown, { status = 200, maxAge = 60 }: ResponseOpts = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": `public, max-age=${maxAge}`,
    },
  });
}

function csv(text: string, filename: string, { maxAge = 60 }: ResponseOpts = {}): Response {
  return new Response(text, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `inline; filename="${filename}"`,
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": `public, max-age=${maxAge}`,
    },
  });
}

async function queryReadings(env: Env, where: string, binds: (string | number)[]): Promise<ReadingRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT r.ts, r.parking_id, p.slug, r.capacity, r.available
     FROM readings r JOIN parkings p ON p.id = r.parking_id
     WHERE ${where}
     ORDER BY r.ts, r.parking_id`,
  )
    .bind(...binds)
    .all<ReadingRow>();
  return results;
}

/** Cache a la vora (edge) per no repetir lectures a D1 per a dades tancades. */
async function withCache(request: Request, maxAge: number, producer: () => Promise<Response>): Promise<Response> {
  const cache = caches.default;
  const key = new Request(new URL(request.url).toString(), { method: "GET" });
  const hit = await cache.match(key);
  if (hit) return hit;
  const res = await producer();
  if (res.ok && maxAge > 0) {
    const copy = new Response(res.body, res);
    copy.headers.set("Cache-Control", `public, max-age=${maxAge}`);
    await cache.put(key, copy.clone());
    return copy;
  }
  return res;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function handleApi(request: Request, env: Env): Promise<Response> {
  const tz = env.LOCAL_TZ ?? "Europe/Madrid";
  const url = new URL(request.url);
  const path = url.pathname;
  const today = localParts(new Date(), tz).local_date;
  // Un dia es considera tancat (cachejable) només 5 minuts després de mitjanit,
  // per donar temps a l'última captura del dia.
  const closedBefore = localParts(new Date(Date.now() - 5 * 60_000), tz).local_date;
  const isPast = (day: string) => day < closedBefore;
  const nowTs = Math.floor(Date.now() / 1000);

  if (path === "/api/parkings") {
    const { results } = await env.DB.prepare("SELECT * FROM parkings ORDER BY id").all<ParkingInfo>();
    return json(results, { maxAge: 3600 });
  }

  if (path === "/api/latest") {
    const { results } = await env.DB.prepare(
      `SELECT r.ts, r.parking_id, p.slug, p.name, r.capacity, r.available
       FROM readings r JOIN parkings p ON p.id = r.parking_id
       WHERE r.ts >= ?1 ORDER BY r.ts, r.parking_id`,
    )
      .bind(nowTs - SPARK_MINUTES * 60)
      .all<LatestRow>();
    const byParking = new Map<number, { last: LatestRow; spark: [number, number][] }>();
    for (const r of results) {
      const e = byParking.get(r.parking_id);
      if (e) {
        e.last = r;
        e.spark.push([r.ts, r.available]);
      } else byParking.set(r.parking_id, { last: r, spark: [[r.ts, r.available]] });
    }
    const parkings: LatestParking[] = [...byParking.values()].map(({ last, spark }) => ({
      parking_id: last.parking_id,
      parking_slug: last.slug,
      name: last.name,
      timestamp_utc: isoUtc(last.ts),
      timestamp_local: localIso(last.ts, tz),
      capacity: last.capacity,
      available: last.available,
      occupied: last.capacity - last.available,
      occupancy_pct: pct(last.capacity, last.available),
      spark,
    }));
    const payload: LatestResponse = { generated_at: isoUtc(nowTs), parkings };
    return json(payload, { maxAge: 30 });
  }

  if (path === "/api/status") {
    // Opcions cares, només si es demanen: el total obliga a recórrer tota la
    // taula, i l'HTML dels errors infla la resposta.
    const health = await checkHealth(env, new Date(), {
      totals: url.searchParams.get("totals") === "1",
      html: url.searchParams.get("html") === "1",
    });
    // 503 quan la captura no va bé: així un monitor extern se n'assabenta sense
    // haver d'interpretar el cos de la resposta.
    return json(health, { status: health.healthy ? 200 : 503, maxAge: 30 });
  }

  // /api/day/AAAA-MM-DD (json)  |  /data/AAAA-MM-DD.csv
  const dayMatch = path.match(/^\/api\/day\/(\d{4}-\d{2}-\d{2})$/) ?? path.match(/^\/data\/(\d{4}-\d{2}-\d{2})\.csv$/);
  if (dayMatch) {
    const day = dayMatch[1] as string;
    const asCsv = path.endsWith(".csv");
    const past = isPast(day);
    const maxAge = past ? 86_400 : 60;
    return withCache(request, past ? 86_400 : 0, async () => {
      const recs = (await queryReadings(env, "r.local_date = ?1", [day])).map((r) => rowToRecord(r, tz));
      return asCsv ? csv(toCsv(recs), `parking-terrassa-${day}.csv`, { maxAge }) : json(recs, { maxAge });
    });
  }

  // /data/AAAA-MM.csv (mes sencer)
  const monthMatch = path.match(/^\/data\/(\d{4}-\d{2})\.csv$/);
  if (monthMatch) {
    const month = monthMatch[1] as string;
    const past = month < closedBefore.slice(0, 7);
    return withCache(request, past ? 86_400 : 0, async () => {
      const rows = await queryReadings(env, "r.local_date >= ?1 AND r.local_date < ?2", [`${month}-01`, `${month}-32`]);
      return csv(toCsv(rows.map((r) => rowToRecord(r, tz))), `parking-terrassa-${month}.csv`, {
        maxAge: past ? 86_400 : 300,
      });
    });
  }

  if (path === "/api/hourly") {
    const days = Math.min(Math.max(Number(url.searchParams.get("days") ?? 7) || 7, 1), 92);
    const { results } = await env.DB.prepare(
      `SELECT h.hour_ts, h.parking_id, p.slug, h.capacity, h.n, h.avg_available, h.min_available, h.max_available
       FROM hourly h JOIN parkings p ON p.id = h.parking_id
       WHERE h.hour_ts >= ?1 ORDER BY h.hour_ts, h.parking_id`,
    )
      .bind(nowTs - days * 86_400)
      .all<HourlyRow>();
    const out: HourlyRecord[] = results.map((r) => ({
        hour_utc: isoUtc(r.hour_ts),
        hour_local: localIso(r.hour_ts, tz),
        parking_id: r.parking_id,
        parking_slug: r.slug,
        capacity: r.capacity,
        n: r.n,
        avg_available: Math.round(r.avg_available * 10) / 10,
        min_available: r.min_available,
        max_available: r.max_available,
        avg_occupancy_pct: pct(r.capacity, r.avg_available),
    }));
    return json(out, { maxAge: 300 });
  }

  if (path === "/api/heatmap") {
    const weeks = Math.min(Math.max(Number(url.searchParams.get("weeks") ?? 8) || 8, 1), 52);
    const { results } = await env.DB.prepare(
      `SELECT h.parking_id, p.slug, h.local_dow, h.local_hour,
              AVG(100.0 * (h.capacity - h.avg_available) / h.capacity) AS avg_occupancy_pct,
              SUM(h.n) AS n
       FROM hourly h JOIN parkings p ON p.id = h.parking_id
       WHERE h.hour_ts >= ?1
       GROUP BY h.parking_id, h.local_dow, h.local_hour
       ORDER BY h.parking_id, h.local_dow, h.local_hour`,
    )
      .bind(nowTs - weeks * 7 * 86_400)
      .all<HeatmapRow>();
    const payload: HeatmapResponse = {
        weeks,
        cells: results.map((r) => ({
          parking_id: r.parking_id,
          parking_slug: r.slug,
          dow: r.local_dow,
          hour: r.local_hour,
          avg_occupancy_pct: Math.round(r.avg_occupancy_pct * 10) / 10,
          n: r.n,
        })),
    };
    return json(payload, { maxAge: 600 });
  }

  // /api/santroc?days=30&threshold=25 : places lliures combinades dels pàrquings propers al Portal de Sant Roc
  if (path === "/api/santroc") {
    const days = Math.min(Math.max(Number(url.searchParams.get("days") ?? 30) || 30, 1), 366);
    const thrParam = Number(url.searchParams.get("threshold") ?? 25);
    const threshold: SantRocThreshold = (SANT_ROC_THRESHOLDS as readonly number[]).includes(thrParam) ? (thrParam as SantRocThreshold) : 25;
    const fromDay = localParts(new Date(Date.now() - (days - 1) * 86_400_000), tz).local_date;
    const ids = SANT_ROC_PARKINGS.join(",");
    const [cap, closed, live] = await env.DB.batch<Record<string, unknown>>([
      env.DB.prepare(`SELECT SUM(capacity) AS capacity FROM parkings WHERE id IN (${ids})`),
      // Dies tancats: taula precomputada (una fila per dia).
      env.DB.prepare("SELECT * FROM daily_santroc WHERE day >= ?1 AND day < ?2 ORDER BY day").bind(fromDay, today),
      // Avui: càlcul en viu sobre els minuts d'avui.
      // SQLite: amb un únic MIN() a la consulta, la columna nua "ts" pren el valor de la fila del mínim.
      env.DB.prepare(
        `SELECT day, COUNT(*) AS minutes, MIN(free) AS min_free, ts AS min_ts,
                SUM(CASE WHEN free < ?2 THEN 1 ELSE 0 END) AS minutes_below
         FROM (
           SELECT ts, MIN(local_date) AS day, SUM(available) AS free
           FROM readings
           WHERE parking_id IN (${ids}) AND local_date = ?1
           GROUP BY ts
           HAVING COUNT(*) = ${SANT_ROC_PARKINGS.length}
         )
         GROUP BY day`,
      ).bind(today, threshold),
    ]);
    const capacity = Number((cap?.results[0] as { capacity: number | null } | undefined)?.capacity ?? 0);
    const closedRows = (closed?.results ?? []) as unknown as DailySantRocRow[];
    const liveRows = (live?.results ?? []) as unknown as SantRocDayRow[];
    const belowKey = `below_${threshold}` as const;
    const dayRows: SantRocDayRow[] = [
      ...closedRows.map((r) => ({ day: r.day, minutes: r.minutes, min_free: r.min_free, min_ts: r.min_ts, minutes_below: r[belowKey] })),
      ...liveRows,
    ];
    const payload: SantRocResponse = {
        parking_ids: [...SANT_ROC_PARKINGS],
        capacity,
        threshold,
        days: dayRows.map((r) => ({
          day: r.day,
          minutes: r.minutes,
          min_free: r.min_free,
          min_at_utc: isoUtc(r.min_ts),
          min_at_local: localIso(r.min_ts, tz),
          minutes_below: r.minutes_below,
        })),
    };
    return json(payload, { maxAge: 300 });
  }

  if (path === "/api/days") {
    const { results } = await env.DB.prepare(
      "SELECT local_date AS day, COUNT(*) AS rows_ FROM readings GROUP BY local_date ORDER BY local_date DESC LIMIT 400",
    ).all<{ day: string; rows_: number }>();
    const out: DayCount[] = results.map((r) => ({ day: r.day, rows: r.rows_ }));
    return json(out, { maxAge: 300 });
  }

  return json({ error: "no trobat" }, { status: 404 });
}

// ---------------------------------------------------------------------------
// Entrades del Worker
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/api/") || pathname.startsWith("/data/")) {
      try {
        return await handleApi(request, env);
      } catch (e) {
        console.error("api error", e);
        return json({ error: "error intern", detail: errorMessage(e) }, { status: 500, maxAge: 0 });
      }
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx): Promise<void> {
    if (event.cron === CRON_HOURLY) {
      ctx.waitUntil(hourlyMaintenance(env, new Date(event.scheduledTime)));
      return;
    }
    const r = await scrapeAll(env, new Date(event.scheduledTime));
    const summary = r.outcomes
      .map((o) => (o.error !== undefined ? `${o.id}:ERR(${o.error})` : `${o.id}:${o.available}/${o.capacity}`))
      .join(" ");
    console.log(`scrape ${isoUtc(r.ts)} ${summary}`);
  },
} satisfies ExportedHandler<Env>;
