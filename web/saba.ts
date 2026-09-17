/* Pàgina dels pàrquings Saba (/saba): estat dels tres pàrquings, ocupació, patró setmanal i dades obertes. */
import type uPlot from "uplot";
import { getJson } from "./api";
import type { DayCount, DayRecord, HeatmapResponse, HourlyRecord, LatestResponse, Slug } from "./api";
import { $, COLOR_VAR, NAMES, ORDER, addDays, atSec, chips, cssVar, esc, fmtDate, fmtDayTime, fmtTime, hideTip, localToday, logErr, onThemeChange, pad2, pct1, renderStatus, seq, showTip, tableHtml, tipRow, zonedMidnight } from "./common";
import { alignSeries, baseOptions, lineSeries, mount, setSeriesShown, sparkOptions, timeAxis, tooltipPlugin, valueAxis } from "./charts";

const DOW = ["dl", "dt", "dc", "dj", "dv", "ds", "dg"] as const;
const DOW_LONG = ["dilluns", "dimarts", "dimecres", "dijous", "divendres", "dissabte", "diumenge"] as const;
const HOURS = Array.from({ length: 24 }, (_, i) => i);

type Range = "today" | "7" | "30";
type Weeks = "4" | "8" | "26";

// ----- KPI tiles -------------------------------------------------------------
let lastLatest: LatestResponse | null = null;

function renderKpi(latest: LatestResponse): void {
  lastLatest = latest;
  const bySlug = new Map(latest.parkings.map((p) => [p.parking_slug, p]));
  $("#kpi").innerHTML = ORDER.map((slug) => {
    const p = bySlug.get(slug);
    const head = `<div class="name"><i class="swatch" style="background:var(${COLOR_VAR[slug]})"></i>${NAMES[slug]}</div>`;
    if (!p) return `<article class="tile is-empty">${head}<div>Sense dades recents</div></article>`;
    const v = p.occupancy_pct;
    return `<article class="tile" aria-label="${esc(p.name)}">
      ${head}
      <div class="hero">${p.available}<small>places lliures de ${p.capacity}</small></div>
      <div class="meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${v}" aria-label="Ocupació"><i style="width:${v}%;background:${seq(0.25 + (0.75 * v) / 100)}"></i></div>
      <div class="meta"><span>${pct1(v)} % ocupat</span><span>${fmtTime.format(new Date(p.timestamp_utc))}</span></div>
      <div class="spark" data-spark="${slug}" aria-hidden="true"></div>
      <div class="meta"><span>ocupació, últimes 3 h</span></div>
    </article>`;
  }).join("");

  for (const p of latest.parkings) {
    const host = document.querySelector<HTMLElement>(`[data-spark="${p.parking_slug}"]`);
    if (!host || p.spark.length < 2) continue;
    const cap = p.capacity;
    mount(host, {
      data: [p.spark.map(([t]) => t), p.spark.map(([, free]) => (100 * (cap - free)) / cap)],
      height: () => 36,
      options: () => sparkOptions(cssVar(COLOR_VAR[p.parking_slug]), [0, 100]),
    });
  }

  renderStatus(latest.parkings.length ? Math.max(...latest.parkings.map((p) => Date.parse(p.timestamp_utc))) : 0);
}

async function refreshLatest(): Promise<void> {
  try { renderKpi(await getJson<LatestResponse>("/api/latest")); } catch (e) { $("#status-text").textContent = "No s'ha pogut carregar l'estat"; logErr(e); }
}

// ----- ocupació --------------------------------------------------------------
const lineHost = $("#line-chart");
/** Pàrquings amagats des de la llegenda; es mantenen en canviar d'interval. */
const hidden = new Set<Slug>();
let rangeReq = 0;

interface OccupancyOpts {
  xRange?: [number, number];
  axis: "clock" | "calendar";
  title: (x: number) => string;
  /** detall addicional per al tooltip */
  detail: (x: number, slug: Slug) => string | undefined;
  empty?: string;
}

function occupancyChart(data: uPlot.AlignedData, o: OccupancyOpts): void {
  mount(lineHost, {
    data,
    empty: o.empty,
    height: (w) => (w < 560 ? 240 : 320),
    options: () => ({
      ...baseOptions(),
      series: [{}, ...ORDER.map((slug) => lineSeries(NAMES[slug], cssVar(COLOR_VAR[slug]), { show: !hidden.has(slug) }))],
      scales: { x: o.xRange ? { time: true, range: o.xRange } : { time: true }, y: { range: [0, 100] } },
      axes: [timeAxis(o.axis), valueAxis((v) => `${v} %`)],
      plugins: [
        tooltipPlugin((u, idx) => {
          const x = u.data[0][idx] ?? 0;
          let html = `<b>${esc(o.title(x))}</b>`;
          ORDER.forEach((slug, i) => {
            if (hidden.has(slug)) return;
            const v = u.data[i + 1]?.[idx];
            const detail = o.detail(x, slug);
            html += tipRow(NAMES[slug], v == null ? "sense lectura" : `${pct1(v)} %${detail ? ` · ${detail}` : ""}`, cssVar(COLOR_VAR[slug]));
          });
          return html;
        }),
      ],
    }),
  });
}

