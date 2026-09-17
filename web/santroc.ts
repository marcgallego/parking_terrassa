/* Pàgina del Portal de Sant Roc: places lliures sumades d'Ajuntament-Mercat i Plaça Vella. */
import { getJson } from "./api";
import type { DaySeriesParking, DaySeriesResponse, HourlyRecord, SantRocDay, SantRocResponse, Slug } from "./api";
import { $, COLOR_VAR, NAMES, SANT_ROC, addDays, atSec, chips, cssVar, esc, fmtDate, fmtDay, fmtDayTime, fmtTime, localToday, logErr, pct1, renderStatus, setChip, setNotice, staleNotice, tableHtml, tipRow, zonedMidnight } from "./common";
import { alignSeries, barSeries, baseOptions, clickPlugin, lineSeries, mount, refLinePlugin, timeAxis, tooltipPlugin, valueAxis } from "./charts";

// Aquesta pàgina és la portada; els enllaços antics a la de tots els pàrquings (/?range=, /?weeks=) porten a /saba.
const legacyParams = new URLSearchParams(location.search);
const legacy = legacyParams.has("range") || legacyParams.has("weeks");
if (legacy) location.replace(`/saba${location.search}`);

/** Mentre el dataset sigui curt, el període és tot el que hi ha i el llindar és fix. */
const DAYS = 365;
const THRESHOLD = 25;

/** Interval del gràfic de dalt: un dia minut a minut, o diversos dies hora a hora. */
type Interval = "dia" | "7" | "30";
const INTERVALS: readonly Interval[] = ["dia", "7", "30"];

/** Línies del gràfic, a més del total. */
const LINES: readonly Slug[] = ["placa-vella", "ajuntament-mercat"];

/** Un instant amb lectura dels dos pàrquings. `x` en segons Unix. */
interface FreePoint {
  x: number;
  free: number;
  capacity: number;
  parts: Partial<Record<Slug, number>>;
  /** Places lliures en el pitjor minut de l'hora; només als intervals llargs. */
  min?: number;
}

/** Un dia sencer, minut a minut, i l'instant (ms) de l'última lectura que en té. */
interface DayData { points: FreePoint[]; last: number }

type SeriesPoint = DaySeriesParking["points"][number];

let today: FreePoint[] | null = null;
/** Quan es van carregar les dades d'avui que es veuen, per avisar si deixen d'estar fresques. */
let todayAt: number | null = null;
let todayDay = localToday();
let period: SantRocResponse | null = null;
let periodDay = "";
let hourly: { interval: Interval; at: number; points: FreePoint[] } | null = null;
let todayReq = 0, dayReq = 0, hourlyReq = 0, periodReq = 0;

/** Dies ja descarregats. Un dia tancat no canvia mai; el d'avui es refresca cada minut. */
const dayCache = new Map<string, DayData>();

/** Interval i dia que es mostren al gràfic de dalt. */
let interval: Interval = "dia";
let day = initialDay();

const names = SANT_ROC.map((s) => NAMES[s]).join(" + ");
const fmtMinute = (s: number): string => atSec(fmtTime, s);
const fmtFree = (v: number): string => (Number.isInteger(v) ? String(v) : pct1(v));
/** Migdia d'un dia AAAA-MM-DD, en segons Unix: prou lluny de les vores per formatar-lo. */
const noon = (d: string): number => zonedMidnight(d) + 12 * 3600;
const narrowHeight = (narrow: number, wide: number) => (w: number): number => (w < 560 ? narrow : wide);

/** Dia demanat per l'URL (`?dia=AAAA-MM-DD`), si és un dia passat vàlid. */
function initialDay(): string {
  const d = legacyParams.get("dia") ?? "";
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= localToday() ? d : localToday();
}

/** Primer dia amb dades, un cop carregat el període; null mentre no se sap. */
const firstDay = (): string | null => period?.days[0]?.day ?? null;

