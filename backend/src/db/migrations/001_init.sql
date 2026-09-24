-- Миграция 001: начальная схема (соответствует docs/db-schema.md, сводный SQL)
-- SQLite не имеет полноценного ALTER для перестройки — изменения вносятся
-- новыми файлами миграций (002_, 003_, ...), которые выполняются после предыдущих.

CREATE TABLE services (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL,
  description      TEXT NOT NULL,
  price_kopecks    INTEGER NOT NULL CHECK (price_kopecks >= 0),
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
  photo_path       TEXT,
  is_active        INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL,
  updated_at       TEXT,
  UNIQUE (name)
);

CREATE TABLE masters (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL,
  role             TEXT NOT NULL,
  experience_years INTEGER NOT NULL DEFAULT 0,
  photo_path       TEXT,
  is_active        INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL,
  updated_at       TEXT
);

CREATE TABLE studio_info (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  studio_name TEXT NOT NULL,
  address     TEXT NOT NULL,
  phone       TEXT NOT NULL,
  telegram    TEXT UNIQUE,
  map_hint    TEXT,
  updated_at  TEXT
);

CREATE TABLE master_services (
  master_id  INTEGER NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  PRIMARY KEY (master_id, service_id)
);

CREATE TABLE master_schedule (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  master_id     INTEGER NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  weekday       INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_minutes INTEGER NOT NULL CHECK (start_minutes BETWEEN 0 AND 1439),
  end_minutes   INTEGER NOT NULL CHECK (end_minutes > start_minutes AND end_minutes <= 1440),
  UNIQUE (master_id, weekday)
);

CREATE TABLE work_blocks (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  master_id INTEGER NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  starts_at TEXT NOT NULL,
  ends_at   TEXT NOT NULL,
  reason    TEXT NOT NULL DEFAULT 'break'
    CHECK (reason IN ('break','day_off','vacation','sick','other')),
  CHECK (ends_at > starts_at)
);

CREATE TABLE studio_closures (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  starts_at  TEXT NOT NULL,
  ends_at    TEXT NOT NULL,
  reason     TEXT NOT NULL DEFAULT 'holiday'
    CHECK (reason IN ('holiday','sanitary','sick','other')),
  created_at TEXT NOT NULL,
  CHECK (ends_at > starts_at)
);

CREATE TABLE clients (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  phone       TEXT NOT NULL,
  telegram_id INTEGER UNIQUE,
  created_at  TEXT NOT NULL,
  UNIQUE (phone)
);

CREATE TABLE bookings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id     INTEGER NOT NULL REFERENCES clients(id),
  service_id    INTEGER NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  master_id     INTEGER NOT NULL REFERENCES masters(id) ON DELETE RESTRICT,
  starts_at     TEXT NOT NULL,
  ends_at       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'wait'
    CHECK (status IN ('wait','confirmed','done','canceled')),
  comment       TEXT,
  source        TEXT NOT NULL DEFAULT 'web' CHECK (source IN ('web','telegram')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT,
  CHECK (ends_at > starts_at),
  UNIQUE (master_id, starts_at)
);

CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  master_id     INTEGER UNIQUE REFERENCES masters(id),
  role          TEXT NOT NULL DEFAULT 'master' CHECK (role IN ('owner','master')),
  is_active     INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  UNIQUE (username)
);

CREATE TABLE payments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id     INTEGER NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
  amount_kopecks INTEGER NOT NULL CHECK (amount_kopecks >= 0),
  provider       TEXT NOT NULL DEFAULT 'yookassa' CHECK (provider IN ('yookassa','sbp','cash')),
  status         TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','paid','failed','refunded')),
  external_id    TEXT,
  paid_at        TEXT,
  created_at     TEXT NOT NULL
);

-- Индексы (соответствуют §6.2 db-schema.md)
CREATE INDEX idx_bookings_client        ON bookings(client_id);
CREATE INDEX idx_bookings_master_start  ON bookings(master_id, starts_at);
CREATE INDEX idx_blocks_master_start    ON work_blocks(master_id, starts_at, ends_at);
CREATE INDEX idx_bookings_status        ON bookings(status);
CREATE INDEX idx_services_active        ON services(is_active);
CREATE INDEX idx_payments_booking       ON payments(booking_id);
CREATE INDEX idx_master_services_master ON master_services(master_id);
CREATE INDEX idx_closures_start         ON studio_closures(starts_at, ends_at);