function renderLegend(): void {
  const el = $("#line-legend");
  el.innerHTML = ORDER.map((slug, i) =>
    `<button type="button" class="legend-item" data-i="${i}" aria-pressed="${!hidden.has(slug)}"><i style="background:var(${COLOR_VAR[slug]})"></i>${NAMES[slug]}</button>`,
  ).join("");
  el.addEventListener("click", (ev) => {
    const b = (ev.target as Element | null)?.closest<HTMLButtonElement>("button[data-i]");
    const i = Number(b?.dataset.i), slug = ORDER[i];
    if (!b || !slug) return;
    const show = hidden.has(slug);
    if (show) hidden.delete(slug); else hidden.add(slug);
    b.setAttribute("aria-pressed", String(show));
    setSeriesShown(lineHost, i + 1, show);
  });
}

function indexBy<R extends { parking_slug: Slug }>(rows: R[], ts: (r: R) => string): Map<number, Partial<Record<Slug, R>>> {
  const out = new Map<number, Partial<Record<Slug, R>>>();
  for (const r of rows) {
    const t = Date.parse(ts(r)) / 1000;
    const e = out.get(t) ?? {};
    e[r.parking_slug] = r;
    out.set(t, e);
  }
  return out;
}

async function loadRange(range: Range): Promise<void> {
  const req = ++rangeReq;
  const tbl = $("#line-table");
  if (range === "today") {
    const day = localToday();
    const rows = await getJson<DayRecord[]>(`/api/day/${day}`);
    if (req !== rangeReq) return;
    const byTs = indexBy(rows, (r) => r.timestamp_utc);
    const xs = [...byTs.keys()].sort((a, b) => a - b);
    occupancyChart(alignSeries(xs, ORDER.map((s) => (x: number) => byTs.get(x)?.[s]?.occupancy_pct), 5 * 60), {
      xRange: [zonedMidnight(day), zonedMidnight(addDays(day, 1))],
      axis: "clock",
      title: (x) => `${atSec(fmtDate, x)} · ${atSec(fmtTime, x)}`,
      detail: (x, s) => { const r = byTs.get(x)?.[s]; return r ? `${r.available} lliures` : undefined; },
      empty: "Encara no hi ha lectures d'avui",
    });
    const step = Math.max(1, Math.floor(xs.length / 96)); // màxim ~96 files (cada 15 min)
    tbl.innerHTML = tableHtml(
      ["hora", ...ORDER.map((s) => `${NAMES[s]} (% / lliures)`)],
      xs.filter((_, i) => i % step === 0).map((x) => [atSec(fmtTime, x), ...ORDER.map((s) => { const r = byTs.get(x)?.[s]; return r ? `${pct1(r.occupancy_pct)} % / ${r.available}` : "–"; })]),
    );
  } else {
    const rows = await getJson<HourlyRecord[]>(`/api/hourly?days=${range}`);
    if (req !== rangeReq) return;
    const byTs = indexBy(rows, (r) => r.hour_utc);
    const xs = [...byTs.keys()].sort((a, b) => a - b);
    occupancyChart(alignSeries(xs, ORDER.map((s) => (x: number) => byTs.get(x)?.[s]?.avg_occupancy_pct), 2 * 3600), {
      axis: "calendar",
      title: (x) => `${atSec(fmtDayTime, x)} (mitjana horària)`,
      detail: (x, s) => { const r = byTs.get(x)?.[s]; return r ? `mitjana ${Math.round(r.avg_available)} lliures` : undefined; },
    });
    tbl.innerHTML = tableHtml(
      ["hora (local)", ...ORDER.map((s) => `${NAMES[s]} (% mitjà)`)],
      xs.map((x) => [atSec(fmtDayTime, x), ...ORDER.map((s) => { const r = byTs.get(x)?.[s]; return r ? pct1(r.avg_occupancy_pct) : "–"; })]),
    );
  }
}

// ----- heatmaps --------------------------------------------------------------
let heatReq = 0;
let lastHeat: HeatmapResponse | null = null;