// ----- dades -----------------------------------------------------------------
/** Agrupa les lectures d'un dia pels minuts en què tots dos pàrquings tenen lectura. */
function toDayData(data: DaySeriesResponse): DayData {
  const byTs = new Map<number, Partial<Record<Slug, SeriesPoint>>>();
  let last = 0;
  for (const p of data.parkings) {
    if (!SANT_ROC.includes(p.parking_slug)) continue;
    for (const pt of p.points) {
      last = Math.max(last, pt[0] * 1000);
      const e = byTs.get(pt[0]) ?? {};
      e[p.parking_slug] = pt;
      byTs.set(pt[0], e);
    }
  }
  const points: FreePoint[] = [];
  for (const [t, e] of [...byTs.entries()].sort((a, b) => a[0] - b[0])) {
    const vals = SANT_ROC.map((s) => e[s]);
    if (!vals.every((p): p is SeriesPoint => p !== undefined)) continue;
    points.push({
      x: t,
      free: vals.reduce((a, p) => a + p[1], 0),
      capacity: vals.reduce((a, p) => a + p[2], 0),
      parts: Object.fromEntries(SANT_ROC.map((s) => [s, e[s]?.[1]])),
    });
  }
  return { points, last };
}

/**
 * Agrupa l'agregat horari per hores amb lectura dels dos pàrquings.
 *
 * `free` és la mitjana de l'hora, que sumada pàrquing a pàrquing és exacta.
 * `min` suma el mínim de cada pàrquing: com que els dos mínims poden ser de
 * minuts diferents, queda igual o per sota del pitjor minut real conjunt, i per
 * tant és una cota prudent.
 */
function toHourPoints(rows: HourlyRecord[]): FreePoint[] {
  const byHour = new Map<number, Partial<Record<Slug, HourlyRecord>>>();
  for (const r of rows) {
    if (!SANT_ROC.includes(r.parking_slug)) continue;
    const t = Date.parse(r.hour_utc) / 1000;
    const e = byHour.get(t) ?? {};
    e[r.parking_slug] = r;
    byHour.set(t, e);
  }
  const points: FreePoint[] = [];
  for (const [x, e] of [...byHour.entries()].sort((a, b) => a[0] - b[0])) {
    const parts = SANT_ROC.map((s) => e[s]);
    if (!parts.every((p): p is HourlyRecord => p !== undefined)) continue;
    const round1 = (v: number): number => Math.round(v * 10) / 10;
    points.push({
      x,
      free: round1(parts.reduce((a, p) => a + p.avg_available, 0)),
      capacity: parts.reduce((a, p) => a + p.capacity, 0),
      parts: Object.fromEntries(parts.map((p) => [p.parking_slug, round1(p.avg_available)])),
      min: parts.reduce((a, p) => a + p.min_available, 0),
    });
  }
  return points;
}

async function fetchDay(d: string): Promise<DayData> {
  // Format compacte: el dia en format llarg fa ~860 KB i costava prou CPU al
  // Worker perquè Cloudflare el tallés (error 1102, que arriba com un 503).
  const data = toDayData(await getJson<DaySeriesResponse>(`/api/day/${d}/series`));
  dayCache.set(d, data);
  return data;
}

/** El dia en curs es carrega sempre: n'hi ha les estadístiques i l'estat de la captura. */
async function loadToday(): Promise<void> {
  const req = ++todayReq;
  const d = localToday();
  let data: DayData;
  try {
    data = await fetchDay(d);
  } catch {
    if (req !== todayReq) return;
    // Sense lectures noves es manté el que ja es veu (gràfic i estadístiques), dient de quan és.
    if (!today) $("#status-text").textContent = "No s'han pogut carregar les lectures d'avui";
    setNotice(staleNotice(todayAt));
    return;
  }
  if (req !== todayReq) return;
  // El dia que s'acaba de tancar estava a mitges; es tornarà a demanar sencer si es mira.
  if (d !== todayDay) dayCache.delete(todayDay);
  today = data.points;
  todayDay = d;
  todayAt = Date.now();
  setNotice(null);
  renderStatus(data.last);
  if (interval === "dia" && day === d) renderChart();
  renderStats();
}

async function loadChartDay(d: string): Promise<void> {
  if (d === localToday()) { await loadToday(); return; }
  const req = ++dayReq;
  if (dayCache.has(d)) { renderChart(); return; }
  await fetchDay(d);
  if (req !== dayReq || d !== day) return;
  renderChart();
}

/** Els intervals llargs surten de l'agregat horari, que el Worker recalcula cada hora. */
async function loadHourly(iv: Interval, maxAgeMs = 5 * 60_000): Promise<void> {
  if (hourly && hourly.interval === iv && Date.now() - hourly.at < maxAgeMs) return;
  const req = ++hourlyReq;
  const rows = await getJson<HourlyRecord[]>(`/api/hourly?days=${iv}`);
  if (req !== hourlyReq) return;
  hourly = { interval: iv, at: Date.now(), points: toHourPoints(rows) };
  if (interval === iv) renderChart();
}

