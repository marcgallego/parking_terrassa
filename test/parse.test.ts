/** Proves de `parseOccupancy`: el punt on el projecte depèn del format de saba.es. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseOccupancy } from "../src/index";

/** Fragment real d'una fitxa de saba.es (el mateix que fa servir local-scraper/tests). */
const SAMPLE = `
<div class="sb-parking-info">
  <!--<span>- 0.0 Km fins a la teva ubicació</span>-->
  <div class="available-places">Places: <strong>297</strong>    | Places disponibles: <strong>  230</strong></div>
</div>
`;

test("extreu capacitat i places disponibles", () => {
  assert.deepEqual(parseOccupancy(SAMPLE), { capacity: 297, available: 230 });
});

test("accepta un pàrquing ple (0 places lliures)", () => {
  assert.deepEqual(parseOccupancy(SAMPLE.replace("<strong>  230</strong>", "<strong>0</strong>")), {
    capacity: 297,
    available: 0,
  });
});

test("accepta un pàrquing buit (lliures == capacitat)", () => {
  assert.deepEqual(parseOccupancy(SAMPLE.replace("<strong>  230</strong>", "<strong>297</strong>")), {
    capacity: 297,
    available: 297,
  });
});

test("falla si no hi ha el bloc 'available-places'", () => {
  assert.throws(() => parseOccupancy("<html><body>res</body></html>"), /available-places/);
});

test("falla si el bloc hi és però amb un format inesperat", () => {
  const reskinned = '<div class="available-places">Places lliures: 230 de 297</div>';
  assert.throws(() => parseOccupancy(reskinned), /format inesperat/);
});

test("rebutja places disponibles per sobre de la capacitat", () => {
  assert.throws(() => parseOccupancy(SAMPLE.replace("  230", "999")), /> capacitat/);
});

test("rebutja una capacitat inversemblant", () => {
  assert.throws(() => parseOccupancy(SAMPLE.replace("<strong>297</strong>", "<strong>0</strong>")), /inversemblant/);
  assert.throws(() => parseOccupancy(SAMPLE.replace("<strong>297</strong>", "<strong>99999</strong>")), /inversemblant/);
});

test("no confon el bloc amb text que el precedeix a la pàgina", () => {
  const noise = `<p>Places: <strong>111</strong> | Places disponibles: <strong>11</strong></p>${SAMPLE}`;
  assert.deepEqual(parseOccupancy(noise), { capacity: 297, available: 230 });
});

test("només mira els 600 caràcters següents al bloc", () => {
  // Documenta la finestra de cerca: si saba.es allunyés les dues xifres, la
  // captura fallaria (i quedaria registrada) en lloc de llegir un altre bloc.
  const far = '<div class="available-places">Places: <strong>297</strong>' + " ".repeat(700) + "Places disponibles: <strong>230</strong></div>";
  assert.throws(() => parseOccupancy(far), /format inesperat/);
});
