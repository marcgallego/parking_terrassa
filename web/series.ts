/*
 * Funcions pures per preparar les sèries temporals dels gràfics. No toquen el
 * DOM, i per això es poden provar amb Node (test/series.test.ts).
 */

/** Dades en el format alineat de uPlot: un eix x comú i una fila de valors per sèrie. */
export type Aligned = [number[], ...(number | null | undefined)[][]];

/** AAAA-MM-DD més `n` dies. */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

const partsFmts = new Map<string, Intl.DateTimeFormat>();
/** Diferència (ms) entre l'hora local de `tz` i UTC en un instant. */
function tzOffsetMs(t: number, tz: string): number {
  let fmt = partsFmts.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    partsFmts.set(tz, fmt);
  }
  const parts = fmt.formatToParts(new Date(t));
  const get = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - t;
}

/** Segons Unix de les 00:00 locals d'un dia AAAA-MM-DD a la zona `tz`, tenint en compte l'horari d'estiu. */
export function zonedMidnight(day: string, tz: string): number {
  const guess = Date.parse(`${day}T00:00:00Z`);
  let t = guess - tzOffsetMs(guess, tz);
  const off = tzOffsetMs(t, tz);
  if (guess - off !== t) t = guess - off;
  return t / 1000;
}

/**
 * Alinea diverses sèries sobre un eix x comú (segons Unix, ordenats).
 *
 * uPlot passa per sobre dels `undefined` i talla la línia als `null`. Així, si
 * a un pàrquing li falta una lectura aïllada la línia continua, però un forat
 * de més de `gapSec` sense lectures es veu com un tall, no com una recta.
 */
export function alignSeries(xs: readonly number[], values: readonly ((x: number) => number | undefined)[], gapSec: number): Aligned {
  const X: number[] = [];
  const Ys = values.map((): (number | null | undefined)[] => []);
  let prev: number | undefined;
  for (const x of xs) {
    // Forat de totes les sèries alhora: un punt null entremig.
    if (prev !== undefined && x - prev > gapSec) {
      X.push((prev + x) / 2);
      for (const y of Ys) y.push(null);
    }
    X.push(x);
    Ys.forEach((y, i) => y.push(values[i]?.(x)));
    prev = x;
  }
  // Forat d'una sola sèrie: el primer buit després de l'última lectura passa a null.
  for (const y of Ys) {
    let last = -1;
    y.forEach((v, i) => {
      if (v === undefined || v === null) return;
      const lastX = X[last], curX = X[i];
      if (last >= 0 && lastX !== undefined && curX !== undefined && curX - lastX > gapSec && y[last + 1] === undefined) y[last + 1] = null;
      last = i;
    });
  }
  return [X, ...Ys];
}
