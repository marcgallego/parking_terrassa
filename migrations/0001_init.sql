-- Fitxa dels pàrquings
CREATE TABLE IF NOT EXISTS parkings (
  id       INTEGER PRIMARY KEY,
  slug     TEXT NOT NULL UNIQUE,
  name     TEXT NOT NULL,
  url      TEXT NOT NULL,
  capacity INTEGER NOT NULL,
  lat      REAL NOT NULL,
  lon      REAL NOT NULL
);

INSERT OR REPLACE INTO parkings (id, slug, name, url, capacity, lat, lon) VALUES
  (54, 'placa-vella',       'Parking Saba Plaça Vella - Terrassa',       'https://www.saba.es/ca/parking-terrassa/parking-saba-placa-vella',       297, 41.561540689897136, 2.0101476003971945),
  (55, 'ajuntament-mercat', 'Parking Saba Ajuntament Mercat - Terrassa', 'https://www.saba.es/ca/parking-terrassa/parking-saba-ajuntament-mercat', 237, 41.56302979091195,  2.0085544635076107),
  (53, 'dr-robert',         'Parking Saba Dr. Robert - Terrassa',        'https://www.saba.es/ca/parking-terrassa/parking-saba-dr.-robert',        407, 41.56351518228081,  2.01758185765599);

-- Lectures minut a minut
CREATE TABLE IF NOT EXISTS readings (
  ts         INTEGER NOT NULL,   -- segons Unix (UTC), truncat al minut
  parking_id INTEGER NOT NULL,
  capacity   INTEGER NOT NULL,
  available  INTEGER NOT NULL,
  local_date TEXT    NOT NULL,   -- AAAA-MM-DD en hora local (Europe/Madrid)
  local_hour INTEGER NOT NULL,   -- 0-23 hora local
  local_dow  INTEGER NOT NULL,   -- 0 = dilluns ... 6 = diumenge
  PRIMARY KEY (ts, parking_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_readings_local_date ON readings (local_date, parking_id);

-- Agregat horari (per a gràfics de setmanes/mesos i el mapa de calor)
CREATE TABLE IF NOT EXISTS hourly (
  hour_ts       INTEGER NOT NULL,  -- inici de l'hora, segons Unix (UTC)
  parking_id    INTEGER NOT NULL,
  local_date    TEXT    NOT NULL,
  local_hour    INTEGER NOT NULL,
  local_dow     INTEGER NOT NULL,
  n             INTEGER NOT NULL,  -- nombre de lectures dins l'hora
  capacity      INTEGER NOT NULL,
  avg_available REAL    NOT NULL,
  min_available INTEGER NOT NULL,
  max_available INTEGER NOT NULL,
  PRIMARY KEY (hour_ts, parking_id)
) WITHOUT ROWID;

-- Errors de captura (per a diagnòstic)
CREATE TABLE IF NOT EXISTS scrape_errors (
  ts         INTEGER NOT NULL,
  parking_id INTEGER,
  message    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scrape_errors_ts ON scrape_errors (ts);
