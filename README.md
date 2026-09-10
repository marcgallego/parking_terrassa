# Ocupació dels pàrquings Saba de Terrassa

Dataset obert amb l'ocupació, minut a minut, dels tres pàrquings Saba de Terrassa, amb dashboard i API. Corre íntegrament a Cloudflare (Workers + D1), sense servidor propi.

| slug | Pàrquing | Places | id Saba |
|---|---|---|---|
| `placa-vella` | Parking Saba Plaça Vella | 297 | 54 |
| `ajuntament-mercat` | Parking Saba Ajuntament Mercat | 237 | 55 |
| `dr-robert` | Parking Saba Dr. Robert | 407 | 53 |

Font: fitxes públiques de [saba.es](https://www.saba.es/ca/parking-terrassa), que mostren places totals i disponibles.

## Arquitectura

```
Cron "* * * * *"  ─► Worker: descarrega les 3 fitxes, en parseja l'ocupació ─► D1 (taula readings)
Cron "7 * * * *"  ─► Worker: agrega les últimes hores ─► D1 (taula hourly)
HTTP /api/*, /data/*  ─► Worker: JSON i CSV des de D1 (cache a la vora per a dies tancats)
HTTP /               ─► Assets estàtics: dashboard (public/)
```

Tot el codi és TypeScript en mode estricte.

- `src/index.ts`: Worker (captura, agregat, API). Wrangler el compila directament.
- `web/app.ts`, `web/api.ts`: dashboard sense dependències (tiles d'estat, gràfic de línies, patró setmanal, descàrregues) i tipus de l'API. `esbuild` el compila a `public/app.js`.
- `public/`: HTML, CSS i `datapackage.json`, servits com a assets estàtics.
- `migrations/`: esquema D1.
- `local-scraper/`: versió Python autònoma per a qui vulgui capturar en una màquina pròpia.

## Per què: el Portal de Sant Roc

El projecte vol respondre si cal un pàrquing nou al Portal de Sant Roc. Els dos pàrquings a tocar són Ajuntament-Mercat i Plaça Vella (534 places entre tots dos); Dr. Robert és context. El panell «Portal de Sant Roc» del dashboard mostra, per a aquests dos, les places lliures sumades minut a minut, el mínim de cada dia i quants dies i minuts han baixat d'un llindar (10, 25 o 50 places). Si al pitjor moment de cada dia encara queden places, l'oferta actual absorbeix la demanda. Les dades públiques, però, cobreixen els tres pàrquings.

Cauteles: les «places disponibles» de Saba potser només compten les de rotació, i l'ocupació mesura oferta, no si el preu expulsa demanda. Els dies especials (Fira Modernista, Festa Major, Nadal) són els que cal mirar amb més atenció.

## Dades obertes

CSV amb capçalera, UTF-8, una fila per pàrquing i minut:

| columna | descripció |
|---|---|
| `timestamp_utc` | instant de la captura en UTC, truncat al minut |
| `timestamp_local` | el mateix instant en hora local (Europe/Madrid), ISO 8601 |
| `parking_id` | identificador del pàrquing a saba.es |
| `parking_slug` | `placa-vella`, `ajuntament-mercat`, `dr-robert` |
| `capacity` | places totals publicades |
| `available` | places lliures |
| `occupied` | `capacity - available` |
| `occupancy_pct` | `100 * occupied / capacity`, una decimal |

Endpoints (CORS obert):

| ruta | contingut |
|---|---|
| `/data/AAAA-MM-DD.csv` | un dia sencer |
| `/data/AAAA-MM.csv` | un mes sencer |
| `/api/day/AAAA-MM-DD` | un dia en JSON |
| `/api/latest` | última lectura de cada pàrquing i sèrie de les últimes 3 h |
| `/api/hourly?days=7` | agregat horari (mitjana, mínim, màxim), fins a 92 dies |
| `/api/heatmap?weeks=8` | ocupació mitjana per dia de la setmana i hora |
| `/api/santroc?days=30&threshold=25` | per dia: mínim de places lliures sumant Ajuntament-Mercat i Plaça Vella, hora del mínim i minuts sota el llindar |
| `/api/parkings` | fitxa dels pàrquings |
| `/api/days` | dies amb dades |
| `/api/status` | última lectura, nombre de files, errors recents |
| `/datapackage.json` | descripció del dataset (Frictionless Data Package) |

Si una captura falla per a un pàrquing, aquell minut no hi ha fila; l'error queda registrat i és visible a `/api/status`.

## Desplegament a Cloudflare

Requisits: Node 18+, compte de Cloudflare (el pla gratuït és suficient).

```bash
npm install
npx wrangler login                                  # obre el navegador
npx wrangler d1 create parking-terrassa             # copia el database_id a wrangler.jsonc
npm run db:migrate                                  # aplica migrations/ a la D1 remota
npm run deploy                                      # typecheck + build + publica Worker, assets i crons
```

Al cap d'un minut, `https://parking.<subdomini>.workers.dev/api/status` ha de mostrar la primera lectura. Per veure els logs en directe: `npm run tail`.

Consum aproximat en el pla gratuït: 1.440 invocacions de cron i 4.320 files escrites al dia (límits: 100.000 peticions i 100.000 files escrites). Cada visita al dashboard llegeix unes 10.000 files de D1 (límit 5 milions/dia); les respostes de dies tancats es guarden a la cache de Cloudflare.

## Desenvolupament local

```bash
npm run db:migrate:local
npm run dev                                          # compila web/ i arrenca http://localhost:8787
npm run typecheck                                    # comprova tipus de Worker i web
npm run build                                        # només compila web/app.ts -> public/app.js
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"   # dispara una captura
curl "http://localhost:8787/__scheduled?cron=7+*+*+*+*"   # dispara l'agregat horari
```

El dashboard admet `?range=today|7|30`, `?weeks=4|8|26`, `?srdays=30|90|365`, `?threshold=10|25|50` i `?theme=light|dark` a l'URL.

## Llicència

- Dades: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.ca). Font original: Saba Infraestructures, S.A. Projecte independent, sense relació amb Saba.
- Codi: MIT. Vegeu `LICENSE`.
