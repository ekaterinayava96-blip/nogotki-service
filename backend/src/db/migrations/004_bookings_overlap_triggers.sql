-- Миграция 004: триггеры против пересечения записей одного мастера
-- + замена жёсткого UNIQUE(master_id, starts_at) на частичный уникальный индекс.

-- ПЕРЕСОЗДАНИЕ TABLЕ bookings: runMigrations на время применения файла
-- отключает PRAGMA foreign_keys (см. runMigrations.js), поэтому DROP/ALTER
-- безопасны и не конфликтуют с внешними ключами (bookings <- payments).

-- Шаг 1. Новая таблица — без UNIQUE(master_id, starts_at): он блокировал бы
-- повторную запись на время, освободившееся после отмены, что противоречит
-- правилу «отменённые записи слот не блокируют».
CREATE TABLE bookings_new (
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
  CHECK (ends_at > starts_at)
);

-- Шаг 2. Переносим данные без потерь.
INSERT INTO bookings_new (id, client_id, service_id, master_id, starts_at, ends_at, status, comment, source, created_at, updated_at)
SELECT id, client_id, service_id, master_id, starts_at, ends_at, status, comment, source, created_at, updated_at FROM bookings;

-- Шаг 3. Замена таблицы.
DROP TABLE bookings;
ALTER TABLE bookings_new RENAME TO bookings;

-- Шаг 4. Частичный уникальный индекс: две активные (не отменённые) записи
-- одного мастера не могут начинаться в один момент. Отменённые строки индекс
-- не видит — их время свободно для повторной записи. Это «второй уровень»
-- защиты поверх триггеров (дубликат точного старта не проходит и на уровне
-- самого индекса).
CREATE UNIQUE INDEX idx_bookings_active_start ON bookings(master_id, starts_at) WHERE status != 'canceled';

-- Шаг 5. Восстанавливаем обычные индексы (удалены вместе со старой таблицей).
CREATE INDEX idx_bookings_client       ON bookings(client_id);
CREATE INDEX idx_bookings_master_start ON bookings(master_id, starts_at);
CREATE INDEX idx_bookings_status       ON bookings(status);

-- Шаг 6. Триггер на INSERT: новая запись (кроме отменённой) не должна
-- пересекаться ни с одной неотменённой записью этого мастера.
-- Условие пересечения: b.starts_at < NEW.ends_at AND b.ends_at > NEW.starts_at.
-- Вплотную (16:00-17:00 после 15:00-16:00) — не пересечение.
CREATE TRIGGER trg_bookings_no_overlap_insert
BEFORE INSERT ON bookings
FOR EACH ROW
WHEN NEW.status != 'canceled'
BEGIN
  SELECT RAISE(ABORT, 'BOOKING_TIME_CONFLICT')
  WHERE EXISTS (
    SELECT 1 FROM bookings b
    WHERE b.master_id = NEW.master_id
      AND b.status != 'canceled'
      AND b.starts_at < NEW.ends_at
      AND b.ends_at > NEW.starts_at
  );
END;

-- Шаг 7. Триггер на UPDATE: перенос времени или смена мастера/услуги также
-- проверяются. Сама изменяемая запись исключается из сравнения (b.id != NEW.id).
CREATE TRIGGER trg_bookings_no_overlap_update
BEFORE UPDATE ON bookings
FOR EACH ROW
WHEN NEW.status != 'canceled'
BEGIN
  SELECT RAISE(ABORT, 'BOOKING_TIME_CONFLICT')
  WHERE EXISTS (
    SELECT 1 FROM bookings b
    WHERE b.master_id = NEW.master_id
      AND b.status != 'canceled'
      AND b.id != NEW.id
      AND b.starts_at < NEW.ends_at
      AND b.ends_at > NEW.starts_at
  );
END;