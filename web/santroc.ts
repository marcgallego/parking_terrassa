/* Pàgina del Portal de Sant Roc: places lliures sumades d'Ajuntament-Mercat i Plaça Vella. */
import { getJson } from "./api";
import type { DaySeriesParking, DaySeriesResponse, SantRocDay, SantRocResponse, Slug } from "./api";
import { $, COLOR_VAR, NAMES, SANT_ROC, addDays, atSec, cssVar, esc, fmtDay, fmtTime, localToday, logErr, pct1, renderStatus, setNotice, staleNotice, tableHtml, tipRow, zonedMidnight } from "./common";
import { alignSeries, barSeries, baseOptions, lineSeries, mount, refLinePlugin, timeAxis, tooltipPlugin, valueAxis } from "./charts";

// Aquesta pàgina és la portada; els enllaços antics a la de tots els pàrquings (/?range=, /?weeks=) porten a /saba.
const legacyParams = new URLSearchParams(location.search);
const legacy = legacyParams.has("range") || legacyParams.has("weeks");
if (legacy) location.replace(`/saba${location.search}`);

/** Mentre el dataset sigui curt, el període és tot el que hi ha i el llindar és fix. */
const DAYS = 365;
const THRESHOLD = 25;

/** Un minut d'avui amb lectura dels dos pàrquings. `x` en segons Unix. */
interface FreePoint { x: number; free: number; capacity: number; parts: Partial<Record<Slug, number>> }

type SeriesPoint = DaySeriesParking["points"][number];

let today: FreePoint[] | null = null;
/** Quan es van carregar les dades d'avui que es veuen, per avisar si deixen d'estar fresques. */
let todayAt: number | null = null;
let todayDay = localToday();
let period: SantRocResponse | null = null;
let periodDay = "";
let todayReq = 0, periodReq = 0;

const names = SANT_ROC.map((s) => NAMES[s]).join(" + ");
const fmtMinute = (s: number): string => atSec(fmtTime, s);
const narrowHeight = (narrow: number, wide: number) => (w: number): number => (w < 560 ? narrow : wide);

// ----- avui ------------------------------------------------------------------
async function loadToday(): Promise<void> {
  const req = ++todayReq;
  const day = localToday();
  let data: DaySeriesResponse;
  try {
    // Format compacte: el dia en format llarg fa ~860 KB i costava prou CPU al
    // Worker perquè Cloudflare el tallés (error 1102, que arriba com un 503).
    data = await getJson<DaySeriesResponse>(`/api/day/${day}/series`);
  } catch {
    // Sense lectures noves es manté el que ja es veu, dient de quan és.
    if (req === todayReq) setNotice(staleNotice(todayDay === day ? todayAt : null));
    return;
  }
  if (req !== todayReq) return;
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
  renderStatus(last);
  const points: FreePoint[] = [];
  for (const [t, e] of [...byTs.entries()].sort((a, b) => a[0] - b[0])) {
    const vals = SANT_ROC.map((s) => e[s]);
    if (!vals.every((p): p is SeriesPoint => p !== undefined)) continue;
    points.push({
      x: t,
      free: vals.reduce((a, p) => a + p[1], 0),
      capacity: vals.reduce((a, p) => a + p[2], 0),
      parts: Object.fromEntries(SANT_ROC.map((s, i) => [s, vals[i]?.[1]])),
    });
  }
  today = points;
  todayDay = day;
  todayAt = Date.now();
  setNotice(null);
  renderToday();
  renderStats();
}

function renderToday(): void {
  if (!today) return;
  const points = today, t = THRESHOLD, day = todayDay;
  const capacity = points[points.length - 1]?.capacity ?? period?.capacity ?? 0;
  const yMax = Math.max(capacity, t * 2, ...points.map((p) => p.free));
  const byX = new Map(points.map((p) => [p.x, p]));
  // Tres línies des de zero: el total (que és el que es compara amb el llindar) i cada pàrquing.
  const parkings: readonly Slug[] = ["placa-vella", "ajuntament-mercat"];
  mount($("#sr-today"), {
    data: alignSeries(points.map((p) => p.x), [(x) => byX.get(x)?.free, ...parkings.map((s) => (x: number) => byX.get(x)?.parts[s])], 5 * 60),
    empty: "Encara no hi ha lectures d'avui",
    height: narrowHeight(240, 300),
    options: () => {
      const cTotal = cssVar("--text-primary");
      return {
        ...baseOptions(),
        series: [
          {},
          lineSeries("total", cTotal, { width: 2.5 }),
          ...parkings.map((s) => lineSeries(NAMES[s], cssVar(COLOR_VAR[s]), { width: 1.5 })),
        ],
        scales: { x: { time: true, range: [zonedMidnight(day), zonedMidnight(addDays(day, 1))] }, y: { range: [0, yMax] } },
        axes: [timeAxis("clock"), valueAxis(String)],
        plugins: [
          refLinePlugin(t, `llindar: ${t} lliures`, cssVar("--bad")),
          tooltipPlugin((u, idx) => {
            const x = u.data[0][idx] ?? 0, p = byX.get(x);
            let html = `<b>avui · ${esc(fmtMinute(x))}</b>`;
            if (!p) return html + tipRow("places lliures", "sense lectura");
            html += tipRow("total", `${p.free} de ${p.capacity}`, cTotal);
            for (const s of parkings) html += tipRow(NAMES[s], String(p.parts[s] ?? "–"), cssVar(COLOR_VAR[s]));
            return html;
          }),
        ],
      };
    },
  });
}

// ----- període ---------------------------------------------------------------
async function loadPeriod(): Promise<void> {
  const req = ++periodReq;
  const day = localToday();
  const sr = await getJson<SantRocResponse>(`/api/santroc?days=${DAYS}&threshold=${THRESHOLD}`);
  if (req !== periodReq) return;
  period = sr;
  periodDay = day;
  renderPeriod();
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
  $("#sr-daily-hint").textContent = `Cada barra és el moment del dia amb menys places lliures sumant ${names}. En vermell, els dies que han baixat de ${t}. ${list.length} dies complets analitzats.`;
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
  renderStats();
  loadToday().catch(logErr);
  loadPeriod().catch(logErr);
  window.setInterval(() => {
    loadToday().catch(logErr);
    // Els dies complets només canvien quan canvia el dia.
    if (periodDay && periodDay !== localToday()) loadPeriod().catch(logErr);
  }, 60_000);
}

