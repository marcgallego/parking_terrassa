-- Registre dels canvis de la capacitat publicada per saba.es.
--
-- La capacitat no és una constant: pot canviar si el pàrquing reserva places a
-- abonats, en tanca una planta per obres o en reobre. Les lectures ja guarden la
-- capacitat llegida a cada minut, però la fitxa de `parkings` (que alimenta
-- /api/parkings i el denominador del panell del Portal de Sant Roc) quedava
-- congelada amb el valor de la migració inicial.
--
-- La clau primària és (pàrquing, esperada, observada) i s'hi escriu amb
-- INSERT OR IGNORE: cada transició distinta hi deixa una sola fila, amb el `ts`
-- de la primera vegada que es va veure, en lloc d'una fila per minut.
CREATE TABLE IF NOT EXISTS capacity_changes (
  parking_id INTEGER NOT NULL,
  expected   INTEGER NOT NULL,  -- capacitat que el Worker tenia per esperada
  observed   INTEGER NOT NULL,  -- capacitat que saba.es publicava
  ts         INTEGER NOT NULL,  -- segons Unix (UTC) de la primera captura que la va veure
  PRIMARY KEY (parking_id, expected, observed)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_capacity_changes_ts ON capacity_changes (ts);