// ----- gràfic de dalt --------------------------------------------------------
interface FreeChartOpts {
  /** forat a partir del qual la línia es talla en lloc de continuar recta */
  gapSec: number;
  xRange?: [number, number];
  axis: "clock" | "calendar";
  empty: string;
  title: (x: number) => string;
}

function renderFreeChart(points: FreePoint[], o: FreeChartOpts): void {
  const t = THRESHOLD;
  const capacity = points[points.length - 1]?.capacity ?? period?.capacity ?? 0;
  const yMax = Math.max(capacity, t * 2, ...points.map((p) => p.free));
  const byX = new Map(points.map((p) => [p.x, p]));
  // Tres línies des de zero: el total (que és el que es compara amb el llindar) i cada pàrquing.
  mount($("#sr-chart"), {
    data: alignSeries(points.map((p) => p.x), [(x) => byX.get(x)?.free, ...LINES.map((s) => (x: number) => byX.get(x)?.parts[s])], o.gapSec),
    empty: o.empty,
    height: narrowHeight(240, 300),
    options: () => {
      const cTotal = cssVar("--text-primary");
      return {
        ...baseOptions(),
        series: [
          {},
          lineSeries("total", cTotal, { width: 2.5 }),
          ...LINES.map((s) => lineSeries(NAMES[s], cssVar(COLOR_VAR[s]), { width: 1.5 })),
        ],
        scales: { x: o.xRange ? { time: true, range: o.xRange } : { time: true }, y: { range: [0, yMax] } },
        axes: [timeAxis(o.axis), valueAxis(String)],
        plugins: [
          refLinePlugin(t, `llindar: ${t} lliures`, cssVar("--bad")),
          tooltipPlugin((u, idx) => {
            const x = u.data[0][idx] ?? 0, p = byX.get(x);
            let html = `<b>${esc(o.title(x))}</b>`;
            if (!p) return html + tipRow("places lliures", "sense lectura");
            html += tipRow("total", `${fmtFree(p.free)} de ${p.capacity}`, cTotal);
            if (p.min !== undefined) html += tipRow("mínim de l'hora", `${p.min} lliures`);
            for (const s of LINES) {
              const v = p.parts[s];
              html += tipRow(NAMES[s], v === undefined ? "–" : fmtFree(v), cssVar(COLOR_VAR[s]));
            }
            return html;
          }),
        ],
      };
    },
  });
}

function renderChart(): void {
  renderControls();
  if (interval === "dia") {
    const isToday = day === localToday();
    const data = dayCache.get(day);
    renderFreeChart(data?.points ?? [], {
      gapSec: 5 * 60,
      xRange: [zonedMidnight(day), zonedMidnight(addDays(day, 1))],
      axis: "clock",
      empty: data ? (isToday ? "Encara no hi ha lectures d'avui" : "No hi ha lectures d'aquest dia") : "Carregant…",
      title: (x) => `${isToday ? "avui" : atSec(fmtDay, x)} · ${fmtMinute(x)}`,
    });
  } else {
    const points = hourly?.interval === interval ? hourly.points : null;
    renderFreeChart(points ?? [], {
      gapSec: 2 * 3600,
      axis: "calendar",
      empty: points ? "Encara no hi ha dades d'aquest interval" : "Carregant…",
      title: (x) => `${atSec(fmtDayTime, x)} · mitjana horària`,
    });
  }
}

// ----- selector d'interval i de dia ------------------------------------------
const dateInput = $<HTMLInputElement>("#sr-date");
const prevBtn = $<HTMLButtonElement>("#sr-prev");
const nextBtn = $<HTMLButtonElement>("#sr-next");
const todayBtn = $<HTMLButtonElement>("#sr-go-today");

function renderControls(): void {
  const t = localToday(), first = firstDay();
  $("#sr-daynav").hidden = interval !== "dia";
  dateInput.value = day;
  dateInput.max = t;
  if (first) dateInput.min = first;
  prevBtn.disabled = first !== null && day <= first;
  nextBtn.disabled = day >= t;
  todayBtn.disabled = day === t;
  $("#sr-chart-title").textContent = interval === "dia"
    ? (day === t ? "Avui, dades minut a minut" : `${atSec(fmtDate, noon(day))}, dades minut a minut`)
    : `Últims ${interval} dies, dades hora a hora`;
  $("#sr-chart-hint").textContent = interval === "dia"
    ? `Places lliures entre tots dos pàrquings i de cadascun. La línia vermella marca el llindar de ${THRESHOLD} places lliures, que es compara amb el total.`
    : `Mitjana de places lliures per hora. El mínim de cada hora surt a l'etiqueta del cursor: suma el mínim de cada pàrquing, de manera que és una cota prudent. La línia vermella marca el llindar de ${THRESHOLD} places lliures.`;
}

