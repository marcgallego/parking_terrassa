-- Agregat diari per al panell del Portal de Sant Roc (Plaça Vella + Ajuntament-Mercat).
-- Evita escanejar tots els minuts del període a cada petició.
CREATE TABLE IF NOT EXISTS daily_santroc (
  day      TEXT PRIMARY KEY,       -- AAAA-MM-DD en hora local
  minutes  INTEGER NOT NULL,       -- minuts amb lectura dels dos pàrquings
  min_free INTEGER NOT NULL,       -- mínim de places lliures sumades
  min_ts   INTEGER NOT NULL,       -- instant del mínim (segons Unix)
  below_10 INTEGER NOT NULL,       -- minuts amb menys de 10 places lliures
  below_25 INTEGER NOT NULL,
  below_50 INTEGER NOT NULL
) WITHOUT ROWID;
