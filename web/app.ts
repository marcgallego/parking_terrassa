/* Dashboard d'ocupació dels pàrquings Saba de Terrassa. Sense dependències. */
import { getJson } from "./api";
import type { DayCount, DaySeriesParking, DaySeriesResponse, HeatmapResponse, HourlyRecord, LatestResponse, SantRocResponse, Slug } from "./api";

const ORDER: readonly Slug[] = ["placa-vella", "ajuntament-mercat", "dr-robert"];
const NAMES: Record<Slug, string> = { "placa-vella": "Plaça Vella", "ajuntament-mercat": "Ajuntament-Mercat", "dr-robert": "Dr. Robert" };
const COLOR: Record<Slug, string> = { "placa-vella": "var(--series-1)", "ajuntament-mercat": "var(--series-2)", "dr-robert": "var(--series-3)" };
const DOW = ["dl", "dt", "dc", "dj", "dv", "ds", "dg"] as const;
const DOW_LONG = ["dilluns", "dimarts", "dimecres", "dijous", "divendres", "dissabte", "diumenge"] as const;
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const TZ = "Europe/Madrid";

type Range = "today" | "7" | "30";
type Weeks = 4 | 8 | 26;
type SrDays = 30 | 90 | 365;
type SrThreshold = 10 | 25 | 50;
/** Pàrquings a tocar del Portal de Sant Roc */
const SANT_ROC: readonly Slug[] = ["ajuntament-mercat", "placa-vella"];

function $<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`No s'ha trobat ${sel}`);
  return el;
}
const tip = $("#tip");

