-- Миграция 005: признак осознанного наложения записи (force_override).
--
-- Администратор (роль owner) может записать клиента поверх уже занятого
-- времени. Такая запись получает force_override = 1, и триггеры пересечения
-- пропускают её при создании. При этом сама такая запись дальше участвует
-- в проверке пересечений как обычная: подзапрос в триггере не исключает
-- строки с force_override = 1 — они так же блокируют других кандидатов.

-- Шаг 1. Новая колонка. Существующим строкам — 0 (обычная запись).
ALTER TABLE bookings
  ADD COLUMN force_override INTEGER NOT NULL DEFAULT 0
    CHECK (force_override IN (0, 1));

-- Шаг 2. Частичный уникальный индекс не должен мешать осознанному наложению:
-- запись с force_override = 1 может совпадать по времени начала с другой
-- активной записью того же мастера (иначе UNIQUE обрубал бы сценарий ещё до
-- триггера). Обычные записи (force_override = 0) по-прежнему уникальны
-- по точному времени начала.
DROP INDEX idx_bookings_active_start;
CREATE UNIQUE INDEX idx_bookings_active_start ON bookings(master_id, starts_at)
  WHERE status != 'canceled' AND force_override = 0;

-- Шаг 3. Триггер на INSERT: пропускаем проверку пересечения, только если
-- новая запись помечена как осознанное наложение.
DROP TRIGGER trg_bookings_no_overlap_insert;
CREATE TRIGGER trg_bookings_no_overlap_insert
BEFORE INSERT ON bookings
FOR EACH ROW
WHEN NEW.status != 'canceled' AND NEW.force_override = 0
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

-- Шаг 4. Триггер на UPDATE: то же правило. Пока признак выставлен,
-- обновление (перенос, смена времени) разрешено даже на пересечении.
-- Если признак снимают с записи, пересекающей другую, UPDATE откатится —
-- нельзя «легализовать» нарушение.
DROP TRIGGER trg_bookings_no_overlap_update;
CREATE TRIGGER trg_bookings_no_overlap_update
BEFORE UPDATE ON bookings
FOR EACH ROW
WHEN NEW.status != 'canceled' AND NEW.force_override = 0
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