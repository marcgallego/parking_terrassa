/*
 * Gràfics amb uPlot (canvas).
 *
 * Cada gràfic es munta sobre un element amb `mount(host, spec)`. El mòdul se
 * n'encarrega de la resta: l'amplada segueix el contenidor, els colors es
 * llegeixen de les variables CSS i es tornen a llegir si canvia el tema, i
 * muntar de nou sobre el mateix element substitueix el gràfic anterior.
 */
import uPlot from "uplot";
import { TZ, alpha, atSec, cssVar, fmtShortDay, fmtTime, hideTip, onThemeChange, showTip } from "./common";

const FONT = `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;

export interface ChartSpec {
  data: uPlot.AlignedData;
  /** alçada en funció de l'amplada disponible */
  height: (width: number) => number;
  /** opcions de uPlot; es crida cada vegada que es dibuixa, i per tant pot llegir variables CSS */
  options: () => Omit<uPlot.Options, "width" | "height">;
  /** text quan no hi ha cap punt */
  empty?: string;
}

interface Mounted { spec: ChartSpec; u: uPlot | null; width: number; ro: ResizeObserver }
const mounted = new Map<HTMLElement, Mounted>();

function draw(host: HTMLElement, m: Mounted): void {
  m.u?.destroy();
  m.u = null;
  host.replaceChildren();
  const width = Math.max(120, host.clientWidth);
  const height = m.spec.height(width);
  m.width = width;
  if (!m.spec.data[0]?.length) {
    const p = document.createElement("p");
    p.className = "chart-empty";
    p.style.height = `${height}px`;
    p.textContent = m.spec.empty ?? "Sense dades en aquest interval";
    host.append(p);
    return;
  }
  const opts: uPlot.Options = { ...m.spec.options(), width, height };
  // Amb un sol punt, uPlot allarga l'escala de temps 86.400/ms segons: anys, amb segons Unix.
  // Si el gràfic no fixa el rang, en fem un d'un dia al voltant del punt.
  const [x0] = m.spec.data[0];
  const xScale = opts.scales?.x;
  if (m.spec.data[0].length === 1 && x0 !== undefined && xScale?.time !== false && !xScale?.range) {
    opts.scales = { ...opts.scales, x: { ...xScale, range: [x0 - 12 * 3600, x0 + 12 * 3600] } };
  }
  m.u = new uPlot(opts, m.spec.data, host);
}

export function mount(host: HTMLElement, spec: ChartSpec): void {
  // Allibera els gràfics d'elements que ja no són al document (p. ex. rèpliques de tiles).
  for (const [h, old] of mounted) {
    if (!h.isConnected) { old.u?.destroy(); old.ro.disconnect(); mounted.delete(h); }
  }
  let m = mounted.get(host);
  if (m) m.spec = spec;
  else {
    const ro = new ResizeObserver(() => {
      const cur = mounted.get(host);
      const width = Math.max(120, host.clientWidth);
      if (!cur || width === cur.width) return;
      cur.width = width;
      if (cur.u) cur.u.setSize({ width, height: cur.spec.height(width) });
      else draw(host, cur);
    });
    m = { spec, u: null, width: 0, ro };
    mounted.set(host, m);
    ro.observe(host);
  }
  draw(host, m);
}

/** Mostra o amaga la sèrie `idx` (1 = primera sèrie de dades) sense redibuixar el gràfic. */
export function setSeriesShown(host: HTMLElement, idx: number, show: boolean): void {
  mounted.get(host)?.u?.setSeries(idx, { show });
}

onThemeChange(() => { for (const [host, m] of mounted) draw(host, m); });

export { alignSeries } from "./series";

// ----- peces d'opcions -------------------------------------------------------
/** Opcions comunes: hora de Terrassa, sense llegenda de uPlot, zoom arrossegant en horitzontal. */
export function baseOptions(): Pick<uPlot.Options, "tzDate" | "legend" | "cursor" | "padding"> {
  return {
    tzDate: (ts) => uPlot.tzDate(new Date(ts * 1000), TZ),
    legend: { show: false },
    // marge a la dreta perquè l'última etiqueta de l'eix x no quedi tallada
    padding: [12, 20, 0, 0],
    cursor: {
      y: false,
      drag: { x: true, y: false, dist: 8 },
      points: { size: 9, width: 2, stroke: cssVar("--surface-1") },
    },
  };
}

function axisBase(): uPlot.Axis {
  return {
    stroke: cssVar("--text-muted"),
    font: `11px ${FONT}`,
    grid: { stroke: cssVar("--grid"), width: 1 },
    ticks: { show: false },
    gap: 6,
  };
}

/**
 * Eix de temps. `clock` només mostra hores (un sol dia); `calendar` mostra dates
 * i, si l'interval és de menys d'un dia, les hores entremig.
 */
export function timeAxis(mode: "clock" | "calendar"): uPlot.Axis {
  return {
    ...axisBase(),
    grid: { show: false },
    space: mode === "clock" ? 48 : 72,
    values: (u, splits, _axis, _space, incr) =>
      splits.map((s, i) => {
        const hm = atSec(fmtTime, s);
        // un dia sencer acaba a les 24:00, no a les 00:00
        if (mode === "clock") return hm === "00:00" && i > 0 && i === splits.length - 1 && s >= (u.scales.x?.max ?? Infinity) ? "24:00" : hm;
        return incr < 86_400 && hm !== "00:00" ? hm : atSec(fmtShortDay, s);
      }),
  };
}

export function valueAxis(fmt: (v: number) => string, size = 46): uPlot.Axis {
  return { ...axisBase(), size, values: (_u, splits) => splits.map(fmt) };
}

export function lineSeries(label: string, color: string, extra: Partial<uPlot.Series> = {}): uPlot.Series {
  return { label, stroke: color, width: 2, points: { show: false }, ...extra };
}

export function barSeries(label: string, color: string): uPlot.Series {
  return {
    label,
    stroke: color,
    fill: color,
    width: 0,
    points: { show: false },
    paths: uPlot.paths.bars?.({ size: [0.8, 24, 1], gap: 1, radius: 0.2 }),
  };
}

/** Tooltip amb l'índex sota el cursor. `render` retorna HTML ja escapat. */
export function tooltipPlugin(render: (u: uPlot, idx: number) => string): uPlot.Plugin {
  return {
    hooks: {
      setCursor: (u) => {
        const { idx, left, top } = u.cursor;
        if (idx == null || left == null || top == null || left < 0) { hideTip(); return; }
        const html = render(u, idx);
        if (!html) { hideTip(); return; }
        const r = u.over.getBoundingClientRect();
        showTip(html, r.left + left, r.top + top);
      },
      destroy: () => hideTip(),
    },
  };
}

/**
 * Clic sobre un punt del gràfic. No compta si s'ha arrossegat (això amplia un
 * tram), de manera que conviu amb el zoom.
 */
export function clickPlugin(onPick: (idx: number) => void): uPlot.Plugin {
  return {
    hooks: {
      ready: (u) => {
        let downX = NaN;
        u.over.style.cursor = "pointer";
        u.over.addEventListener("pointerdown", (e) => { downX = e.clientX; });
        u.over.addEventListener("click", (e) => {
          // Amb downX sense valor (clic sintètic), la comparació és falsa i el clic compta.
          if (Math.abs(e.clientX - downX) > 4) return;
          onPick(u.posToIdx(e.clientX - u.over.getBoundingClientRect().left));
        });
      },
    },
  };
}

/** Línia horitzontal de referència amb etiqueta (p. ex. el llindar de places lliures). */
export function refLinePlugin(value: number, label: string, color: string): uPlot.Plugin {
  const bg = alpha(cssVar("--surface-1"), 0.85);
  return {
    hooks: {
      draw: (u) => {
        const { min, max } = u.scales.y ?? {};
        if (min === undefined || max === undefined || value < min || value > max) return;
        const pr = uPlot.pxRatio, ctx = u.ctx;
        const y = Math.round(u.valToPos(value, "y", true));
        const { left, width } = u.bbox;
        ctx.save();
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = pr;
        ctx.setLineDash([5 * pr, 4 * pr]);
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(left + width, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = `600 ${Math.round(10.5 * pr)}px ${FONT}`;
        ctx.textAlign = "right";
        ctx.textBaseline = "bottom";
        // fons sota l'etiqueta perquè es llegeixi damunt de barres i línies
        const tx = left + width - 4 * pr, ty = y - 4 * pr, tw = ctx.measureText(label).width;
        ctx.fillStyle = bg;
        ctx.fillRect(tx - tw - 3 * pr, ty - 13 * pr, tw + 6 * pr, 14 * pr);
        ctx.fillStyle = color;
        ctx.fillText(label, tx, ty);
        ctx.restore();
      },
    },
  };
}

/** Sparkline sense eixos ni interacció. */
export function sparkOptions(color: string, yRange: [number, number]): Omit<uPlot.Options, "width" | "height"> {
  return {
    series: [{}, lineSeries("", color, { width: 1.5, fill: alpha(color, 0.14) })],
    scales: { x: { time: false }, y: { range: yRange } },
    axes: [{ show: false }, { show: false }],
    legend: { show: false },
    cursor: { show: false },
    select: { show: false, left: 0, top: 0, width: 0, height: 0 },
    padding: [2, 0, 2, 0],
  };
}