const fmtTime = new Intl.DateTimeFormat("ca", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
const fmtDayTime = new Intl.DateTimeFormat("ca", { timeZone: TZ, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const fmtDay = new Intl.DateTimeFormat("ca", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" });
const fmtDate = new Intl.DateTimeFormat("ca", { timeZone: TZ, day: "numeric", month: "long", year: "numeric" });
const localToday = (): string => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const pct1 = (v: number): string => (Math.round(v * 10) / 10).toLocaleString("ca", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const pad2 = (n: number): string => String(n).padStart(2, "0");
const esc = (s: unknown): string => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

// ----- tooltip ---------------------------------------------------------------
function showTip(html: string, x: number, y: number): void {
  tip.innerHTML = html;
  tip.hidden = false;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  let left = x + 14, top = y + 14;
  if (left + w > window.innerWidth - 8) left = x - w - 14;
  if (top + h > window.innerHeight - 8) top = y - h - 14;
  tip.style.left = `${Math.max(8, left)}px`;
  tip.style.top = `${Math.max(8, top)}px`;
}
const hideTip = (): void => { tip.hidden = true; };

// ----- color helpers ---------------------------------------------------------
const cssVar = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
function hexToRgb(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mix(a: string, b: string, t: number): string {
  const A = hexToRgb(a), B = hexToRgb(b);
  return `rgb(${A.map((v, i) => Math.round(v + ((B[i] ?? v) - v) * t)).join(",")})`;
}
let seqLo = "#cde2fb", seqHi = "#0d366b";
function refreshRamp(): void { seqLo = cssVar("--seq-lo") || seqLo; seqHi = cssVar("--seq-hi") || seqHi; }
const seq = (t: number): string => mix(seqLo, seqHi, Math.max(0, Math.min(1, t)));

// ----- KPI tiles -------------------------------------------------------------
function sparkSvg(spark: [number, number][], capacity: number): string {
  if (spark.length < 2) return "";
  const w = 200, h = 36, pad = 2;
  const xs = spark.map((p) => p[0]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const pts = spark.map(([t, a]) => {
    const x = pad + ((t - x0) / Math.max(1, x1 - x0)) * (w - 2 * pad);
    const y = h - pad - ((capacity - a) / capacity) * (h - 2 * pad);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts.join(" ")}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>`;
}

function renderKpi(latest: LatestResponse): void {
  const bySlug = new Map(latest.parkings.map((p) => [p.parking_slug, p]));
  $("#kpi").innerHTML = ORDER.map((slug) => {
    const p = bySlug.get(slug);
    const head = `<div class="name"><i class="swatch" style="background:${COLOR[slug]}"></i>${NAMES[slug]}</div>`;
    if (!p) return `<article class="tile is-empty">${head}<div>Sense dades recents</div></article>`;
    const v = p.occupancy_pct;
    return `<article class="tile" aria-label="${esc(p.name)}">
      ${head}
      <div class="hero">${p.available}<small>places lliures de ${p.capacity}</small></div>
      <div class="meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${v}" aria-label="Ocupació"><i style="width:${v}%;background:${seq(0.25 + (0.75 * v) / 100)}"></i></div>
      <div class="meta"><span>${pct1(v)} % ocupat</span><span>${fmtTime.format(new Date(p.timestamp_utc))}</span></div>
      <div style="color:${COLOR[slug]}">${sparkSvg(p.spark, p.capacity)}</div>
      <div class="meta"><span>últimes 3 h</span></div>
    </article>`;
  }).join("");

  const last = latest.parkings.length ? Math.max(...latest.parkings.map((p) => Date.parse(p.timestamp_utc))) : 0;
  const st = $("#status"), text = $("#status-text");
  st.classList.remove("is-live", "is-stale");
  if (!last) { text.textContent = "Encara no hi ha lectures"; return; }
  const ageMin = Math.round((Date.now() - last) / 60_000);
  st.classList.add(ageMin <= 5 ? "is-live" : "is-stale");
  text.textContent = ageMin <= 1 ? "En viu · actualitzat ara mateix" : `Última lectura fa ${ageMin} min (${fmtDayTime.format(new Date(last))})`;
}

// ----- line chart ------------------------------------------------------------
interface Point { x: number; y: number; label?: string }
interface Series { key: string; name: string; color: string; points: Point[] }
interface RefLine { y: number; label: string }
interface LineOpts {
  xTicks: number[];
  fmtTick: (x: number) => string;
  fmtX: (x: number) => string;
  empty?: string;
  xDomain?: [number, number];
  /** màxim de l'eix Y (per defecte 100, percentatge) */
  yMax?: number;
  fmtY?: (y: number) => string;
  refLine?: RefLine;
}
const bySlug = (slug: Slug, points: Point[]): Series => ({ key: slug, name: NAMES[slug], color: COLOR[slug], points });
function niceTicks(max: number): number[] {
  const raw = max / 4, mag = 10 ** Math.floor(Math.log10(raw)), norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const ticks: number[] = [];
  for (let v = 0; v <= max + 1e-9; v += step) ticks.push(Math.round(v * 100) / 100);
  return ticks;
}

/** Funcions de redibuix per element, per tornar a dibuixar en canviar la mida de la finestra. */
const redraws = new Map<HTMLElement, () => void>();
function lineChart(el: HTMLElement, series: Series[], opts: LineOpts): void {
  const draw = (): void => drawLineChart(el, series, opts);
  redraws.set(el, draw);
  draw();
}

function drawLineChart(el: HTMLElement, series: Series[], { xTicks, fmtTick, fmtX, empty, xDomain, yMax = 100, fmtY = (y) => `${y}%`, refLine }: LineOpts): void {
  const narrow = el.clientWidth < 560;
  const W = Math.max(300, el.clientWidth || 900), H = narrow ? 240 : 320;
  const multi = series.length > 1;
  const m = { t: 12, r: multi ? (narrow ? 96 : 110) : 16, b: 28, l: 44 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const allX = series.flatMap((s) => s.points.map((p) => p.x));
  if (!allX.length) {
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}"><text class="empty" x="${W / 2}" y="${H / 2}" text-anchor="middle">${esc(empty ?? "Sense dades en aquest interval")}</text></svg>`;
    return;
  }
  const [x0, x1] = xDomain ?? [Math.min(...allX), Math.max(...allX)];
  const sx = (x: number): number => m.l + ((x - x0) / Math.max(1, x1 - x0)) * iw;
  const sy = (y: number): number => m.t + ih - (Math.min(y, yMax) / yMax) * ih;
  const yTicks = yMax === 100 ? [0, 25, 50, 75, 100] : niceTicks(yMax);

  let g = `<g class="grid">${yTicks.map((y) => `<line x1="${m.l}" x2="${m.l + iw}" y1="${sy(y)}" y2="${sy(y)}"/>`).join("")}</g>`;
  const fmtTickY = (y: number): string => (yMax === 100 ? `${y}%` : String(y));
  g += `<g class="axis">${yTicks.map((y) => `<text x="${m.l - 6}" y="${sy(y) + 4}" text-anchor="end">${fmtTickY(y)}</text>`).join("")}`;
  const tickEvery = narrow ? 2 : 1;
  xTicks.forEach((t, i) => {
    if (t >= x0 && t <= x1 && i % tickEvery === 0) g += `<text x="${sx(t)}" y="${H - 8}" text-anchor="middle">${esc(fmtTick(t))}</text>`;
  });
  g += `</g>`;
  if (refLine) g += `<g class="ref"><line x1="${m.l}" x2="${m.l + iw}" y1="${sy(refLine.y)}" y2="${sy(refLine.y)}"/><text x="${m.l + iw}" y="${sy(refLine.y) - 4}" text-anchor="end">${esc(refLine.label)}</text></g>`;
  g += `<g class="series">`;
  const ends: { s: Series; x: number; y: number }[] = [];
  for (const s of series) {
    const first = s.points[0];
    if (!first) continue;
    const d = s.points.map((p, i) => `${i ? "L" : "M"}${sx(p.x).toFixed(1)} ${sy(p.y).toFixed(1)}`).join("");
    g += `<path d="${d}" stroke="${s.color}"/>`;
    if (s.points.length === 1) g += `<circle cx="${sx(first.x)}" cy="${sy(first.y)}" r="4" fill="${s.color}"/>`;
    const lastP = s.points[s.points.length - 1] ?? first;
    ends.push({ s, x: sx(lastP.x), y: sy(lastP.y) });
  }
  g += `</g>`;
  // etiquetes directes al final de cada línia, separades si xoquen
  ends.sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) {
    const prev = ends[i - 1], cur = ends[i];
    if (prev && cur && cur.y - prev.y < 14) cur.y = prev.y + 14;
  }
  if (multi) g += `<g class="labels">${ends.map((e) => `<text class="end-label" x="${m.l + iw + 8}" y="${e.y + 4}" fill="${e.s.color}">${esc(e.s.name)}</text>`).join("")}</g>`;
  g += `<g class="hover"><line y1="${m.t}" y2="${m.t + ih}" x1="0" x2="0"/>${series.map((s) => `<circle r="5" fill="${s.color}" data-key="${esc(s.key)}"/>`).join("")}</g>`;
  g += `<rect class="capture" x="${m.l}" y="${m.t}" width="${iw}" height="${ih}" fill="transparent"/>`;
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Ocupació en percentatge">${g}</svg>`;

  const svg = $<SVGSVGElement>("svg", el);
  const hover = $<SVGGElement>(".hover", svg);
  const vline = $<SVGLineElement>("line", hover);
  const dots = [...hover.querySelectorAll<SVGCircleElement>("circle")];
  const cap = $<SVGRectElement>(".capture", svg);
  const xsSorted = [...new Set(allX)].sort((a, b) => a - b);

  function nearest(xv: number): number {
    let lo = 0, hi = xsSorted.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((xsSorted[mid] ?? 0) < xv) lo = mid + 1; else hi = mid;
    }
    const cur = xsSorted[lo] ?? 0, prev = xsSorted[lo - 1];
    return prev !== undefined && Math.abs(prev - xv) < Math.abs(cur - xv) ? prev : cur;
  }

  function onMove(clientX: number, clientY: number): void {
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const pt = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    const xv = nearest(x0 + ((pt.x - m.l) / iw) * (x1 - x0));
    const X = sx(xv);
    vline.setAttribute("x1", String(X));
    vline.setAttribute("x2", String(X));
    let html = `<b>${esc(fmtX(xv))}</b>`;
    for (const s of series) {
      const dot = dots.find((c) => c.dataset.key === s.key);
      const hit = s.points.find((q) => q.x === xv);
      if (!dot) continue;
      if (hit) {
        dot.setAttribute("cx", String(X));
        dot.setAttribute("cy", String(sy(hit.y)));
        dot.style.display = "";
        html += `<div class="row"><span><i style="background:${s.color}"></i>${esc(s.name)}</span><span>${esc(fmtY(hit.y))}${hit.label ? ` · ${esc(hit.label)}` : ""}</span></div>`;
      } else dot.style.display = "none";
    }
    hover.classList.add("is-on");
    showTip(html, clientX, clientY);
  }
  cap.addEventListener("mousemove", (e) => onMove(e.clientX, e.clientY));
  cap.addEventListener("touchmove", (e) => { const t = e.touches[0]; if (t) { onMove(t.clientX, t.clientY); e.preventDefault(); } }, { passive: false });
  cap.addEventListener("mouseleave", () => { hover.classList.remove("is-on"); hideTip(); });
}

function renderLegend(el: HTMLElement): void {
  el.innerHTML = ORDER.map((s) => `<span><i style="background:${COLOR[s]}"></i>${NAMES[s]}</span>`).join("");
}

function tableHtml(head: string[], rows: string[][]): string {
  const th = head.map((h, i) => `<th class="${i ? "num" : ""}">${esc(h)}</th>`).join("");
  const tr = rows.map((r) => `<tr>${r.map((c, i) => `<td class="${i ? "num" : ""}">${esc(c)}</td>`).join("")}</tr>`).join("");
  return `<table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
}

// ----- dades d'avui ----------------------------------------------------------
type SeriesPoint = DaySeriesParking["points"][number];
interface Loaded<T> { data: T; at: number }

/**
 * Última sèrie d'avui carregada. La comparteixen el gràfic d'ocupació i el
 * panell del Portal de Sant Roc: cada refresc fa una sola petició, i si falla,
 * tots dos es queden amb aquestes dades (i ho diuen) en lloc de buidar-se.
 */
let today: Loaded<DaySeriesResponse> | null = null;
let todayFailed = false;
let todayRequest: Promise<void> | null = null;

function refreshToday(): Promise<void> {
  todayRequest ??= (async () => {
    try {
      today = { data: await getJson<DaySeriesResponse>(`/api/day/${localToday()}/series`), at: Date.now() };
      todayFailed = false;
    } catch {
      todayFailed = true;
    }
    if (range === "today") renderRangeToday();
    renderSantRoc();
  })().finally(() => { todayRequest = null; });
  return todayRequest;
}

/** La sèrie carregada, només si és de debò d'avui: passada la mitjanit pot ser la d'ahir. */
const currentToday = (): Loaded<DaySeriesResponse> | null => (today?.data.day === localToday() ? today : null);

const occupancyPct = (capacity: number, available: number): number => Math.round((1000 * (capacity - available)) / capacity) / 10;
const hhmm = (t: number): string => `${pad2(Math.floor(t / 60))}:${pad2(t % 60)}`;

/** Minut del dia en hora local. L'hora local es consulta un cop per hora UTC: els canvis d'horari cauen en punt. */
const fmtHm = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const hourStartMinute = new Map<number, number>();
function localMinuteOfDay(ts: number): number {
  const hour = ts - (ts % 3600);
  let base = hourStartMinute.get(hour);
  if (base === undefined) {
    const [h = "0", m = "0"] = fmtHm.format(new Date(hour * 1000)).split(":");
    base = Number(h) * 60 + Number(m);
    hourStartMinute.set(hour, base);
  }
  return (base + Math.floor((ts - hour) / 60)) % 1440;
}

/** Una font de dades d'un panell: si l'última petició ha fallat, i de quan són les dades que es mostren. */
interface Source { failed: boolean; at: number | null }
function staleNotice(sources: Source[]): string | null {
  const failed = sources.filter((s) => s.failed);
  if (!failed.length) return null;
  const ats = failed.map((s) => s.at).filter((a): a is number => a !== null);
  if (ats.length < failed.length) return "No s'han pogut carregar les dades. Es tornarà a provar d'aquí a un minut.";
  return `No s'ha pogut actualitzar: es mostren les dades de les ${fmtTime.format(new Date(Math.min(...ats)))}. Es tornarà a provar d'aquí a un minut.`;
}
function setNotice(el: HTMLElement, text: string | null): void {
  el.textContent = text ?? "";
  el.hidden = text === null;
}

function renderRangeToday(): void {
  const el = $("#line-chart"), tbl = $("#line-table");
  const cur = currentToday();
  const parkings = cur?.data.parkings ?? [];
  const pointsOf = new Map(parkings.map((p) => [p.parking_slug, p.points]));
  const series = ORDER.map((slug) => bySlug(slug, (pointsOf.get(slug) ?? []).map(([ts, available, capacity]) => ({ x: localMinuteOfDay(ts), y: occupancyPct(capacity, available), label: `${available} lliures` }))));
  lineChart(el, series, {
    fmtY: (y) => `${pct1(y)} %`,
    xDomain: [0, 1440],
    xTicks: [0, 180, 360, 540, 720, 900, 1080, 1260, 1440],
    fmtTick: (t) => `${pad2(Math.floor(t / 60))}:00`,
    fmtX: (t) => `${fmtDate.format(new Date())} · ${hhmm(t)}`,
    empty: "Encara no hi ha lectures d'avui",
  });
  const byMin = new Map<number, Partial<Record<Slug, SeriesPoint>>>();
  for (const p of parkings) {
    for (const pt of p.points) {
      const k = localMinuteOfDay(pt[0]);
      const e = byMin.get(k) ?? {};
      e[p.parking_slug] = pt;
      byMin.set(k, e);
    }
  }
  const keys = [...byMin.keys()].sort((a, b) => a - b);
  const step = Math.max(1, Math.floor(keys.length / 96)); // màxim ~96 files (cada 15 min)
  tbl.innerHTML = tableHtml(
    ["hora", ...ORDER.map((s) => `${NAMES[s]} (% / lliures)`)],
    keys.filter((_, i) => i % step === 0).map((k) => [hhmm(k), ...ORDER.map((s) => { const pt = byMin.get(k)?.[s]; return pt ? `${pct1(occupancyPct(pt[2], pt[1]))} % / ${pt[1]}` : "–"; })]),
  );
  setNotice($("#line-notice"), staleNotice([{ failed: todayFailed, at: cur?.at ?? null }]));
}

async function loadRange(r: Range): Promise<void> {
  const el = $("#line-chart"), tbl = $("#line-table");
  if (r === "today") {
    // Les dades d'avui es refresquen soles cada minut; aquí només cal dibuixar-les.
    if (today) renderRangeToday(); else await refreshToday();
  } else {
    const days = Number(r);
    setNotice($("#line-notice"), null);
    let rows: HourlyRecord[];
    try {
      rows = await getJson<HourlyRecord[]>(`/api/hourly?days=${days}`);
    } catch {
      if (range !== r) return;
      lineChart(el, [], { xTicks: [], fmtTick: String, fmtX: String, empty: "No s'han pogut carregar les dades d'aquest interval. Torneu-ho a provar d'aquí a una estona." });
      tbl.innerHTML = "";
      return;
    }
    // Mentre arribava la resposta, l'usuari pot haver triat un altre interval.
    if (range !== r) return;
    const series = ORDER.map((slug) => bySlug(slug, rows.filter((r) => r.parking_slug === slug).map((r) => ({ x: Date.parse(r.hour_utc), y: r.avg_occupancy_pct, label: `mitjana ${Math.round(r.avg_available)} lliures` }))));
    const now = Date.now(), stepDays = days > 10 ? 5 : 1, ticks: number[] = [];
    for (let i = days; i >= 0; i -= stepDays) ticks.push(Date.parse(`${new Date(now - i * 86_400_000).toISOString().slice(0, 10)}T00:00:00Z`));
    lineChart(el, series, { fmtY: (y) => `${pct1(y)} %`, xTicks: ticks, fmtTick: (t) => fmtDay.format(new Date(t)), fmtX: (t) => `${fmtDayTime.format(new Date(t))} (mitjana horària)` });
    const byHour = new Map<string, Partial<Record<Slug, HourlyRecord>>>();
    for (const r of rows) {
      const e = byHour.get(r.hour_utc) ?? {};
      e[r.parking_slug] = r;
      byHour.set(r.hour_utc, e);
    }
    const keys = [...byHour.keys()].sort();
    tbl.innerHTML = tableHtml(
      ["hora (local)", ...ORDER.map((s) => `${NAMES[s]} (% mitjà)`)],
      keys.map((k) => [fmtDayTime.format(new Date(k)), ...ORDER.map((s) => { const r = byHour.get(k)?.[s]; return r ? pct1(r.avg_occupancy_pct) : "–"; })]),
    );
  }
}

// ----- bar chart -------------------------------------------------------------
interface Bar { x: string; value: number; below: boolean; tooltip: string }
function barChart(el: HTMLElement, bars: Bar[], opts: { yMax: number; refLine?: RefLine; fmtLabel: (x: string, i: number) => string }): void {
  const draw = (): void => drawBarChart(el, bars, opts);
  redraws.set(el, draw);
  draw();
}
function drawBarChart(el: HTMLElement, bars: Bar[], { yMax, refLine, fmtLabel }: { yMax: number; refLine?: RefLine; fmtLabel: (x: string, i: number) => string }): void {
  const W = Math.max(300, el.clientWidth || 900), H = 220, m = { t: 12, r: 16, b: 28, l: 44 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  if (!bars.length) { el.innerHTML = `<svg viewBox="0 0 ${W} ${H}"><text class="empty" x="${W / 2}" y="${H / 2}" text-anchor="middle">Encara no hi ha dies complets</text></svg>`; return; }
  const sy = (y: number): number => m.t + ih - (Math.min(y, yMax) / yMax) * ih;
  const slot = iw / bars.length, gap = Math.min(2, slot * 0.2), bw = Math.max(1, slot - gap);
  const yTicks = niceTicks(yMax);
  let g = `<g class="grid">${yTicks.map((y) => `<line x1="${m.l}" x2="${m.l + iw}" y1="${sy(y)}" y2="${sy(y)}"/>`).join("")}</g>`;
  g += `<g class="axis">${yTicks.map((y) => `<text x="${m.l - 6}" y="${sy(y) + 4}" text-anchor="end">${y}</text>`).join("")}`;
  const every = Math.max(1, Math.ceil(bars.length / (W < 560 ? 4 : 8)));
  bars.forEach((b, i) => { if (i % every === 0) g += `<text x="${m.l + slot * i + bw / 2}" y="${H - 8}" text-anchor="middle">${esc(fmtLabel(b.x, i))}</text>`; });
  g += `</g>`;
  if (refLine) g += `<g class="ref"><line x1="${m.l}" x2="${m.l + iw}" y1="${sy(refLine.y)}" y2="${sy(refLine.y)}"/><text x="${m.l + iw}" y="${sy(refLine.y) - 4}" text-anchor="end">${esc(refLine.label)}</text></g>`;
  g += `<g class="bars">${bars.map((b, i) => `<rect class="${b.below ? "is-below" : ""}" x="${(m.l + slot * i).toFixed(1)}" y="${sy(b.value).toFixed(1)}" width="${bw.toFixed(1)}" height="${(m.t + ih - sy(b.value)).toFixed(1)}" fill="var(--series-1)" data-i="${i}"/>`).join("")}</g>`;
  g += `<g class="hit">${bars.map((_, i) => `<rect x="${(m.l + slot * i).toFixed(1)}" y="${m.t}" width="${slot.toFixed(1)}" height="${ih}" fill="transparent" data-i="${i}"/>`).join("")}</g>`;
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Mínim diari de places lliures">${g}</svg>`;
  const svg = $<SVGSVGElement>("svg", el);
  svg.addEventListener("mousemove", (ev) => {
    const r = (ev.target as Element | null)?.closest<SVGRectElement>("rect[data-i]");
    const b = r ? bars[Number(r.dataset.i)] : undefined;
    if (b) showTip(b.tooltip, ev.clientX, ev.clientY); else hideTip();
  });
  svg.addEventListener("mouseleave", hideTip);
}

// ----- panell Portal de Sant Roc ---------------------------------------------
function statHtml(value: string, unit: string, label: string, sub = "", bad = false): string {
  return `<div class="stat${bad ? " is-bad" : ""}"><div class="v">${value}${unit ? `<small>${esc(unit)}</small>` : ""}</div><div class="l">${esc(label)}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ""}</div>`;
}

/** Últim resum del període carregat, amb els filtres amb què es va demanar. */
let sr: (Loaded<SantRocResponse> & { key: string }) | null = null;
let srFailed = false;
const srKey = (): string => `${srDays}|${srThreshold}`;

async function refreshSantRoc(): Promise<void> {
  const key = srKey();
  try {
    const data = await getJson<SantRocResponse>(`/api/santroc?days=${srDays}&threshold=${srThreshold}`);
    if (key !== srKey()) return; // mentrestant s'ha canviat el filtre, i ja n'hi ha una altra petició en camí
    sr = { data, at: Date.now(), key };
    srFailed = false;
  } catch {
    if (key !== srKey()) return;
    srFailed = true;
  }
  renderSantRoc();
}

/**
 * Dibuixa el panell amb les últimes dades bones de cada font. Avui i el resum
 * del període es carreguen per separat: si un falla, l'altre es continua
 * mostrant i posant al dia.
 */
function renderSantRoc(): void {
  const threshold = srThreshold;
  const cur = currentToday();
  const period = sr?.key === srKey() ? sr : null;
  const names = SANT_ROC.map((s) => NAMES[s]).join(" + ");
  setNotice($("#sr-notice"), staleNotice([
    { failed: todayFailed, at: cur?.at ?? null },
    { failed: srFailed, at: period?.at ?? null },
  ]));

  // Avui, minut a minut: suma de lliures quan hi ha lectura dels dos pàrquings
  const byMinute = new Map<number, Partial<Record<Slug, SeriesPoint>>>();
  for (const p of cur?.data.parkings ?? []) {
    if (!SANT_ROC.includes(p.parking_slug)) continue;
    for (const pt of p.points) {
      const k = localMinuteOfDay(pt[0]);
      const e = byMinute.get(k) ?? {};
      e[p.parking_slug] = pt;
      byMinute.set(k, e);
    }
  }
  const points: Point[] = [];
  // Capacitat de l'última lectura d'avui; si encara no n'hi ha, la de la fitxa.
  let capacity = period?.data.capacity ?? 0;
  for (const [k, e] of [...byMinute.entries()].sort((a, b) => a[0] - b[0])) {
    const parts = SANT_ROC.map((s) => e[s]);
    if (parts.every((p): p is SeriesPoint => p !== undefined)) {
      points.push({ x: k, y: parts.reduce((a, p) => a + p[1], 0), label: SANT_ROC.map((s) => `${NAMES[s]} ${e[s]?.[1]}`).join(", ") });
      capacity = parts.reduce((a, p) => a + p[2], 0);
    }
  }
  lineChart($("#sr-today"), [{ key: "sr", name: "places lliures", color: "var(--series-1)", points }], {
    yMax: capacity || 500,
    fmtY: (y) => `${Math.round(y)} lliures`,
    refLine: { y: threshold, label: `llindar: ${threshold} lliures` },
    xDomain: [0, 1440],
    xTicks: [0, 180, 360, 540, 720, 900, 1080, 1260, 1440],
    fmtTick: (t) => `${pad2(Math.floor(t / 60))}:00`,
    fmtX: (t) => `avui ${pad2(Math.floor(t / 60))}:${pad2(t % 60)}`,
    empty: "Encara no hi ha lectures d'avui",
  });

  // Estadístiques
  const now = points[points.length - 1];
  const todayMin = points.reduce<Point | null>((acc, p) => (acc === null || p.y < acc.y ? p : acc), null);
  const todayStats = [
    now ? statHtml(String(now.y), `de ${capacity}`, "places lliures ara mateix", names, now.y < threshold) : statHtml("–", "", "places lliures ara mateix", "sense lectura d'avui"),
    todayMin ? statHtml(String(todayMin.y), "", "mínim d'avui", `a les ${hhmm(todayMin.x)}`, todayMin.y < threshold) : statHtml("–", "", "mínim d'avui"),
  ];
  if (!period) {
    // Encara no hi ha el resum d'aquests filtres, o no s'ha pogut carregar: només es posa al dia el que depèn d'avui.
    $("#sr-stats").innerHTML = [...todayStats, statHtml("–", "", `dies amb menys de ${threshold} lliures`), statHtml("–", "%", "del temps sota el llindar"), statHtml("–", "", "mínim del període")].join("");
    if (srFailed) {
      // Res del període anterior: correspon a uns altres filtres.
      const daily = $("#sr-daily");
      redraws.delete(daily);
      daily.innerHTML = "";
      $("#sr-daily-hint").textContent = "";
      $("#sr-table").innerHTML = "";
    }
    return;
  }
  // El període només compta dies complets; el dia d'avui té les seves pròpies estadístiques.
  const completeDays = period.data.days.filter((d) => d.day !== localToday());
  const totalMinutes = completeDays.reduce((a, d) => a + d.minutes, 0);
  const belowMinutes = completeDays.reduce((a, d) => a + d.minutes_below, 0);
  const daysBelow = completeDays.filter((d) => d.minutes_below > 0).length;
  const worst = completeDays.reduce<SantRocResponse["days"][number] | null>((acc, d) => (acc === null || d.min_free < acc.min_free ? d : acc), null);
  $("#sr-stats").innerHTML = [
    ...todayStats,
    statHtml(String(daysBelow), `de ${completeDays.length} dies`, `dies amb menys de ${threshold} lliures`, completeDays.length ? `${pct1((100 * daysBelow) / completeDays.length)} % dels dies complets` : "encara cap dia complet", daysBelow > 0),
    statHtml(totalMinutes ? pct1((100 * belowMinutes) / totalMinutes) : "–", "%", "del temps sota el llindar", totalMinutes ? `${belowMinutes.toLocaleString("ca")} de ${totalMinutes.toLocaleString("ca")} minuts` : "", belowMinutes > 0),
    worst ? statHtml(String(worst.min_free), "lliures", "mínim del període", `${fmtDay.format(new Date(worst.min_at_utc))} a les ${fmtTime.format(new Date(worst.min_at_utc))}`, worst.min_free < threshold) : statHtml("–", "", "mínim del període"),
  ].join("");

  // Mínim diari
  const yMax = Math.max(threshold * 2, ...completeDays.map((d) => d.min_free)) * 1.1;
  $("#sr-daily-hint").textContent = `Cada barra és el moment del dia amb menys places lliures sumant ${names}. En vermell, els dies que han baixat de ${threshold}. ${completeDays.length} dies complets analitzats.`;
  barChart($("#sr-daily"), completeDays.map((d) => ({
    x: d.day,
    value: d.min_free,
    below: d.min_free < threshold,
    tooltip: `<b>${fmtDay.format(new Date(`${d.day}T12:00:00Z`))}</b><div class="row"><span>mínim</span><span>${d.min_free} lliures a les ${fmtTime.format(new Date(d.min_at_utc))}</span></div><div class="row"><span>sota ${threshold}</span><span>${d.minutes_below} min</span></div><div class="row"><span>lectures</span><span>${d.minutes} min</span></div>`,
  })), { yMax, refLine: { y: threshold, label: `llindar: ${threshold}` }, fmtLabel: (x) => fmtDay.format(new Date(`${x}T12:00:00Z`)) });

  $("#sr-table").innerHTML = tableHtml(
    ["dia", "mínim lliures", "hora del mínim", `minuts amb < ${threshold}`, "minuts amb lectura"],
    completeDays.map((d) => [d.day, String(d.min_free), fmtTime.format(new Date(d.min_at_utc)), String(d.minutes_below), String(d.minutes)]),
  );
}

// ----- heatmaps --------------------------------------------------------------
let heatBound = false;
async function loadHeat(weeks: Weeks): Promise<void> {
  const data = await getJson<HeatmapResponse>(`/api/heatmap?weeks=${weeks}`);
  const cells = new Map(data.cells.map((c) => [`${c.parking_slug}|${c.dow}|${c.hour}`, c]));
  const heat = $("#heatmaps");
  heat.innerHTML = ORDER.map((slug) => {
    let g = `<div class="heat"><div class="hname"><i class="swatch" style="background:${COLOR[slug]}"></i>${NAMES[slug]}</div><div class="grid" role="img" aria-label="Ocupació mitjana per dia i hora, ${NAMES[slug]}">`;
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

  if (!heatBound) {
    heatBound = true;
    heat.addEventListener("mousemove", (ev) => {
      const c = (ev.target as Element | null)?.closest<HTMLElement>(".cell");
      if (!c) { hideTip(); return; }
      const slug = c.dataset.slug as Slug, d = Number(c.dataset.d), h = Number(c.dataset.h), v = c.dataset.v;
      const body = v
        ? `<div class="row"><span>ocupació mitjana</span><span>${pct1(Number(v))} %</span></div><div class="row"><span>lectures</span><span>${c.dataset.n}</span></div>`
        : "Sense dades";
      showTip(`<b>${NAMES[slug]} · ${DOW_LONG[d]} ${pad2(h)}:00–${pad2(h + 1)}:00</b>${body}`, ev.clientX, ev.clientY);
    });
    heat.addEventListener("mouseleave", hideTip);
  }
  $("#heat-table").innerHTML = ORDER.map((slug) =>
    `<h3>${NAMES[slug]}</h3>${tableHtml(["dia", ...HOURS.map((h) => `${h}h`)], DOW_LONG.map((dn, d) => [dn, ...HOURS.map((h) => { const c = cells.get(`${slug}|${d}|${h}`); return c ? pct1(c.avg_occupancy_pct) : "–"; })]))}`,
  ).join("");
}

// ----- downloads -------------------------------------------------------------
async function loadDownloads(): Promise<void> {
  const days = await getJson<DayCount[]>("/api/days");
  const today = localToday();
  $<HTMLAnchorElement>("#api-today").href = `/api/day/${today}`;
  const months = [...new Set(days.map((d) => d.day.slice(0, 7)))];
  const items = [`<li><a href="/data/${today}.csv" download><code>${today}.csv</code></a> avui (s'actualitza cada minut)</li>`];
  for (const mth of months) items.push(`<li><a href="/data/${mth}.csv" download><code>${mth}.csv</code></a> mes sencer</li>`);
  for (const d of days.filter((d) => d.day !== today).slice(0, 7)) items.push(`<li><a href="/data/${d.day}.csv" download><code>${d.day}.csv</code></a> ${d.rows.toLocaleString("ca")} files</li>`);
  if (days.length > 8) items.push(`<li class="hint">…i ${days.length - 8} dies més; vegeu <a href="/api/days"><code>/api/days</code></a>.</li>`);
  $("#downloads").innerHTML = items.join("");
}

// ----- init ------------------------------------------------------------------
const qs = new URLSearchParams(location.search);
const isRange = (v: string | null): v is Range => v === "today" || v === "7" || v === "30";
const isWeeks = (v: number): v is Weeks => v === 4 || v === 8 || v === 26;
const themeParam = qs.get("theme");
if (themeParam === "light" || themeParam === "dark") document.documentElement.dataset.theme = themeParam;

const isSrDays = (v: number): v is SrDays => v === 30 || v === 90 || v === 365;
const isSrThreshold = (v: number): v is SrThreshold => v === 10 || v === 25 || v === 50;
let srDays: SrDays = isSrDays(Number(qs.get("srdays"))) ? (Number(qs.get("srdays")) as SrDays) : 30;
let srThreshold: SrThreshold = isSrThreshold(Number(qs.get("threshold"))) ? (Number(qs.get("threshold")) as SrThreshold) : 25;
let range: Range = isRange(qs.get("range")) ? (qs.get("range") as Range) : "today";
let weeks: Weeks = isWeeks(Number(qs.get("weeks"))) ? (Number(qs.get("weeks")) as Weeks) : 8;

const rangeButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-range]")];
const weekButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-weeks]")];
const srDayButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-sr-days]")];
const srThresholdButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-sr-threshold]")];
const syncChips = (): void => {
  rangeButtons.forEach((b) => b.classList.toggle("is-on", b.dataset.range === range));
  weekButtons.forEach((b) => b.classList.toggle("is-on", Number(b.dataset.weeks) === weeks));
  srDayButtons.forEach((b) => b.classList.toggle("is-on", Number(b.dataset.srDays) === srDays));
  srThresholdButtons.forEach((b) => b.classList.toggle("is-on", Number(b.dataset.srThreshold) === srThreshold));
};
const logErr = (e: unknown): void => console.error(e);

for (const b of rangeButtons) b.addEventListener("click", () => { if (isRange(b.dataset.range ?? null)) { range = b.dataset.range as Range; syncChips(); loadRange(range).catch(logErr); } });
for (const b of weekButtons) b.addEventListener("click", () => { const w = Number(b.dataset.weeks); if (isWeeks(w)) { weeks = w; syncChips(); loadHeat(weeks).catch(logErr); } });
/** En canviar els filtres, el resum anterior ja no val i el seu error tampoc. */
function changeSantRocFilters(): void {
  srFailed = false;
  syncChips();
  void refreshSantRoc();
}
for (const b of srDayButtons) b.addEventListener("click", () => { const v = Number(b.dataset.srDays); if (isSrDays(v)) { srDays = v; changeSantRocFilters(); } });
for (const b of srThresholdButtons) b.addEventListener("click", () => { const v = Number(b.dataset.srThreshold); if (isSrThreshold(v)) { srThreshold = v; changeSantRocFilters(); } });

async function refreshLatest(): Promise<void> {
  try { renderKpi(await getJson<LatestResponse>("/api/latest")); } catch (e) { $("#status-text").textContent = "No s'ha pogut carregar l'estat"; logErr(e); }
}

let resizeTimer: number | undefined;
window.addEventListener("resize", () => { window.clearTimeout(resizeTimer); resizeTimer = window.setTimeout(() => { for (const draw of redraws.values()) draw(); }, 150); });
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { refreshRamp(); loadHeat(weeks).catch(logErr); void refreshLatest(); });

refreshRamp();
syncChips();
renderLegend($("#line-legend"));
void refreshLatest();
// Avui es demana un sol cop i n'hi ha prou per al gràfic d'ocupació i per al panell del Portal de Sant Roc.
void refreshToday();
void refreshSantRoc();
if (range !== "today") loadRange(range).catch(logErr);
loadHeat(weeks).catch(logErr);
loadDownloads().catch(logErr);
// Els errors dels refrescos no es propaguen: cada panell es queda amb les últimes dades bones i ho indica.
window.setInterval(() => {
  void refreshLatest();
  void refreshToday();
  void refreshSantRoc();
}, 60_000);