function syncUrl(): void {
  const url = new URL(location.href);
  if (interval === "dia") url.searchParams.delete("interval"); else url.searchParams.set("interval", interval);
  if (interval === "dia" && day !== localToday()) url.searchParams.set("dia", day); else url.searchParams.delete("dia");
  history.replaceState(null, "", url);
}

const chartError = (msg: string): void => { $("#sr-chart-hint").textContent = msg; };

function selectDay(d: string): void {
  const first = firstDay(), t = localToday();
  day = d > t ? t : (first && d < first ? first : d);
  syncUrl();
  renderChart();
  loadChartDay(day).catch((e: unknown) => { chartError("No s'han pogut carregar les lectures d'aquest dia"); logErr(e); });
}

/** Obre un dia concret al gràfic de dalt, vingui d'on vingui (calendari o barres). */
function openDay(d: string): void {
  day = d;
  // Si cal canviar d'interval, el propi canvi ja carrega i dibuixa el dia.
  if (interval !== "dia") setChip("interval", "dia");
  else selectDay(d);
}

function selectInterval(iv: Interval): void {
  interval = iv;
  syncUrl();
  renderChart();
  if (iv === "dia") loadChartDay(day).catch(logErr);
  else loadHourly(iv).catch((e: unknown) => { chartError("No s'han pogut carregar les dades d'aquest interval"); logErr(e); });
}

// ----- període ---------------------------------------------------------------
async function loadPeriod(): Promise<void> {
  const req = ++periodReq;
  const d = localToday();
  const sr = await getJson<SantRocResponse>(`/api/santroc?days=${DAYS}&threshold=${THRESHOLD}`);
  if (req !== periodReq) return;
  period = sr;
  periodDay = d;
  renderPeriod();
  renderControls();
  renderStats();
}

/** El període només compta dies complets; el dia d'avui té les seves pròpies estadístiques. */
const completeDays = (): SantRocDay[] => (period ? period.days.filter((d) => d.day !== localToday()) : []);

function renderPeriod(): void {
  if (!period) return;
  const list = completeDays(), t = period.threshold;
  const xs = list.map((d) => zonedMidnight(d.day) + 12 * 3600);
  const byX = new Map(list.map((d, i) => [xs[i] ?? 0, d]));
  const yMax = Math.max(t * 2, ...list.map((d) => d.min_free)) * 1.1;
  $("#sr-daily-hint").textContent = `Cada barra és el moment del dia amb menys places lliures sumant ${names}. En vermell, els dies que han baixat de ${t}. ${list.length} dies complets analitzats. Fes clic en una barra per veure aquell dia minut a minut.`;
  mount($("#sr-daily"), {
    data: [xs, list.map((d) => (d.min_free < t ? null : d.min_free)), list.map((d) => (d.min_free < t ? d.min_free : null))],
    empty: "Encara no hi ha dies complets",
    height: narrowHeight(200, 240),
    options: () => {
      const base = baseOptions();
      return {
        ...base,
        cursor: { ...base.cursor, points: { show: false } },
        series: [{}, barSeries(`${t} lliures o més`, cssVar("--text-muted")), barSeries(`menys de ${t} lliures`, cssVar("--bad"))],
        // mig dia de marge a cada banda perquè la primera i l'última barra no quedin tallades
        scales: { x: { time: true, range: [(xs[0] ?? 0) - 12 * 3600, (xs[xs.length - 1] ?? 0) + 12 * 3600] }, y: { range: [0, yMax] } },
        axes: [timeAxis("calendar"), valueAxis(String)],
        plugins: [
          refLinePlugin(t, `llindar: ${t}`, cssVar("--bad")),
          clickPlugin((idx) => { const d = byX.get(xs[idx] ?? 0); if (d) openDay(d.day); }),
          tooltipPlugin((u, idx) => {
            const x = u.data[0][idx] ?? 0, d = byX.get(x);
            if (!d) return "";
            return `<b>${esc(atSec(fmtDay, x))}</b>`
              + tipRow("mínim", `${d.min_free} lliures a les ${fmtTime.format(new Date(d.min_at_utc))}`)
              + tipRow(`sota ${t}`, `${d.minutes_below} min`)
              + tipRow("minuts amb lectura", String(d.minutes));
          }),
        ],
      };
    },
  });
  $("#sr-table").innerHTML = tableHtml(
    ["dia", "mínim lliures", "hora del mínim", `minuts amb < ${t}`, "minuts amb lectura"],
    list.map((d) => [d.day, String(d.min_free), fmtTime.format(new Date(d.min_at_utc)), String(d.minutes_below), String(d.minutes)]),
  );
}