function renderHeat(data: HeatmapResponse): void {
  lastHeat = data;
  const cells = new Map(data.cells.map((c) => [`${c.parking_slug}|${c.dow}|${c.hour}`, c]));
  $("#heatmaps").innerHTML = ORDER.map((slug) => {
    let g = `<div class="heat"><div class="hname"><i class="swatch" style="background:var(${COLOR_VAR[slug]})"></i>${NAMES[slug]}</div><div class="grid" role="img" aria-label="Ocupació mitjana per dia i hora, ${NAMES[slug]}">`;
    g += `<span></span>${HOURS.map((h) => `<span class="cl">${h % 3 === 0 ? h : ""}</span>`).join("")}`;
    DOW.forEach((dn, d) => {
      g += `<span class="rl">${dn}</span>`;
      for (const h of HOURS) {
        const c = cells.get(`${slug}|${d}|${h}`);
        g += c
          ? `<span class="cell" style="background:${seq(c.avg_occupancy_pct / 100)}" data-slug="${slug}" data-d="${d}" data-h="${h}" data-v="${c.avg_occupancy_pct}" data-n="${c.n}"></span>`
          : `<span class="cell is-empty" data-slug="${slug}" data-d="${d}" data-h="${h}"></span>`;
      }
    });
    return `${g}</div></div>`;
  }).join("");
  $("#heat-table").innerHTML = ORDER.map((slug) =>
    `<h3>${NAMES[slug]}</h3>${tableHtml(["dia", ...HOURS.map((h) => `${h}h`)], DOW_LONG.map((dn, d) => [dn, ...HOURS.map((h) => { const c = cells.get(`${slug}|${d}|${h}`); return c ? pct1(c.avg_occupancy_pct) : "–"; })]))}`,
  ).join("");
}

async function loadHeat(weeks: Weeks): Promise<void> {
  const req = ++heatReq;
  const data = await getJson<HeatmapResponse>(`/api/heatmap?weeks=${weeks}`);
  if (req === heatReq) renderHeat(data);
}

function bindHeatTooltip(): void {
  const heat = $("#heatmaps");
  heat.addEventListener("mousemove", (ev) => {
    const c = (ev.target as Element | null)?.closest<HTMLElement>(".cell");
    if (!c) { hideTip(); return; }
    const slug = c.dataset.slug as Slug, d = Number(c.dataset.d), h = Number(c.dataset.h), v = c.dataset.v;
    const body = v ? tipRow("ocupació mitjana", `${pct1(Number(v))} %`) + tipRow("lectures", c.dataset.n ?? "") : "Sense dades";
    showTip(`<b>${NAMES[slug]} · ${DOW_LONG[d]} ${pad2(h)}:00–${pad2(h + 1)}:00</b>${body}`, ev.clientX, ev.clientY);
  });
  heat.addEventListener("mouseleave", hideTip);
}

// ----- descàrregues ----------------------------------------------------------
async function loadDownloads(): Promise<void> {
  const days = await getJson<DayCount[]>("/api/days");
  const today = localToday();
  $<HTMLAnchorElement>("#api-today").href = `/api/day/${today}`;
  // El CSV d'un mes el munta la còpia de cada matinada a partir dels dies tancats: el del mes en
  // curs arriba fins a ahir, i no existeix fins que el mes no en té cap.
  const thisMonth = today.slice(0, 7);
  const months = [...new Set(days.filter((d) => d.day < today).map((d) => d.day.slice(0, 7)))];
  const items = [`<li><a href="/data/${today}.csv" download><code>${today}.csv</code></a> avui (s'actualitza cada minut)</li>`];
  for (const mth of months) items.push(`<li><a href="/data/${mth}.csv" download><code>${mth}.csv</code></a> ${mth === thisMonth ? "mes en curs, fins a ahir" : "mes sencer"}</li>`);
  for (const d of days.filter((d) => d.day !== today).slice(0, 7)) items.push(`<li><a href="/data/${d.day}.csv" download><code>${d.day}.csv</code></a> ${d.rows.toLocaleString("ca")} files</li>`);
  if (days.length > 8) items.push(`<li class="hint">…i ${days.length - 8} dies més; vegeu <a href="/api/days"><code>/api/days</code></a>.</li>`);
  $("#downloads").innerHTML = items.join("");
}

// ----- init ------------------------------------------------------------------
let range = chips<Range>("range", ["today", "7", "30"], "today", (v) => { range = v; loadRange(v).catch(logErr); });
const weeks = chips<Weeks>("weeks", ["4", "8", "26"], "8", (v) => { loadHeat(v).catch(logErr); });

onThemeChange(() => {
  if (lastLatest) renderKpi(lastLatest);
  if (lastHeat) renderHeat(lastHeat);
});

renderLegend();
bindHeatTooltip();
void refreshLatest();
loadRange(range).catch(logErr);
loadHeat(weeks).catch(logErr);
loadDownloads().catch(logErr);
window.setInterval(() => {
  void refreshLatest();
  if (range === "today") loadRange("today").catch(logErr);
}, 60_000);
