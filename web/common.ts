/* Peces comunes de les dues pàgines: constants, formats, tooltip, colors, filtres i estat. */
import type { Slug } from "./api";
import { zonedMidnight as zonedMidnightIn } from "./series";

export const TZ = "Europe/Madrid";
export const ORDER: readonly Slug[] = ["placa-vella", "ajuntament-mercat", "dr-robert"];
export const NAMES: Record<Slug, string> = { "placa-vella": "Plaça Vella", "ajuntament-mercat": "Ajuntament-Mercat", "dr-robert": "Dr. Robert" };
/** Variable CSS del color de cada pàrquing. */
export const COLOR_VAR: Record<Slug, string> = { "placa-vella": "--series-1", "ajuntament-mercat": "--series-2", "dr-robert": "--series-3" };
/** Pàrquings a tocar del Portal de Sant Roc */
export const SANT_ROC: readonly Slug[] = ["ajuntament-mercat", "placa-vella"];

export function $<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`No s'ha trobat ${sel}`);
  return el;
}

export const logErr = (e: unknown): void => console.error(e);

// ----- formats ---------------------------------------------------------------
export const fmtTime = new Intl.DateTimeFormat("ca", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
export const fmtDayTime = new Intl.DateTimeFormat("ca", { timeZone: TZ, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
export const fmtDay = new Intl.DateTimeFormat("ca", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" });
export const fmtShortDay = new Intl.DateTimeFormat("ca", { timeZone: TZ, day: "numeric", month: "short" });
export const fmtDate = new Intl.DateTimeFormat("ca", { timeZone: TZ, day: "numeric", month: "long", year: "numeric" });
/** Format d'un instant en segons Unix (l'eix x dels gràfics). */
export const atSec = (f: Intl.DateTimeFormat, s: number): string => f.format(new Date(s * 1000));

export const localToday = (): string => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
export const pct1 = (v: number): string => (Math.round(v * 10) / 10).toLocaleString("ca", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
export const pad2 = (n: number): string => String(n).padStart(2, "0");
export const esc = (s: unknown): string => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

export { addDays } from "./series";
/** Segons Unix de les 00:00 a Terrassa d'un dia AAAA-MM-DD. */
export const zonedMidnight = (day: string): number => zonedMidnightIn(day, TZ);

// ----- tooltip ---------------------------------------------------------------
let tipEl: HTMLElement | null = null;
export function showTip(html: string, x: number, y: number): void {
  if (!tipEl) {
    tipEl = document.createElement("div");
    tipEl.className = "tip";
    tipEl.setAttribute("role", "tooltip");
    document.body.append(tipEl);
  }
  const tip = tipEl;
  tip.innerHTML = html;
  tip.hidden = false;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  let left = x + 14, top = y + 14;
  if (left + w > window.innerWidth - 8) left = x - w - 14;
  if (top + h > window.innerHeight - 8) top = y - h - 14;
  tip.style.left = `${Math.max(8, left)}px`;
  tip.style.top = `${Math.max(8, top)}px`;
}
export const hideTip = (): void => { if (tipEl) tipEl.hidden = true; };

export const tipRow = (label: string, value: string, color?: string): string =>
  `<div class="row"><span>${color ? `<i style="background:${color}"></i>` : ""}${esc(label)}</span><span>${esc(value)}</span></div>`;

// ----- tema i colors ---------------------------------------------------------
const themeParam = new URLSearchParams(location.search).get("theme");
if (themeParam === "light" || themeParam === "dark") document.documentElement.dataset.theme = themeParam;

export const cssVar = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function hexToRgb(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function mix(a: string, b: string, t: number): string {
  const A = hexToRgb(a), B = hexToRgb(b);
  return `rgb(${A.map((v, i) => Math.round(v + ((B[i] ?? v) - v) * t)).join(",")})`;
}
export function alpha(hex: string, a: number): string {
  return `rgba(${hexToRgb(hex).join(",")},${a})`;
}

let seqLo = "#cde2fb", seqHi = "#0d366b";
function refreshRamp(): void { seqLo = cssVar("--seq-lo") || seqLo; seqHi = cssVar("--seq-hi") || seqHi; }
refreshRamp();
/** Escala seqüencial clar→fosc per a valors entre 0 i 1. */
export const seq = (t: number): string => mix(seqLo, seqHi, Math.max(0, Math.min(1, t)));

const themeListeners: (() => void)[] = [];
/** Crida `cb` quan el sistema canvia de tema clar/fosc (els canvas s'han de redibuixar). */
export function onThemeChange(cb: () => void): void { themeListeners.push(cb); }
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  refreshRamp();
  for (const cb of themeListeners) cb();
});

// ----- filtres ---------------------------------------------------------------
/**
 * Grup de botons `data-<param>="valor"`. Llegeix el valor inicial de l'URL
 * (`?<param>=valor`), el manté a l'URL en canviar, i avisa `onChange`.
 */
export function chips<T extends string>(param: string, allowed: readonly T[], fallback: T, onChange: (v: T) => void): T {
  const fromUrl = new URLSearchParams(location.search).get(param);
  let value = allowed.find((a) => a === fromUrl) ?? fallback;
  const buttons = [...document.querySelectorAll<HTMLButtonElement>(`[data-${param}]`)];
  const sync = (): void => {
    for (const b of buttons) {
      const on = b.dataset[param] === value;
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-pressed", String(on));
    }
  };
  for (const b of buttons) {
    b.addEventListener("click", () => {
      const v = allowed.find((a) => a === b.dataset[param]);
      if (v === undefined || v === value) return;
      value = v;
      sync();
      const url = new URL(location.href);
      if (v === fallback) url.searchParams.delete(param); else url.searchParams.set(param, v);
      history.replaceState(null, "", url);
      onChange(v);
    });
  }
  sync();
  return value;
}

// ----- estat de la captura ---------------------------------------------------
/** Pinta l'indicador «en viu» a partir de l'instant (ms) de l'última lectura, o 0 si no n'hi ha. */
export function renderStatus(lastMs: number): void {
  const st = $("#status"), text = $("#status-text");
  st.classList.remove("is-live", "is-stale");
  if (!lastMs) { text.textContent = "Encara no hi ha lectures"; return; }
  const ageMin = Math.round((Date.now() - lastMs) / 60_000);
  st.classList.add(ageMin <= 5 ? "is-live" : "is-stale");
  text.textContent = ageMin <= 1 ? "En viu · actualitzat ara mateix" : `Última lectura fa ${ageMin} min (${fmtDayTime.format(new Date(lastMs))})`;
}

// ----- taules ----------------------------------------------------------------
export function tableHtml(head: string[], rows: string[][]): string {
  const th = head.map((h, i) => `<th class="${i ? "num" : ""}">${esc(h)}</th>`).join("");
  const tr = rows.map((r) => `<tr>${r.map((c, i) => `<td class="${i ? "num" : ""}">${esc(c)}</td>`).join("")}</tr>`).join("");
  return `<table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
}