// ----- estadístiques ---------------------------------------------------------
function statHtml(value: string, unit: string, label: string, sub = "", bad = false): string {
  return `<div class="stat${bad ? " is-bad" : ""}"><div class="v">${esc(value)}${unit ? `<small>${esc(unit)}</small>` : ""}</div><div class="l">${esc(label)}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ""}</div>`;
}

function renderStats(): void {
  const points = today ?? [], t = THRESHOLD;
  const now = points[points.length - 1];
  const todayMin = points.reduce<FreePoint | null>((acc, p) => (acc === null || p.free < acc.free ? p : acc), null);
  const out = [
    now
      ? statHtml(String(now.free), `de ${now.capacity}`, "places lliures ara mateix", `a les ${fmtMinute(now.x)}`, now.free < t)
      : statHtml("–", "", "places lliures ara mateix", today ? "sense lectura d'avui" : "carregant…"),
    todayMin ? statHtml(String(todayMin.free), "", "mínim d'avui", `a les ${fmtMinute(todayMin.x)}`, todayMin.free < t) : statHtml("–", "", "mínim d'avui"),
  ];
  if (period) {
    const list = completeDays(), pt = period.threshold;
    const totalMinutes = list.reduce((a, d) => a + d.minutes, 0);
    const belowMinutes = list.reduce((a, d) => a + d.minutes_below, 0);
    const daysBelow = list.filter((d) => d.minutes_below > 0).length;
    // El mínim del període inclou el d'avui, que es refresca cada minut: si avui
    // es bat el rècord, l'indicador ho diu a l'instant i no l'endemà.
    const worst = [
      ...list.map((d) => ({ free: d.min_free, at: new Date(d.min_at_utc) })),
      ...(todayMin ? [{ free: todayMin.free, at: new Date(todayMin.x * 1000) }] : []),
    ].reduce<{ free: number; at: Date } | null>((acc, d) => (acc === null || d.free < acc.free ? d : acc), null);
    out.push(
      statHtml(String(daysBelow), `de ${list.length} dies`, `dies amb menys de ${pt} lliures`, list.length ? `${pct1((100 * daysBelow) / list.length)} % dels dies complets` : "encara cap dia complet", daysBelow > 0),
      statHtml(totalMinutes ? pct1((100 * belowMinutes) / totalMinutes) : "–", totalMinutes ? "%" : "","del temps sota el llindar", totalMinutes ? `${belowMinutes.toLocaleString("ca")} de ${totalMinutes.toLocaleString("ca")} minuts` : "", belowMinutes > 0),
      worst ? statHtml(String(worst.free), "lliures", "mínim del període", `${fmtDay.format(worst.at)} a les ${fmtTime.format(worst.at)}`, worst.free < pt) : statHtml("–", "", "mínim del període"),
    );
  }
  $("#sr-stats").innerHTML = out.join("");
}

// ----- init ------------------------------------------------------------------
if (!legacy) {
  interval = chips<Interval>("interval", INTERVALS, "dia", selectInterval);
  prevBtn.addEventListener("click", () => selectDay(addDays(day, -1)));
  nextBtn.addEventListener("click", () => selectDay(addDays(day, 1)));
  todayBtn.addEventListener("click", () => selectDay(localToday()));
  dateInput.addEventListener("change", () => { if (dateInput.value) selectDay(dateInput.value); });

  renderStats();
  renderChart();
  loadToday().catch(logErr);
  if (interval === "dia") { if (day !== localToday()) loadChartDay(day).catch(logErr); }
  else loadHourly(interval).catch(logErr);
  loadPeriod().catch(logErr);

  window.setInterval(() => {
    const t = localToday();
    // Si passa la mitjanit, qui mirava «avui» continua mirant avui.
    if (t !== todayDay && day === todayDay) { day = t; syncUrl(); }
    loadToday().catch(logErr);
    if (interval !== "dia") loadHourly(interval).catch(logErr);
    // Els dies complets només canvien quan canvia el dia.
    if (periodDay && periodDay !== t) loadPeriod().catch(logErr);
  }, 60_000);
}
